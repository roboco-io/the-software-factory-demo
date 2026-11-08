import { isValidRepo } from "./repo";

export type OutboundTarget = "anthropic" | "openai" | "github";

export type OutboundDecision =
  { allow: false; reason: string } | { allow: true; target: OutboundTarget };

/**
 * Which agent the sandbox runs. A sandbox reaches one LLM provider and no other: the
 * provider of the model it is bound to. Without that, the implement sandbox reaches only
 * Anthropic and the review sandbox only OpenAI (before stage 5 every sandbox was bound so).
 * A sandbox without a phase reaches neither.
 */
export type SandboxPhase = "implement" | "review";
export type ModelProvider = "anthropic" | "openai";

export interface OutboundRequest {
  method: string;
  url: string;
}

const ANTHROPIC_PATHS = new Set(["/v1/messages", "/v1/messages/count_tokens"]);
const OPENAI_PATH = "/v1/responses";

const deny = (reason: string): OutboundDecision => ({ allow: false, reason });

/**
 * Deny-by-default egress policy for the agent container. Pure: no I/O.
 * `run.repo` is the single repository bound to this run.
 */
export function decideOutbound(
  request: OutboundRequest,
  run: {
    repo?: string;
    phase?: SandboxPhase | undefined;
    provider?: ModelProvider | undefined;
  },
): OutboundDecision {
  const provider =
    run.phase === undefined
      ? undefined
      : (run.provider ?? (run.phase === "implement" ? "anthropic" : "openai"));
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return deny("invalid_url");
  }
  if (url.protocol !== "https:") return deny("not_https");
  if (url.username !== "" || url.password !== "")
    return deny("credentials_in_url");
  if (url.port !== "") return deny("port_not_allowed");

  if (url.hostname === "api.anthropic.com") {
    if (provider !== "anthropic") return deny("provider_not_allowed_in_phase");
    if (request.method === "POST" && ANTHROPIC_PATHS.has(url.pathname)) {
      return { allow: true, target: "anthropic" };
    }
    return deny("anthropic_request_not_allowed");
  }

  if (url.hostname === "api.openai.com") {
    if (provider !== "openai") return deny("provider_not_allowed_in_phase");
    if (
      request.method === "POST" &&
      url.pathname === OPENAI_PATH &&
      url.search === ""
    ) {
      return { allow: true, target: "openai" };
    }
    return deny("openai_request_not_allowed");
  }

  if (url.hostname === "github.com") {
    const repo = run.repo;
    if (repo === undefined || !isValidRepo(repo)) return deny("no_repo_bound");
    const path = url.pathname.toLowerCase();
    const base = `/${repo.toLowerCase()}`;
    const bases = [base, `${base}.git`];
    if (request.method === "GET") {
      const ok =
        url.search === "?service=git-upload-pack" &&
        bases.some((b) => path === `${b}/info/refs`);
      return ok
        ? { allow: true, target: "github" }
        : deny("github_request_not_allowed");
    }
    if (request.method === "POST") {
      const ok =
        url.search === "" && bases.some((b) => path === `${b}/git-upload-pack`);
      return ok
        ? { allow: true, target: "github" }
        : deny("github_request_not_allowed");
    }
    return deny("github_request_not_allowed");
  }

  return deny("host_not_allowed");
}

/** Copies the headers, drops any client-supplied credentials and sets the real key. */
export function injectAnthropicKey(headers: Headers, apiKey: string): Headers {
  const out = new Headers(headers);
  out.delete("authorization");
  out.set("x-api-key", apiKey);
  return out;
}

/** The real key for a target. Each target has its own key: a phase can never get the other provider's. */
export function selectKey(
  target: OutboundTarget,
  env: {
    ANTHROPIC_API_KEY?: string | undefined;
    OPENAI_API_KEY?: string | undefined;
  },
): string | undefined {
  if (target === "anthropic") return env.ANTHROPIC_API_KEY || undefined;
  if (target === "openai") return env.OPENAI_API_KEY || undefined;
  return undefined;
}

/** Copies the headers, drops client-supplied credentials and account routing, and sets the real key. */
export function injectOpenAIKey(headers: Headers, apiKey: string): Headers {
  const out = new Headers(headers);
  for (const name of [
    "authorization",
    "x-api-key",
    "api-key",
    "openai-organization",
    "openai-project",
  ])
    out.delete(name);
  out.set("authorization", `Bearer ${apiKey}`);
  return out;
}
