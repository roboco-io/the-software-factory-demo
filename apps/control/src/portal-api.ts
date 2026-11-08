import { PROVIDERS, budgetConfig, budgetMode } from "./budget";
import { BudgetService } from "./budget-service";
import { parseList } from "./config";
import { D1BudgetRepo } from "./d1-budget";
import { D1ReadRepo, type RunCursor } from "./read-repo";
import { errorKind, logDiagnostic } from "./diagnostics";
import { json, type RouteContext } from "./http";
import type { StopResult } from "./run-machine";

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const CURSOR = /^([0-9]{1,16})_([A-Za-z0-9_-]{1,64})$/;

const badRequest = () => json({ error: "bad_request" }, 400);
const notFound = () => json({ error: "not_found" }, 404);

const projectsOf = (ctx: RouteContext) => parseList(ctx.env.PROJECTS);

function repoOf(ctx: RouteContext): D1ReadRepo | null {
  return ctx.env.DB === undefined ? null : new D1ReadRepo(ctx.env.DB);
}
const unavailable = () => json({ error: "unavailable" }, 503);

export function handleMe(ctx: RouteContext): Response {
  return json(
    ctx.session === null
      ? { role: ctx.role }
      : { role: ctx.role, login: ctx.session.login },
  );
}

export async function handleProjects(ctx: RouteContext): Promise<Response> {
  const repo = repoOf(ctx);
  if (repo === null) return unavailable();
  const counts = await repo.countsByRepo();
  const stats = await repo.statsByRepo(Date.now());
  return json({
    projects: projectsOf(ctx).map((name) => ({
      repo: name,
      counts: counts.get(name) ?? {
        active: 0,
        merged: 0,
        needs_human: 0,
        failed: 0,
      },
      attention: stats.get(name)?.attention ?? 0,
      costUsd:
        stats.get(name)?.costUsd === undefined ? 0 : stats.get(name)!.costUsd,
    })),
  });
}

/**
 * Stage 5. This billing period's estimated spend per account and the factory's mode. Public,
 * like the per-run cost: the amounts are estimates from recorded tokens and fixed prices.
 */
export async function handleBudget(ctx: RouteContext): Promise<Response> {
  if (ctx.env.DB === undefined) return unavailable();
  const status = await new BudgetService({
    repo: new D1BudgetRepo(ctx.env.DB),
    config: budgetConfig(ctx.env),
    now: () => Date.now(),
    factoryRepo: "",
  }).status();
  return json({
    period: status.period,
    runCapUsd: status.runCapUsd,
    mode: budgetMode(status),
    providers: Object.fromEntries(
      PROVIDERS.map((p) => {
        const b = status.providers[p];
        return [
          p,
          {
            limitUsd: b.limitUsd,
            spentUsd: b.spentUsd,
            exhausted: b.exhausted,
          },
        ];
      }),
    ),
  });
}

/** `limit` and `cursor` only; anything else, a repeat, or a malformed value is a bad request. */
function pageOf(url: URL): { limit: number; after: RunCursor | null } | null {
  let limit = DEFAULT_LIMIT;
  let after: RunCursor | null = null;
  const seen = new Set<string>();
  for (const [key, value] of url.searchParams) {
    if (seen.has(key)) return null;
    seen.add(key);
    if (key === "limit") {
      if (!/^[0-9]{1,6}$/.test(value)) return null;
      limit = Number(value);
      if (limit < 1) return null;
      limit = Math.min(limit, MAX_LIMIT);
    } else if (key === "cursor") {
      const m = CURSOR.exec(value);
      if (m === null) return null;
      after = { createdAt: Number(m[1]), id: m[2]! };
    } else return null;
  }
  return { limit, after };
}

export async function handleRuns(ctx: RouteContext): Promise<Response> {
  const name = `${ctx.params["owner"]}/${ctx.params["repo"]}`;
  if (!projectsOf(ctx).includes(name)) return notFound();
  const page = pageOf(ctx.url);
  if (page === null) return badRequest();
  const repo = repoOf(ctx);
  if (repo === null) return unavailable();
  const rows = await repo.listRuns(name, page.limit, page.after);
  const runs = rows.slice(0, page.limit);
  const last = runs.at(-1);
  return json({
    runs,
    nextCursor:
      rows.length > page.limit && last !== undefined
        ? `${last.createdAt}_${last.id}`
        : null,
  });
}

export async function handleRun(ctx: RouteContext): Promise<Response> {
  const repo = repoOf(ctx);
  if (repo === null) return unavailable();
  const run = await repo.getRun(ctx.params["id"]!);
  if (run === null || !projectsOf(ctx).includes(run.repo)) return notFound();
  return json({ run, events: await repo.listEvents(run.id) });
}

/**
 * POST /api/runs/:id/stop. The dispatcher has already required an operator and a same-origin request.
 * D1 only maps the run id to its repository and issue and checks PROJECTS. Whether the run can
 * still be stopped is the Durable Object's answer alone, so a retry after a crash gets the same
 * answer as the first call. The stop itself is applied later, by the run's next alarm tick.
 */
export async function handleStop(ctx: RouteContext): Promise<Response> {
  const repo = repoOf(ctx);
  if (repo === null || ctx.env.ISSUE_RUN === undefined) return unavailable();
  const id = ctx.params["id"]!;
  const run = await repo.getRun(id);
  if (run === null || !projectsOf(ctx).includes(run.repo)) return notFound();
  let result: StopResult;
  try {
    // The Durable Object is named by repository and issue, as when the run was started.
    result = await ctx.env.ISSUE_RUN.getByName(
      `${run.repo}#${run.issueNumber}`,
    ).stop(id);
  } catch (error) {
    logDiagnostic("stop_failed", { runId: id, error: errorKind(error) });
    return json({ error: "internal_error" }, 500);
  }
  logDiagnostic("stop_requested", {
    runId: id,
    operatorId: ctx.session?.id ?? "",
    result,
  });
  switch (result) {
    case "stop_requested":
      return json({ status: "stop_requested" }, 202);
    case "not_found":
      return notFound();
    default:
      return json({ error: result }, 409);
  }
}
