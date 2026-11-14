import type { D1Like } from "./d1-repo";
import { costUsd, type TokenUsage } from "./pricing";

export const TRIAGE_DECISIONS = [
  "accepted",
  "rejected",
  "needs_admin",
  "admin_rejected",
] as const;
export type TriageDecision = (typeof TRIAGE_DECISIONS)[number];

export interface TriageRecord {
  repo: string;
  issueNumber: number;
  /** The issue author's numeric GitHub id. */
  authorId: string;
  decision: TriageDecision;
  category: string | null;
  reasonCode: string | null;
  model: string | null;
  bodySha256: string;
  runId: string | null;
  createdAt: number;
}

/** Stage 7. Triage records of guest requests (docs/guest-demo.md). */
export class D1TriageRepo {
  constructor(private readonly db: D1Like) {}

  /** Stores the triage of an issue. False when the issue was triaged before: nothing changes. */
  async record(input: TriageRecord): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT OR IGNORE INTO triage
           (repo, issue_number, author_id, decision, category, reason_code, model, body_sha256, run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.repo,
        input.issueNumber,
        input.authorId,
        input.decision,
        input.category,
        input.reasonCode,
        input.model,
        input.bodySha256,
        input.runId,
        input.createdAt,
      )
      .run();
    return result.meta.changes === 1;
  }

  /** True when the issue already has a triage record. */
  async exists(repo: string, issueNumber: number): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT 1 AS n FROM triage WHERE repo = ? AND issue_number = ?")
      .bind(repo, issueNumber)
      .first<{ n: number }>();
    return row !== null;
  }

  /** Stores the tokens of one triage model call. It counts toward the budgets like a run's call. */
  async recordUsage(input: {
    repo: string;
    issueNumber: number;
    model: string;
    usage: TokenUsage;
    ts: number;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO triage_usage
           (repo, issue_number, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.repo,
        input.issueNumber,
        input.model,
        input.usage.inputTokens,
        input.usage.outputTokens,
        input.usage.cacheReadTokens,
        input.usage.cacheWriteTokens,
        input.ts,
      )
      .run();
  }

  /**
   * The administrator closed an issue that waited for them: the record becomes
   * admin_rejected. False when the issue has no record in needs_admin.
   */
  async markAdminRejected(repo: string, issueNumber: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        "UPDATE triage SET decision = 'admin_rejected' WHERE repo = ? AND issue_number = ? AND decision = 'needs_admin'",
      )
      .bind(repo, issueNumber)
      .run();
    return result.meta.changes === 1;
  }

  /** Issues of one account triaged at or after `since`, in every repository. */
  async countByAuthorSince(authorId: string, since: number): Promise<number> {
    const row = await this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM triage WHERE author_id = ? AND created_at >= ?",
      )
      .bind(authorId, since)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /**
   * The estimated model spend of one repository in the UTC day that holds `now`: the calls of
   * its runs and its triage calls.
   * Null when a model has no price: then the spend is unknown and the daily limit must hold.
   */
  async dailySpendUsd(repo: string, now: number): Promise<number | null> {
    const d = new Date(now);
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const end = start + 24 * 60 * 60 * 1000;
    const { results } = await this.db
      .prepare(
        `SELECT model,
                SUM(input_tokens) AS input, SUM(output_tokens) AS output,
                SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write
         FROM (
           SELECT u.model, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens
           FROM run_usage u JOIN runs r ON r.id = u.run_id
           WHERE r.repo = ? AND u.ts >= ? AND u.ts < ?
           UNION ALL
           SELECT model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
           FROM triage_usage
           WHERE repo = ? AND ts >= ? AND ts < ?
         )
         GROUP BY model`,
      )
      .bind(repo, start, end, repo, start, end)
      .all<{
        model: string;
        input: number;
        output: number;
        cache_read: number;
        cache_write: number;
      }>();
    let total = 0;
    for (const row of results) {
      const cost = costUsd(row.model, {
        inputTokens: row.input,
        outputTokens: row.output,
        cacheReadTokens: row.cache_read,
        cacheWriteTokens: row.cache_write,
      });
      if (cost === null) return null;
      total += cost;
    }
    return total;
  }
}
