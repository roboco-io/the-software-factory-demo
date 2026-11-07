import type { D1Like } from "./d1-repo";
import type { UserGitHub } from "./github-user";
import { getRun } from "./run-query";
import { readUser, roleOf, signToken } from "./session";

export interface ReviewDeps {
  db: D1Like;
  publicRepos: string[];
  operatorIds: string[];
  sessionSecret?: string;
  clientId?: string;
  github: Pick<UserGitHub, "getPullHead" | "postReview">;
  now(): number;
  origin: string;
}

type Action = "approve" | "request_changes";

const STATE_TTL_MS = 10 * 60 * 1000;
const BODIES: Record<
  Action,
  { event: "APPROVE" | "REQUEST_CHANGES"; body: string }
> = {
  approve: { event: "APPROVE", body: "콘솔에서 운영자가 승인했습니다." },
  request_changes: {
    event: "REQUEST_CHANGES",
    body: "콘솔에서 수정을 요청했습니다. 자세한 내용은 이 PR에 이어서 남깁니다.",
  },
};

function json(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
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

export async function handleReviewRequest(
  request: Request,
  deps: ReviewDeps,
): Promise<Response | null> {
  const url = new URL(request.url);
  const m = /^\/api\/runs\/([^/]+)\/review$/.exec(url.pathname);
  if (!m || request.method !== "POST") return null;
  let runId: string;
  try {
    runId = decodeURIComponent(m[1] as string);
  } catch {
    return json(400, { error: "bad_request" });
  }

  if (request.headers.get("origin") !== deps.origin)
    return json(403, { error: "forbidden" });
  const ct = (request.headers.get("content-type") ?? "")
    .split(";")[0]
    ?.trim()
    .toLowerCase();
  if (ct !== "application/json")
    return json(415, { error: "unsupported_media_type" });

  const user = await readUser(
    request.headers.get("cookie"),
    deps.sessionSecret,
    deps.now(),
  );
  const role = roleOf(user, deps.operatorIds);
  if (role === "anonymous" || !user)
    return json(401, { error: "login_required" });
  if (role !== "operator") return json(403, { error: "forbidden" });
  if (!deps.sessionSecret || !deps.clientId)
    return json(503, { error: "not_configured" });

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return json(400, { error: "bad_request" });
  }
  const b = (
    typeof parsed === "object" && parsed !== null ? parsed : {}
  ) as Record<string, unknown>;
  const action = b.action;
  if (
    (action !== "approve" && action !== "request_changes") ||
    typeof b.headSha !== "string" ||
    !b.headSha
  ) {
    return json(400, { error: "bad_request" });
  }

  const run = await getRun(deps.db, runId, {
    publicRepos: deps.publicRepos,
    now: deps.now(),
  });
  if (!run) return json(404, { error: "not_found" });
  if (run.state !== "awaiting_approval")
    return json(409, { error: "not_awaiting_approval" });
  if (run.headSha !== b.headSha) return json(409, { error: "head_changed" });

  const nonce = crypto.randomUUID();
  const state = await signToken(
    {
      kind: "review",
      nonce,
      runId: run.id,
      action,
      headSha: run.headSha,
      userId: user.id,
    },
    deps.sessionSecret,
    deps.now(),
    STATE_TTL_MS,
  );
  const redirect = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(deps.clientId)}&state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(`${deps.origin}/api/auth/callback`)}&scope=`;
  return json(
    200,
    { redirect },
    {
      "set-cookie": `factory_oauth=${nonce}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${STATE_TTL_MS / 1000}`,
    },
  );
}

export async function completeReview(
  deps: ReviewDeps,
  intent: { runId: string; action: Action; headSha: string; userId: string },
  token: string,
): Promise<"ok" | "stale" | "denied" | "failed"> {
  if (!deps.operatorIds.includes(intent.userId)) return "denied";
  try {
    const run = await getRun(deps.db, intent.runId, {
      publicRepos: deps.publicRepos,
      now: deps.now(),
    });
    if (!run || run.prNumber === null) return "failed";
    if (run.state !== "awaiting_approval" || run.headSha !== intent.headSha)
      return "stale";
    const live = await deps.github.getPullHead(token, run.repo, run.prNumber);
    if (!live.open || live.headSha !== intent.headSha) return "stale";
    const { event, body } = BODIES[intent.action];
    await deps.github.postReview(token, run.repo, run.prNumber, {
      commitId: intent.headSha,
      event,
      body,
    });
    return "ok";
  } catch {
    return "failed";
  }
}
