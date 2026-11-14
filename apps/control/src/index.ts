import { handleRequest } from "./app";
import type { ControlEnv } from "./env";

export { AgentSandbox } from "./agent-sandbox";
export { IssueRun } from "./issue-run";
export { Outbound } from "./outbound";

export default {
  fetch: (request: Request, env: ControlEnv, ctx: ExecutionContext) =>
    handleRequest(request, env, { waitUntil: (work) => ctx.waitUntil(work) }),
};
