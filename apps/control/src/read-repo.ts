import type { D1Like } from "./d1-repo";
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
  createdAt: number;
  updatedAt: number;
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
  "id, repo, issue_number, state, reason_code, pr_number, created_at, updated_at";

type Row = Record<string, unknown>;

/** A stored code that is not a known fixed code is shown as no code. */
const code = (value: unknown): ReasonCode | null =>
  typeof value === "string" &&
  (REASON_CODES as readonly string[]).includes(value)
    ? (value as ReasonCode)
    : null;

function runView(row: Row): RunView {
  return {
    id: String(row["id"]),
    repo: String(row["repo"]),
    issueNumber: Number(row["issue_number"]),
    state: row["state"] as RunState,
    reasonCode: code(row["reason_code"]),
    prNumber: row["pr_number"] === null ? null : Number(row["pr_number"]),
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
    return results.map(runView);
  }

  async getRun(id: string): Promise<RunView | null> {
    const row = await this.db
      .prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`)
      .bind(id)
      .first<Row>();
    return row === null ? null : runView(row);
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
