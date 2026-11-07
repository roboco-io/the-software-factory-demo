import {
  LoginFailed,
  OAUTH_COOKIE,
  authConfig,
  identify,
  startOAuth,
  type AuthConfig,
} from "./auth";
import { parseList } from "./config";
import { errorKind, logDiagnostic } from "./diagnostics";
import { json, type RouteContext } from "./http";
import { D1ReadRepo } from "./read-repo";
import { clearCookie, readCookie, signPayload, verifyPayload } from "./session";

/** Signed cookie that ties one OAuth round trip to one review the operator asked for. */
export const REVIEW_COOKIE = "__Host-review";
const REVIEW_TTL_SECONDS = 600;
const PURPOSE = "review";
const SCOPE = "public_repo";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BODY = 1024;

const STATE = /^[A-Za-z0-9_-]{43}$/;
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SHA = /^[A-Za-z0-9]{1,64}$/;
const USER_ID = /^[0-9]{1,20}$/;
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

const ACTIONS = ["approve", "request_changes"] as const;
export type ReviewAction = (typeof ACTIONS)[number];

/** What GitHub gets as the review body. Fixed text: nothing from the request reaches it. */
const BODIES: Readonly<Record<ReviewAction, string>> = {
  approve: "콘솔에서 운영자가 승인했습니다.",
  request_changes:
    "콘솔에서 수정을 요청했습니다. 자세한 내용은 이 PR에 이어서 남깁니다.",
};
const EVENTS: Readonly<Record<ReviewAction, string>> = {
  approve: "APPROVE",
  request_changes: "REQUEST_CHANGES",
};

export type ReviewOutcome = "ok" | "stale" | "denied" | "failed";

export interface ReviewIntent {
  state: string;
  runId: string;
  action: ReviewAction;
  headSha: string;
  userId: string;
  exp: number;
}

const badRequest = () => json({ error: "bad_request" }, 400);

/**
 * POST /api/runs/:id/review. The dispatcher has already required an operator and a same-origin
 * request. This only records what the operator asked for in a signed cookie and sends them to
 * GitHub, where they sign in again and grant `public_repo`. The review itself is posted in the
 * callback, with the user's own token, so GitHub records the decision under their name.
 */
export async function handleReviewStart(ctx: RouteContext): Promise<Response> {
  const config = authConfig(ctx.env);
  if (config === null) return json({ error: "auth_not_configured" }, 503);
  if (ctx.session === null) return json({ error: "unauthenticated" }, 401);
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
  const { action, headSha } = body as Record<string, unknown>;
  if (
    typeof action !== "string" ||
    !(ACTIONS as readonly string[]).includes(action) ||
    typeof headSha !== "string" ||
    !SHA.test(headSha)
  )
    return badRequest();
  if (ctx.env.DB === undefined) return json({ error: "unavailable" }, 503);
  const run = await new D1ReadRepo(ctx.env.DB).getRun(ctx.params["id"]!);
  if (run === null || !parseList(ctx.env.PROJECTS).includes(run.repo))
    return json({ error: "not_found" }, 404);
  if (run.state !== "awaiting_approval")
    return json({ error: "not_awaiting_approval" }, 409);
  if (run.headSha === null || run.headSha !== headSha)
    return json({ error: "head_changed" }, 409);

  const start = await startOAuth(config, SCOPE);
  const intent: ReviewIntent = {
    state: start.state,
    runId: run.id,
    action: action as ReviewAction,
    headSha,
    userId: ctx.session.id,
    exp: Math.floor(ctx.now() / 1000) + REVIEW_TTL_SECONDS,
  };
  const value = await signPayload(config.sessionSecret, PURPOSE, {
    ...intent,
  });
  const response = json({ redirect: start.location });
  response.headers.append("set-cookie", start.cookie);
  response.headers.append(
    "set-cookie",
    `${REVIEW_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${REVIEW_TTL_SECONDS}`,
  );
  return response;
}

