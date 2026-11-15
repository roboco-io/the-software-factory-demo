import { handleRequest } from "./app";
import type { ControlEnv } from "./env";
import { runScheduled } from "./scheduled";

export { AgentSandbox } from "./agent-sandbox";
export { IssueRun } from "./issue-run";
export { Outbound } from "./outbound";

export default {
  fetch: (request: Request, env: ControlEnv, ctx: ExecutionContext) =>
    handleRequest(request, env, { waitUntil: (work) => ctx.waitUntil(work) }),
  // Cron Trigger (wrangler.jsonc "triggers"): the daily Dependabot pass.
  scheduled: (
    _controller: ScheduledController,
    env: ControlEnv,
    ctx: ExecutionContext,
  ) => ctx.waitUntil(runScheduled(env)),
};
