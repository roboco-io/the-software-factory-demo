import type { D1Like } from "./d1-repo";
import { errorKind, logDiagnostic } from "./diagnostics";
import { json, type RouteContext } from "./http";

export interface SwitchState {
  ts: number;
  actorId: string;
  enabled: boolean;
}

/** Stage 7. The factory-wide stop an operator sets without a deploy. */
export class D1SwitchRepo {
  constructor(private readonly db: D1Like) {}

  /** The latest change, or null when no operator has used the switch. */
  async latest(): Promise<SwitchState | null> {
    const row = await this.db
      .prepare(
        "SELECT ts, actor_id, enabled FROM factory_switch ORDER BY id DESC LIMIT 1",
      )
      .first<{ ts: number; actor_id: string; enabled: number }>();
    return row === null
      ? null
      : { ts: row.ts, actorId: row.actor_id, enabled: row.enabled === 1 };
  }

  async record(input: SwitchState): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO factory_switch (ts, actor_id, enabled) VALUES (?, ?, ?)",
      )
      .bind(input.ts, input.actorId, input.enabled ? 1 : 0)
      .run();
  }

  /** True while the latest change is a stop. */
  async paused(): Promise<boolean> {
    return (await this.latest())?.enabled === false;
  }

  /** Runs that are not in a final state: the ones a factory-wide stop must reach. */
  async activeRuns(): Promise<
    { id: string; repo: string; issueNumber: number }[]
  > {
    const { results } = await this.db
      .prepare(
        "SELECT id, repo, issue_number FROM runs WHERE state NOT IN ('merged', 'needs_human', 'failed') ORDER BY id",
      )
      .all<{ id: string; repo: string; issue_number: number }>();
    return results.map((r) => ({
      id: r.id,
      repo: r.repo,
      issueNumber: r.issue_number,
    }));
  }
}

const unavailable = () => json({ error: "unavailable" }, 503);
const badRequest = () => json({ error: "bad_request" }, 400);

/**
 * GET /api/factory. Public: whether the factory accepts new runs. `enabled` is false when
 * RUNS_ENABLED is off or an operator stopped the factory. Who stopped it is not shown.
 */
export async function handleFactory(ctx: RouteContext): Promise<Response> {
  if (ctx.env.DB === undefined) return unavailable();
  const latest = await new D1SwitchRepo(ctx.env.DB).latest();
  const stopped = latest?.enabled === false;
  return json({
    enabled: ctx.env.RUNS_ENABLED === "true" && !stopped,
    stoppedAt: stopped ? latest.ts : null,
  });
}

const MAX_BODY = 256;

/**
 * POST /api/factory/switch with `{"enabled": false}` or `{"enabled": true}`. The dispatcher
 * has already required an operator and a same-origin request.
 *
 * A stop is stored first, so no new run starts from then on. After that every active run
 * gets the same stop request an operator can send for one run; each run applies it at its
 * next alarm tick, and a merge already sent to GitHub is not taken back. A run that cannot
 * be reached is counted and logged: the stop itself still holds.
 */
export async function handleFactorySwitch(
  ctx: RouteContext,
): Promise<Response> {
  if (ctx.env.DB === undefined) return unavailable();
  const type = ctx.request.headers.get("content-type") ?? "";
  if (type.split(";")[0]!.trim().toLowerCase() !== "application/json")
    return badRequest();
  let body: unknown;
  try {
    const text = await ctx.request.text();
    if (text.length > MAX_BODY) return badRequest();
    body = JSON.parse(text);
  } catch {
    return badRequest();
  }
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return badRequest();
  const keys = Object.keys(body);
  const enabled = (body as { enabled?: unknown }).enabled;
  if (keys.length !== 1 || typeof enabled !== "boolean") return badRequest();

  const repo = new D1SwitchRepo(ctx.env.DB);
  const operatorId = ctx.session?.id ?? "";
  await repo.record({ ts: Date.now(), actorId: operatorId, enabled });
  let stopRequested = 0;
  let stopFailed = 0;
  if (!enabled && ctx.env.ISSUE_RUN !== undefined) {
    for (const run of await repo.activeRuns()) {
      try {
        // The Durable Object is named by repository and issue, as when the run was started.
        const result = await ctx.env.ISSUE_RUN.getByName(
          `${run.repo}#${run.issueNumber}`,
        ).stop(run.id);
        if (result === "stop_requested") stopRequested += 1;
      } catch (error) {
        stopFailed += 1;
        logDiagnostic("stop_failed", {
          runId: run.id,
          error: errorKind(error),
        });
      }
    }
  }
  logDiagnostic("factory_switch_changed", {
    operatorId,
    enabled: enabled ? "true" : "false",
    stopRequested,
    stopFailed,
  });
  return json({ enabled, stopRequested, stopFailed });
}
