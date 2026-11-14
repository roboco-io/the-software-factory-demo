import type { D1Like } from "./d1-repo";
import { costUsd } from "./pricing";

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
   * The estimated model spend of one repository's runs in the UTC day that holds `now`.
   * Null when a model has no price: then the spend is unknown and the daily limit must hold.
   */
  async dailySpendUsd(repo: string, now: number): Promise<number | null> {
    const d = new Date(now);
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const { results } = await this.db
      .prepare(
        `SELECT u.model AS model,
                SUM(u.input_tokens) AS input, SUM(u.output_tokens) AS output,
                SUM(u.cache_read_tokens) AS cache_read, SUM(u.cache_write_tokens) AS cache_write
         FROM run_usage u JOIN runs r ON r.id = u.run_id
         WHERE r.repo = ? AND u.ts >= ? AND u.ts < ?
         GROUP BY u.model`,
      )
      .bind(repo, start, start + 24 * 60 * 60 * 1000)
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
