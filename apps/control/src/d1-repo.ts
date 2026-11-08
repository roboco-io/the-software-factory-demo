import type { EventKind, ReasonCode, RunState } from "./run-types";

interface Statement {
  bind(...values: unknown[]): Statement;
  run(): Promise<{ meta: { changes: number } }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}
export interface D1Like {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<{ meta: { changes: number } }[]>;
}

/** An active (non-terminal) run already exists for this issue. */
export class ActiveRunConflict extends Error {
  constructor() {
    super("active run exists");
    this.name = "ActiveRunConflict";
  }
}

export interface RunRepo {
  /** Inserts the run only if fewer than `maxActive` runs are active, atomically. */
  createRun(
    run: {
      id: string;
      repo: string;
      issueNumber: number;
      ts: number;
      title?: string;
      /** The model that implements this run. It decides which account the run reserves. */
      implementModel?: string;
    },
    maxActive: number,
  ): Promise<"created" | "capacity_full">;
  findActiveRun(
    repo: string,
    issueNumber: number,
  ): Promise<{ id: string; createdAt: number; state: RunState } | null>;
  transition(t: {
    runId: string;
    from: RunState;
    to: RunState;
    code: ReasonCode | null;
    ts: number;
    prNumber?: number;
  }): Promise<void>;
  recordCleanup(e: {
    runId: string;
    ts: number;
    code: ReasonCode | null;
  }): Promise<void>;
  /** Sets the given fields. Leaves unset fields. Adds no event. */
  recordFacts(f: {
    runId: string;
    tier?: string;
    headSha?: string;
    reviewModel?: string;
    /** The reviewer is another model of the implementer's engine (stage 5). */
    singleEngine?: boolean;
  }): Promise<void>;
}

/** States in which a run is finished. A run in any other state is active. */
const TERMINAL_SQL = "('merged', 'needs_human', 'failed')";
/**
 * Active runs that count against capacity: they hold a sandbox or are about to.
 * A run in awaiting_approval waits for a person for up to days and holds no slot; a run in
 * awaiting_engine waits for budget, for up to a billing period, and holds none either.
 */
const CAPACITY_SQL =
  "('queued', 'cloning', 'implementing', 'publishing', 'pr_opened', 'reviewing', 'awaiting_checks')";

const INSERT_EVENT =
  "INSERT INTO events (run_id, ts, kind, from_state, to_state, reason_code) VALUES (?, ?, ?, ?, ?, ?)";

export class D1RunRepo implements RunRepo {
  constructor(private readonly db: D1Like) {}

  private event(
    runId: string,
    ts: number,
    kind: EventKind,
    from: RunState | null,
    to: RunState | null,
    code: ReasonCode | null,
  ) {
    return this.db.prepare(INSERT_EVENT).bind(runId, ts, kind, from, to, code);
  }

  async createRun(
    run: {
      id: string;
      repo: string;
      issueNumber: number;
      ts: number;
      title?: string;
      implementModel?: string;
    },
    maxActive: number,
  ): Promise<"created" | "capacity_full"> {
    let results;
    try {
      results = await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO runs (id, repo, issue_number, state, created_at, updated_at, title, implement_model)
             SELECT ?, ?, ?, 'queued', ?, ?, ?, ?
             WHERE (SELECT COUNT(*) FROM runs WHERE state IN ${CAPACITY_SQL}) < ?`,
          )
          .bind(
            run.id,
            run.repo,
            run.issueNumber,
            run.ts,
            run.ts,
            run.title ?? null,
            run.implementModel ?? null,
            maxActive,
          ),
        this.db
          .prepare(
            `INSERT INTO events (run_id, ts, kind, from_state, to_state, reason_code)
             SELECT ?, ?, 'created', NULL, 'queued', NULL
             WHERE EXISTS (SELECT 1 FROM runs WHERE id = ?)`,
          )
          .bind(run.id, run.ts, run.id),
      ]);
    } catch (error) {
      if (error instanceof Error && /UNIQUE/i.test(error.message)) {
        throw new ActiveRunConflict();
      }
      throw error;
    }
    return results[0]?.meta.changes === 1 ? "created" : "capacity_full";
  }

  async findActiveRun(repo: string, issueNumber: number) {
    const row = await this.db
      .prepare(
        `SELECT id, created_at, state FROM runs WHERE repo = ? AND issue_number = ? AND state NOT IN ${TERMINAL_SQL}`,
      )
      .bind(repo, issueNumber)
      .first<{ id: string; created_at: number; state: RunState }>();
    return row === null
      ? null
      : { id: row.id, createdAt: row.created_at, state: row.state };
  }

  async transition(t: {
    runId: string;
    from: RunState;
    to: RunState;
    code: ReasonCode | null;
    ts: number;
    prNumber?: number;
  }): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          "UPDATE runs SET state = ?, reason_code = ?, pr_number = COALESCE(?, pr_number), updated_at = ? WHERE id = ?",
        )
        .bind(t.to, t.code, t.prNumber ?? null, t.ts, t.runId),
      this.event(t.runId, t.ts, "transition", t.from, t.to, t.code),
    ]);
  }

  async recordCleanup(e: {
    runId: string;
    ts: number;
    code: ReasonCode | null;
  }): Promise<void> {
    await this.event(e.runId, e.ts, "cleanup", null, null, e.code).run();
  }

  async recordFacts(f: {
    runId: string;
    tier?: string;
    headSha?: string;
    reviewModel?: string;
    singleEngine?: boolean;
  }): Promise<void> {
    await this.db
      .prepare(
        "UPDATE runs SET tier = COALESCE(?, tier), head_sha = COALESCE(?, head_sha), review_model = COALESCE(?, review_model), single_engine = COALESCE(?, single_engine) WHERE id = ?",
      )
      .bind(
        f.tier ?? null,
        f.headSha ?? null,
        f.reviewModel ?? null,
        f.singleEngine === undefined ? null : f.singleEngine ? 1 : 0,
        f.runId,
      )
      .run();
  }

  async recordUsage(u: {
    runId: string;
    phase: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    ts: number;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO run_usage (run_id, phase, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        u.runId,
        u.phase,
        u.model,
        u.inputTokens,
        u.outputTokens,
        u.cacheReadTokens,
        u.cacheWriteTokens,
        u.ts,
      )
      .run();
  }

  async claimDelivery(deliveryId: string, ts: number): Promise<boolean> {
    const r = await this.db
      .prepare(
        "INSERT OR IGNORE INTO deliveries (delivery_id, received_at) VALUES (?, ?)",
      )
      .bind(deliveryId, ts)
      .run();
    return r.meta.changes === 1;
  }

  async releaseDelivery(deliveryId: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM deliveries WHERE delivery_id = ?")
      .bind(deliveryId)
      .run();
  }
}
