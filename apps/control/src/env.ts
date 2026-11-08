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
  /** Client ID of the GitHub OAuth App used for portal sign-in (not the GitHub App above). */
  GITHUB_OAUTH_CLIENT_ID?: string;
  OPERATOR_IDS?: string;
  RUNS_ENABLED?: string;
  PROJECTS?: string;
  IMPLEMENT_MODEL?: string;
  REVIEW_MODEL?: string;
  /** Stage 5. The model Codex implements with when Anthropic reached its limit. */
  FALLBACK_IMPLEMENT_MODEL?: string;
  /** Stage 5. The model that reviews on Anthropic (another engine's work, or T0/T1 alone). */
  ANTHROPIC_REVIEW_MODEL?: string;
  /** Stage 5. Monthly limit per account and per-run cap, in USD. Defaults 50, 50 and 5. */
  BUDGET_ANTHROPIC_USD?: string;
  BUDGET_OPENAI_USD?: string;
  RUN_BUDGET_USD?: string;
  /** Stage 5. Repository of the once-per-period budget issue. Not a managed project. */
  FACTORY_REPO?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  /** Key that signs session cookies. At least 32 characters. */
  SESSION_SECRET?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
}

// Compile-time check that the bindings `wrangler types` generates fit ControlEnv.
export const fromGeneratedEnv = (env: Env): ControlEnv => env;
