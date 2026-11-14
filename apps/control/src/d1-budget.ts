import type { D1Like } from "./d1-repo";
import type { BudgetLimits } from "./budget";
import type { TokenUsage } from "./pricing";
import type { RunState } from "./run-types";

export interface ModelUsage {
  model: string;
  usage: TokenUsage;
}

export interface PhaseUsage extends ModelUsage {
  phase: string;
}

export interface ActiveRunBudget {
  id: string;
  state: RunState;
  implementModel: string | null;
  reviewModel: string | null;
  usage: PhaseUsage[];
}

const SUMS =
  "SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write";

interface SumRow {
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

const toModelUsage = (r: SumRow): ModelUsage => ({
  model: r.model,
  usage: {
    inputTokens: Number(r.input),
    outputTokens: Number(r.output),
    cacheReadTokens: Number(r.cache_read),
    cacheWriteTokens: Number(r.cache_write),
  },
});

const TERMINAL_SQL = "('merged', 'needs_human', 'failed')";

/** Reads for the stage 5 budget: recorded model usage and the active runs that reserve budget. */
export interface StoredLimits extends BudgetLimits {
  ts: number;
  actorId: string;
}

export class D1BudgetRepo {
  constructor(private readonly db: D1Like) {}

  /** The limits in force, or null when no operator has set any. */
  async latestLimits(): Promise<StoredLimits | null> {
    const row = await this.db
      .prepare(
        "SELECT ts, actor_id, anthropic_usd, openai_usd, run_cap_usd FROM budget_limits ORDER BY id DESC LIMIT 1",
      )
      .first<{
        ts: number;
        actor_id: string;
        anthropic_usd: number;
        openai_usd: number;
        run_cap_usd: number;
      }>();
    if (row === null) return null;
    return {
      ts: row.ts,
      actorId: row.actor_id,
      anthropicUsd: row.anthropic_usd,
      openaiUsd: row.openai_usd,
      runCapUsd: row.run_cap_usd,
    };
  }

  async recordLimits(input: StoredLimits): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO budget_limits (ts, actor_id, anthropic_usd, openai_usd, run_cap_usd) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        input.ts,
        input.actorId,
        input.anthropicUsd,
        input.openaiUsd,
        input.runCapUsd,
      )
      .run();
  }

  /** Usage per model with `start <= ts < end`: the runs' calls and the guest triage calls. */
  async periodUsage(start: number, end: number): Promise<ModelUsage[]> {
    const { results } = await this.db
      .prepare(
        `SELECT model, ${SUMS} FROM (
           SELECT model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
           FROM run_usage WHERE ts >= ? AND ts < ?
           UNION ALL
           SELECT model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
           FROM triage_usage WHERE ts >= ? AND ts < ?
         ) GROUP BY model ORDER BY model`,
      )
      .bind(start, end, start, end)
      .all<SumRow>();
    return results.map(toModelUsage);
  }

  /** A run's usage per model, of one phase when `phase` is given. */
  async runUsage(runId: string, phase?: string): Promise<ModelUsage[]> {
    const { results } = await (
      phase === undefined
        ? this.db
            .prepare(
              `SELECT model, ${SUMS} FROM run_usage WHERE run_id = ? GROUP BY model ORDER BY model`,
            )
            .bind(runId)
        : this.db
            .prepare(
              `SELECT model, ${SUMS} FROM run_usage WHERE run_id = ? AND phase = ? GROUP BY model ORDER BY model`,
            )
            .bind(runId, phase)
    ).all<SumRow>();
    return results.map(toModelUsage);
  }

  /**
   * Takes one in-flight slot of the run, atomically, when fewer than `max` are taken.
   * Slots older than `staleMs` do not count. Returns the slot id, or null when all are taken.
   */
  async acquireInflight(
    runId: string,
    now: number,
    max: number,
    staleMs: number,
  ): Promise<number | null> {
    const row = await this.db
      .prepare(
        `INSERT INTO run_inflight (run_id, started_at)
         SELECT ?, ? WHERE (SELECT COUNT(*) FROM run_inflight WHERE run_id = ? AND started_at > ?) < ?
         RETURNING id`,
      )
      .bind(runId, now, runId, now - staleMs, max)
      .first<{ id: number }>();
    return row === null ? null : Number(row.id);
  }

  async releaseInflight(id: number): Promise<void> {
    await this.db
      .prepare("DELETE FROM run_inflight WHERE id = ?")
      .bind(id)
      .run();
  }

  /** Every active run, its models and its usage per model. At most a few rows. */
  async activeRuns(): Promise<ActiveRunBudget[]> {
    const [runs, usage] = await Promise.all([
      this.db
        .prepare(
          `SELECT id, state, implement_model, review_model FROM runs WHERE state NOT IN ${TERMINAL_SQL} ORDER BY id`,
        )
        .all<{
          id: string;
          state: RunState;
          implement_model: string | null;
          review_model: string | null;
        }>(),
      this.db
        .prepare(
          `SELECT u.run_id AS run_id, u.phase AS phase, u.model AS model, ${SUMS.replace(/(\w+_tokens)/g, "u.$1")}
           FROM run_usage u JOIN runs r ON r.id = u.run_id
           WHERE r.state NOT IN ${TERMINAL_SQL} GROUP BY u.run_id, u.phase, u.model ORDER BY u.phase, u.model`,
        )
        .all<SumRow & { run_id: string; phase: string }>(),
    ]);
    return runs.results.map((r) => ({
      id: r.id,
      state: r.state,
      implementModel: r.implement_model,
      reviewModel: r.review_model,
      usage: usage.results
        .filter((u) => u.run_id === r.id)
        .map((u) => ({ phase: u.phase, ...toModelUsage(u) })),
    }));
  }

  /** True only for the first claim of a billing period. */
  async claimAlert(period: string, ts: number): Promise<boolean> {
    const r = await this.db
      .prepare(
        "INSERT OR IGNORE INTO budget_alerts (period, created_at) VALUES (?, ?)",
      )
      .bind(period, ts)
      .run();
    return r.meta.changes === 1;
  }

  async recordAlertIssue(period: string, issueNumber: number): Promise<void> {
    await this.db
      .prepare("UPDATE budget_alerts SET issue_number = ? WHERE period = ?")
      .bind(issueNumber, period)
      .run();
  }

  /** Gives the claim back, so a later check tries to register the issue again. */
  async releaseAlert(period: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM budget_alerts WHERE period = ?")
      .bind(period)
      .run();
  }
}
