import { completeReview } from "./review-api";
import type { ReviewDeps } from "./review-api";
import type { UserGitHub } from "./github-user";
import {
  readUser,
  roleOf,
  sessionCookie,
  signToken,
  verifyToken,
} from "./session";

export type AuthDeps = {
  sessionSecret?: string;
  clientId?: string;
  operatorIds: string[];
  github: Pick<UserGitHub, "exchangeCode" | "getUser">;
  review: ReviewDeps;
  now(): number;
  origin: string;
};

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;
const NONCE_COOKIE = "factory_oauth";
const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function methodNotAllowed(allow: string): Response {
  return json(405, { error: "method_not_allowed" }, { allow });
}

function nonceCookie(value: string, maxAgeSeconds: number): string {
  return `${NONCE_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function readCookie(header: string | null, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name)
      return part.slice(index + 1).trim();
  }
  return undefined;
}

function sameValue(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function redirect(location: string, cookies: string[]): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function loginEnabled(deps: AuthDeps): boolean {
  return Boolean(deps.sessionSecret) && Boolean(deps.clientId);
}

async function handleSession(
  request: Request,
  deps: AuthDeps,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD")
    return methodNotAllowed("GET, HEAD");
  const user = await readUser(
    request.headers.get("cookie"),
    deps.sessionSecret,
    deps.now(),
  );
  return json(200, {
    role: roleOf(user, deps.operatorIds),
    login: user?.login ?? null,
    loginEnabled: loginEnabled(deps),
  });
}

async function handleLogin(
  request: Request,
  deps: AuthDeps,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed("GET");
  if (!deps.sessionSecret || !deps.clientId)
    return json(503, { error: "login_not_configured" });
  const nonce = newNonce();
  const state = await signToken(
    { kind: "login", nonce },
    deps.sessionSecret,
    deps.now(),
    STATE_TTL_MS,
  );
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", deps.clientId);
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", `${deps.origin}/api/auth/callback`);
  return redirect(url.toString(), [nonceCookie(nonce, STATE_TTL_MS / 1000)]);
}

async function handleCallback(
  request: Request,
  deps: AuthDeps,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed("GET");
  if (!deps.sessionSecret || !deps.clientId)
    return json(503, { error: "login_not_configured" });
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = await verifyToken(
    url.searchParams.get("state") ?? undefined,
    deps.sessionSecret,
    deps.now(),
  );
  const cookieNonce = readCookie(request.headers.get("cookie"), NONCE_COOKIE);
  if (
    !code ||
    !state ||
    typeof state.nonce !== "string" ||
    !cookieNonce ||
    !sameValue(state.nonce, cookieNonce)
  ) {
    return json(400, { error: "bad_state" });
  }
  const isReview = state.kind === "review";
  if (state.kind !== "login" && !isReview)
    return json(400, { error: "bad_state" });
  if (
    isReview &&
    (typeof state.runId !== "string" ||
      typeof state.headSha !== "string" ||
      typeof state.userId !== "string" ||
      (state.action !== "approve" && state.action !== "request_changes"))
  ) {
    return json(400, { error: "bad_state" });
  }

  let token: string | undefined;
  try {
    token = await deps.github.exchangeCode(code);
    const user = await deps.github.getUser(token);
    const cookies = [nonceCookie("", 0)];
    // A review callback must not change the browser's session when the GitHub
    // account differs from the user who started the review.
    if (!isReview || user.id === state.userId) {
      const session = await signToken(
        { id: user.id, login: user.login },
        deps.sessionSecret,
        deps.now(),
        SESSION_TTL_MS,
      );
      cookies.push(sessionCookie(session, SESSION_TTL_MS / 1000));
    }
    if (!isReview) return redirect("/", cookies);
    const runId = state.runId as string;
    let result: "ok" | "stale" | "denied" | "failed" = "denied";
    if (user.id === state.userId) {
      result = await completeReview(
        deps.review,
        {
          runId,
          action: state.action as "approve" | "request_changes",
          headSha: state.headSha as string,
          userId: user.id,
        },
        token,
      );
    }
    return redirect(
      `/?run=${encodeURIComponent(runId)}&review=${encodeURIComponent(result)}`,
      cookies,
    );
  } catch {
    return json(
      502,
      { error: "github_failed" },
      { "set-cookie": nonceCookie("", 0) },
    );
  } finally {
    token = undefined;
  }
}

function handleLogout(request: Request, deps: AuthDeps): Response {
  if (request.method !== "POST") return methodNotAllowed("POST");
  if (request.headers.get("origin") !== deps.origin)
    return json(403, { error: "forbidden" });
  return json(200, { ok: true }, { "set-cookie": sessionCookie("", 0) });
}

export async function handleAuth(
  request: Request,
  deps: AuthDeps,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  switch (path) {
    case "/api/session":
      return handleSession(request, deps);
    case "/api/auth/login":
      return handleLogin(request, deps);
    case "/api/auth/callback":
      return handleCallback(request, deps);
    case "/api/auth/logout":
      return handleLogout(request, deps);
    default:
      return null;
  }
}
