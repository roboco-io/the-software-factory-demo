import type { D1Like } from "./d1-repo";
import { costUsd } from "./pricing";
import {
  REASON_CODES,
  type EventKind,
  type ReasonCode,
  type RunState,
} from "./run-types";

/** A run as the API shows it. Every field is named here; nothing else leaves the database. */
export interface RunView {
  id: string;
  repo: string;
  issueNumber: number;
  state: RunState;
  reasonCode: ReasonCode | null;
  prNumber: number | null;
  /** The issue title: data, never markup. */
  title: string | null;
  tier: string | null;
  headSha: string | null;
  cost: RunCost;
  createdAt: number;
  updatedAt: number;
}

/**
 * not_measured: no usage rows. unknown: some row's model has no price, so no sum is shown.
 * measured: every row is priced. A "review" phase counts as review; every other phase as implement.
 */
export interface RunCost {
  status: "measured" | "not_measured" | "unknown";
  totalUsd: number | null;
  implementUsd: number | null;
  reviewUsd: number | null;
}

export interface ProjectStats {
  attention: number;
  costUsd: number | null;
}

export interface EventView {
  id: number;
  ts: number;
  kind: EventKind;
  fromState: RunState | null;
  toState: RunState | null;
  reasonCode: ReasonCode | null;
}

export interface OutcomeCounts {
  active: number;
  merged: number;
  needs_human: number;
  failed: number;
}

const RUN_COLUMNS =
  "id, repo, issue_number, state, reason_code, pr_number, title, tier, head_sha, created_at, updated_at";

/** A needs_human or failed run needs a person for this long after its last change. */
export const ATTENTION_WINDOW_MS = 7 * 86_400_000;

const NOT_MEASURED: RunCost = {
  status: "not_measured",
  totalUsd: null,
  implementUsd: null,
  reviewUsd: null,
};
const UNKNOWN: RunCost = { ...NOT_MEASURED, status: "unknown" };

const USAGE_SUMS =
  "SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(cache_read_tokens) AS cr, SUM(cache_write_tokens) AS cw";

const tokens = (row: Row) => ({
  inputTokens: Number(row["i"]),
  outputTokens: Number(row["o"]),
  cacheReadTokens: Number(row["cr"]),
  cacheWriteTokens: Number(row["cw"]),
});

function costOf(rows: Row[]): RunCost {
  if (rows.length === 0) return NOT_MEASURED;
  let implementUsd = 0;
  let reviewUsd = 0;
  for (const row of rows) {
    const usd = costUsd(String(row["model"]), tokens(row));
    if (usd === null) return UNKNOWN;
    if (row["phase"] === "review") reviewUsd += usd;
    else implementUsd += usd;
  }
  return {
    status: "measured",
    totalUsd: implementUsd + reviewUsd,
    implementUsd,
    reviewUsd,
  };
}

type Row = Record<string, unknown>;

/** A stored code that is not a known fixed code is shown as no code. */
const code = (value: unknown): ReasonCode | null =>
  typeof value === "string" &&
  (REASON_CODES as readonly string[]).includes(value)
    ? (value as ReasonCode)
    : null;

function runView(row: Row, cost: RunCost): RunView {
  return {
    id: String(row["id"]),
    repo: String(row["repo"]),
    issueNumber: Number(row["issue_number"]),
    state: row["state"] as RunState,
    reasonCode: code(row["reason_code"]),
    prNumber: row["pr_number"] === null ? null : Number(row["pr_number"]),
    title: row["title"] == null ? null : String(row["title"]),
    tier: row["tier"] == null ? null : String(row["tier"]),
    headSha: row["head_sha"] == null ? null : String(row["head_sha"]),
    cost,
    createdAt: Number(row["created_at"]),
    updatedAt: Number(row["updated_at"]),
  };
}

function eventView(row: Row): EventView {
  return {
    id: Number(row["id"]),
    ts: Number(row["ts"]),
    kind: row["kind"] as EventKind,
    fromState: (row["from_state"] ?? null) as RunState | null,
    toState: (row["to_state"] ?? null) as RunState | null,
    reasonCode: code(row["reason_code"]),
  };
}

export interface RunCursor {
  createdAt: number;
  id: string;
}

/** Read-only queries for the portal API. */
export class D1ReadRepo {
  constructor(private readonly db: D1Like) {}

