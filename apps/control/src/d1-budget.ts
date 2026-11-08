import type { D1Like } from "./d1-repo";
import type { TokenUsage } from "./pricing";
import type { RunState } from "./run-types";

export interface ModelUsage {
  model: string;
  usage: TokenUsage;
}

export interface ActiveRunBudget {
  id: string;
  state: RunState;
  implementModel: string | null;
  reviewModel: string | null;
  usage: ModelUsage[];
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
export class D1BudgetRepo {
  constructor(private readonly db: D1Like) {}

  /** Usage per model with `start <= ts < end`. */
  async periodUsage(start: number, end: number): Promise<ModelUsage[]> {
    const { results } = await this.db
      .prepare(
        `SELECT model, ${SUMS} FROM run_usage WHERE ts >= ? AND ts < ? GROUP BY model ORDER BY model`,
      )
      .bind(start, end)
      .all<SumRow>();
    return results.map(toModelUsage);
  }

  async runUsage(runId: string): Promise<ModelUsage[]> {
    const { results } = await this.db
      .prepare(
        `SELECT model, ${SUMS} FROM run_usage WHERE run_id = ? GROUP BY model ORDER BY model`,
      )
      .bind(runId)
      .all<SumRow>();
    return results.map(toModelUsage);
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
          `SELECT u.run_id AS run_id, u.model AS model, ${SUMS.replace(/(\w+_tokens)/g, "u.$1")}
           FROM run_usage u JOIN runs r ON r.id = u.run_id
           WHERE r.state NOT IN ${TERMINAL_SQL} GROUP BY u.run_id, u.model ORDER BY u.model`,
        )
        .all<SumRow & { run_id: string }>(),
    ]);
    return runs.results.map((r) => ({
      id: r.id,
      state: r.state,
      implementModel: r.implement_model,
      reviewModel: r.review_model,
      usage: usage.results.filter((u) => u.run_id === r.id).map(toModelUsage),
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
