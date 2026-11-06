import { isValidRepo } from "./repo";

export type OutboundDecision =
  | { allow: false; reason: string }
  | { allow: true; target: "anthropic" | "github" };

export interface OutboundRequest {
  method: string;
  url: string;
}

const ANTHROPIC_PATHS = new Set(["/v1/messages", "/v1/messages/count_tokens"]);

const deny = (reason: string): OutboundDecision => ({ allow: false, reason });

/**
 * Deny-by-default egress policy for the agent container. Pure: no I/O.
 * `run.repo` is the single repository bound to this run.
 */
export function decideOutbound(
  request: OutboundRequest,
  run: { repo?: string },
): OutboundDecision {
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
    if (request.method === "POST" && ANTHROPIC_PATHS.has(url.pathname)) {
      return { allow: true, target: "anthropic" };
    }
    return deny("anthropic_request_not_allowed");
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