  /** Run counts per repository: active (not yet finished), merged, needs_human, failed. */
  async countsByRepo(): Promise<Map<string, OutcomeCounts>> {
    const { results } = await this.db
      .prepare(
        "SELECT repo, state, COUNT(*) AS n FROM runs GROUP BY repo, state",
      )
      .all<Row>();
    const out = new Map<string, OutcomeCounts>();
    for (const row of results) {
      const repo = String(row["repo"]);
      const counts = out.get(repo) ?? {
        active: 0,
        merged: 0,
        needs_human: 0,
        failed: 0,
      };
      const state = row["state"];
      const key =
        state === "merged" || state === "needs_human" || state === "failed"
          ? state
          : "active";
      counts[key] += Number(row["n"]);
      out.set(repo, counts);
    }
    return out;
  }

  /** Newest first by (created_at, id). Returns one row more than `limit` so the caller can tell if a page follows. */
  async listRuns(
    repo: string,
    limit: number,
    after: RunCursor | null,
  ): Promise<RunView[]> {
    const { results } =
      after === null
        ? await this.db
            .prepare(
              `SELECT ${RUN_COLUMNS} FROM runs WHERE repo = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
            )
            .bind(repo, limit + 1)
            .all<Row>()
        : await this.db
            .prepare(
              `SELECT ${RUN_COLUMNS} FROM runs WHERE repo = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`,
            )
            .bind(repo, after.createdAt, after.createdAt, after.id, limit + 1)
            .all<Row>();
    return this.withCost(results);
  }

  async getRun(id: string): Promise<RunView | null> {
    const row = await this.db
      .prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`)
      .bind(id)
      .first<Row>();
    return row === null ? null : (await this.withCost([row]))[0]!;
  }

  /** One usage query for the whole page. A page has at most 51 runs, under D1's 100 bound parameters. */
  private async withCost(rows: Row[]): Promise<RunView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => String(r["id"]));
    const { results } = await this.db
      .prepare(
        `SELECT run_id, phase, model, ${USAGE_SUMS} FROM run_usage WHERE run_id IN (${ids.map(() => "?").join(",")}) GROUP BY run_id, phase, model`,
      )
      .bind(...ids)
      .all<Row>();
    const byRun = new Map<string, Row[]>();
    for (const u of results) {
      const key = String(u["run_id"]);
      byRun.set(key, [...(byRun.get(key) ?? []), u]);
    }
    return rows.map((r) =>
      runView(r, costOf(byRun.get(String(r["id"])) ?? [])),
    );
  }

  /** Per repository: runs that need a person, and the summed cost (null if any model is unpriced). */
  async statsByRepo(now: number): Promise<Map<string, ProjectStats>> {
    const out = new Map<string, ProjectStats>();
    const stat = (repo: string) => {
      const s = out.get(repo) ?? { attention: 0, costUsd: 0 };
      out.set(repo, s);
      return s;
    };
    const attention = await this.db
      .prepare(
        "SELECT repo, COUNT(*) AS n FROM runs WHERE state = 'awaiting_approval' OR (state IN ('needs_human', 'failed') AND updated_at >= ?) GROUP BY repo",
      )
      .bind(now - ATTENTION_WINDOW_MS)
      .all<Row>();
    for (const row of attention.results)
      stat(String(row["repo"])).attention = Number(row["n"]);
    const spent = await this.db
      .prepare(
        `SELECT r.repo AS repo, u.model AS model, ${USAGE_SUMS.replace(/(\w+_tokens)/g, "u.$1")} FROM run_usage u JOIN runs r ON r.id = u.run_id GROUP BY r.repo, u.model`,
      )
      .all<Row>();
    for (const row of spent.results) {
      const s = stat(String(row["repo"]));
      const usd = costUsd(String(row["model"]), tokens(row));
      s.costUsd = s.costUsd === null || usd === null ? null : s.costUsd + usd;
    }
    return out;
  }

  async listEvents(runId: string): Promise<EventView[]> {
    const { results } = await this.db
      .prepare(
        "SELECT id, ts, kind, from_state, to_state, reason_code FROM events WHERE run_id = ? ORDER BY id",
      )
      .bind(runId)
      .all<Row>();
    return results.map(eventView);
  }
}
