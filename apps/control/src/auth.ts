import { errorKind, logDiagnostic } from "./diagnostics";
import type { ControlEnv } from "./env";
import { json, type RouteContext } from "./http";
import {
  completeReview,
  readReviewCookie,
  REVIEW_COOKIE,
  reviewRedirect,
} from "./review";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  clearCookie,
  constantTimeEqual,
  readCookie,
  sessionCookie,
  signSession,
  toBase64Url,
} from "./session";

/** Cookie that carries the state and the PKCE verifier between login and callback. */
export const OAUTH_COOKIE = "__Host-oauth";
const OAUTH_TTL_SECONDS = 600;
const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const REQUEST_TIMEOUT_MS = 10_000;
const MIN_SESSION_SECRET = 32;

const STATE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9_-]{43,128}$/;
const CODE = /^[A-Za-z0-9_-]{1,256}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export interface AuthConfig {
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
}

/** The OAuth settings, or null while any is missing. Login then answers 503 and reading still works. */
export function authConfig(env: Partial<ControlEnv>): AuthConfig | null {
  const clientId = env.GITHUB_OAUTH_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.GITHUB_OAUTH_CLIENT_SECRET ?? "";
  const sessionSecret = env.SESSION_SECRET ?? "";
  if (clientId === "" || clientSecret === "") return null;
  if (sessionSecret.length < MIN_SESSION_SECRET) return null;
  return { clientId, clientSecret, sessionSecret };
}

const notConfigured = () => json({ error: "auth_not_configured" }, 503);

const random = (bytes: number) =>
  toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));

/**
 * Starts one OAuth round trip: a fresh state and PKCE verifier, the authorize address, and the
 * `__Host-oauth` cookie to set. Plain sign-in passes no scope, so GitHub grants identity only.
 */
export async function startOAuth(
  config: AuthConfig,
  scope?: string,
): Promise<{ location: string; state: string; cookie: string }> {
  const state = random(32);
  const verifier = random(48);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const target = new URL(AUTHORIZE_URL);
  target.searchParams.set("client_id", config.clientId);
  target.searchParams.set("state", state);
  target.searchParams.set(
    "code_challenge",
    toBase64Url(new Uint8Array(digest)),
  );
  target.searchParams.set("code_challenge_method", "S256");
  if (scope !== undefined) target.searchParams.set("scope", scope);
  return {
    location: target.toString(),
    state,
    cookie: `${OAUTH_COOKIE}=${state}.${verifier}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${OAUTH_TTL_SECONDS}`,
  };
}

export async function handleLogin(ctx: RouteContext): Promise<Response> {
  const config = authConfig(ctx.env);
  if (config === null) return notConfigured();
  const start = await startOAuth(config);
  const headers = new Headers({
    location: start.location,
    "cache-control": "no-store",
  });
  headers.append("set-cookie", start.cookie);
  return new Response(null, { status: 302, headers });
}

/** Fixed reasons a sign-in can fail. They go to the log, never the address or the user. */
export type FailReason =
  | "denied"
  | "bad_request"
  | "state_mismatch"
  | "token_exchange"
  | "profile"
  | "unexpected";

export class LoginFailed extends Error {
  constructor(readonly reason: FailReason) {
    super(reason);
  }
}

function failed(reason: FailReason, error?: string): Response {
  logDiagnostic(
    "auth_callback_failed",
    error === undefined ? { reason } : { reason, error },
  );
  const headers = new Headers({
    location: "/?login=failed",
    "cache-control": "no-store",
  });
  headers.append("set-cookie", clearCookie(OAUTH_COOKIE));
  return new Response(null, { status: 302, headers });
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Trades the one-time code for a token, asks GitHub who the user is, and returns only the
 * numeric id and login. The token lives in this function's variables and nowhere else:
 * it is not stored, logged, returned or sent anywhere but GitHub's `/user`.
 */
export async function identify<T>(
  ctx: RouteContext,
  config: AuthConfig,
  code: string,
  verifier: string,
  use: (who: { id: string; login: string }, token: string) => Promise<T>,
): Promise<T> {
  const exchange = await ctx.fetch(TOKEN_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!exchange.ok) throw new LoginFailed("token_exchange");
  const granted: unknown = await exchange.json();
  if (
    !isRecord(granted) ||
    typeof granted["access_token"] !== "string" ||
    granted["access_token"] === ""
  )
    throw new LoginFailed("token_exchange");
  const token: string = granted["access_token"];
  const profile = await ctx.fetch(USER_URL, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "software-factory-control",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!profile.ok) throw new LoginFailed("profile");
  const user: unknown = await profile.json();
  if (
    !isRecord(user) ||
    typeof user["id"] !== "number" ||
    !Number.isSafeInteger(user["id"]) ||
    user["id"] < 1 ||
    typeof user["login"] !== "string" ||
    !LOGIN.test(user["login"])
  )
    throw new LoginFailed("profile");
  return use({ id: String(user["id"]), login: user["login"] }, token);
}

export async function handleCallback(ctx: RouteContext): Promise<Response> {
  const config = authConfig(ctx.env);
  if (config === null) return notConfigured();
  const cookieHeader = ctx.request.headers.get("cookie");
  const review = await readReviewCookie(ctx, config);
  try {
    const query = ctx.url.searchParams;
    const state = query.get("state");
    const isReview =
      review !== null &&
      state !== null &&
      constantTimeEqual(state, review.state);
    if (query.has("error")) {
      if (isReview) return reviewRedirect(review, "denied");
      throw new LoginFailed("denied");
    }
    const code = query.get("code");
    const stored = readCookie(cookieHeader, OAUTH_COOKIE);
    if (code === null || state === null || stored === undefined)
      throw new LoginFailed("bad_request");
    const [expected, verifier, ...rest] = stored.split(".");
    if (
      rest.length > 0 ||
      expected === undefined ||
      verifier === undefined ||
      !STATE.test(expected) ||
      !VERIFIER.test(verifier) ||
      !CODE.test(code)
    )
      throw new LoginFailed("bad_request");
    if (!constantTimeEqual(state, expected))
      throw new LoginFailed("state_mismatch");
    // The signed review cookie holds this very state: this round trip was started by a review.
    if (isReview)
      return await completeReview(ctx, config, review, code, verifier);
    const user = await identify(
      ctx,
      config,
      code,
      verifier,
      async (who) => who,
    );
    const exp = Math.floor(ctx.now() / 1000) + SESSION_TTL_SECONDS;
    const value = await signSession(config.sessionSecret, { ...user, exp });
    const headers = new Headers({ location: "/", "cache-control": "no-store" });
    headers.append("set-cookie", sessionCookie(value));
    headers.append("set-cookie", clearCookie(OAUTH_COOKIE));
    if (review !== null)
      headers.append("set-cookie", clearCookie(REVIEW_COOKIE));
    return new Response(null, { status: 302, headers });
  } catch (error) {
    if (error instanceof LoginFailed) return failed(error.reason);
    // Only the class of the error is logged: a message could carry a token.
    return failed("unexpected", errorKind(error));
  }
}

export function handleLogout(): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  headers.append("set-cookie", clearCookie(SESSION_COOKIE));
  return new Response(JSON.stringify({ role: "anonymous" }), {
    status: 200,
    headers,
  });
}