/** The review the request's signed cookie describes, or null when absent, forged, malformed or expired. */
export async function readReviewCookie(
  ctx: RouteContext,
  config: AuthConfig,
): Promise<ReviewIntent | null> {
  const raw = readCookie(ctx.request.headers.get("cookie"), REVIEW_COOKIE);
  const data = await verifyPayload(config.sessionSecret, PURPOSE, raw);
  if (data === null) return null;
  const { state, runId, action, headSha, userId, exp } = data;
  if (
    typeof state !== "string" ||
    !STATE.test(state) ||
    typeof runId !== "string" ||
    !RUN_ID.test(runId) ||
    typeof action !== "string" ||
    !(ACTIONS as readonly string[]).includes(action) ||
    typeof headSha !== "string" ||
    !SHA.test(headSha) ||
    typeof userId !== "string" ||
    !USER_ID.test(userId) ||
    typeof exp !== "number" ||
    !Number.isSafeInteger(exp) ||
    exp <= Math.floor(ctx.now() / 1000)
  )
    return null;
  return { state, runId, action: action as ReviewAction, headSha, userId, exp };
}

/** Sends the browser back to the run page and clears both cookies of the round trip. */
export function reviewRedirect(
  intent: ReviewIntent,
  outcome: ReviewOutcome,
): Response {
  const headers = new Headers({
    location: `/runs/${intent.runId}?review=${outcome}`,
    "cache-control": "no-store",
  });
  headers.append("set-cookie", clearCookie(OAUTH_COOKIE));
  headers.append("set-cookie", clearCookie(REVIEW_COOKIE));
  return new Response(null, { status: 302, headers });
}

const githubHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "user-agent": "software-factory-control",
  "x-github-api-version": "2022-11-28",
});

/**
 * Finishes a review in the OAuth callback. The state was already checked against both cookies.
 * Never throws: every outcome is a redirect with a fixed word. The user's token lives only in
 * this call; only fixed reasons and error classes are logged.
 */
export async function completeReview(
  ctx: RouteContext,
  config: AuthConfig,
  intent: ReviewIntent,
  code: string,
  verifier: string,
): Promise<Response> {
  const finish = (outcome: ReviewOutcome, reason: string): Response => {
    logDiagnostic("review_completed", {
      runId: intent.runId,
      outcome,
      reason,
    });
    return reviewRedirect(intent, outcome);
  };
  try {
    return await identify(ctx, config, code, verifier, async (who, token) => {
      if (who.id !== intent.userId) return finish("denied", "other_user");
      if (!parseList(ctx.env.OPERATOR_IDS).includes(who.id))
        return finish("denied", "not_operator");
      if (ctx.env.DB === undefined) return finish("failed", "unavailable");
      const run = await new D1ReadRepo(ctx.env.DB).getRun(intent.runId);
      if (
        run === null ||
        !parseList(ctx.env.PROJECTS).includes(run.repo) ||
        !REPO.test(run.repo) ||
        run.prNumber === null
      )
        return finish("stale", "run_gone");
      if (run.state !== "awaiting_approval")
        return finish("stale", "not_awaiting");
      if (run.headSha !== intent.headSha) return finish("stale", "head_moved");
      const [owner, name] = run.repo.split("/") as [string, string];
      const pull = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${run.prNumber}`;
      const live = await ctx.fetch(pull, {
        headers: githubHeaders(token),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!live.ok) return finish("failed", "pull_read");
      // GitHub lists the token's scopes on every API answer. When it does and none can write
      // to a public repository, stop here instead of sending a write that cannot succeed.
      const scopes = live.headers.get("x-oauth-scopes");
      if (
        scopes !== null &&
        !scopes
          .split(",")
          .map((x) => x.trim())
          .some((x) => x === SCOPE || x === "repo")
      )
        return finish("failed", "missing_scope");
      const data: unknown = await live.json();
      const head =
        typeof data === "object" && data !== null
          ? (data as { head?: { sha?: unknown } }).head?.sha
          : undefined;
      if (typeof head !== "string") return finish("failed", "pull_read");
      if (head !== intent.headSha) return finish("stale", "head_moved");
      const posted = await ctx.fetch(`${pull}/reviews`, {
        method: "POST",
        headers: {
          ...githubHeaders(token),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          commit_id: intent.headSha,
          event: EVENTS[intent.action],
          body: BODIES[intent.action],
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!posted.ok) return finish("failed", "post_review");
      return finish("ok", intent.action);
    });
  } catch (error) {
    if (error instanceof LoginFailed) return finish("failed", error.reason);
    return finish("failed", errorKind(error));
  }
}
