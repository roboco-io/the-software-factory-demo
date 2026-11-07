import type { AgentSandbox } from "./agent-sandbox";
import type { D1Like } from "./d1-repo";
import type { IssueRun } from "./issue-run";

/** Bindings, variables and secrets of the control Worker. Secrets may be unset before `wrangler secret put`. */
export interface ControlEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  DB: D1Like;
  ISSUE_RUN: DurableObjectNamespace<IssueRun>;
  SANDBOX: DurableObjectNamespace<AgentSandbox>;
  GITHUB_APP_ID?: string;
  OPERATOR_IDS?: string;
  RUNS_ENABLED?: string;
  PROJECTS?: string;
  PUBLIC_REPOS?: string;
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
  IMPLEMENT_MODEL?: string;
  REVIEW_MODEL?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
}

// Compile-time check that the bindings `wrangler types` generates fit ControlEnv.
export const fromGeneratedEnv = (env: Env): ControlEnv => env;
