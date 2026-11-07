import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRequest, type AppDeps } from "./app";
import { operatorStanding } from "./decision";
import {
  OBSERVER_ID,
  OPERATOR_ID,
  SESSION_SECRET,
  makeWorld,
  observerCookie,
  operatorCookie,
  req,
  seedRuns,
} from "./testing/api-world";
import { signPayload } from "./session";

const TOKEN = "review-token-SENTINEL-not-real";
const HEAD = "abc";
const RUN = "aaaaaaaaaaa1";

afterEach(() => vi.restoreAllMocks());

interface Gh {
  calls: { url: string; init: RequestInit | undefined }[];
  fetch: typeof fetch;
}
function fakeGitHub(
  o: {
    userId?: number;
    live?: string;
    reviewStatus?: number;
    pullStatus?: number;
    scopes?: string;
  } = {},
): Gh {
  const calls: Gh["calls"] = [];
  const f = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "https://github.com/login/oauth/access_token")
      return Response.json({ access_token: TOKEN });
    if (url === "https://api.github.com/user")
      return Response.json({
        id: o.userId ?? Number(OPERATOR_ID),
        login: "boss",
      });
    if (url.endsWith("/pulls/40"))
      return Response.json(
        { head: { sha: o.live ?? HEAD } },
        {
          status: o.pullStatus ?? 200,
          headers: o.scopes === undefined ? {} : { "x-oauth-scopes": o.scopes },
        },
      );
    if (url.endsWith("/pulls/40/reviews"))
      return Response.json({}, { status: o.reviewStatus ?? 200 });
    return new Response("unexpected", { status: 500 });
  };
  return { calls, fetch: f as typeof fetch };
}
const deps = (g: Gh): AppDeps => ({ fetch: g.fetch });
const noFetch = () => fakeGitHub();

function world(over = {}) {
  const w = makeWorld(over);
  seedRuns(w);
  w.exec(`UPDATE runs SET head_sha = '${HEAD}' WHERE id = '${RUN}'`);
  return w;
}
const post = async (
  w: ReturnType<typeof world>,
  g: Gh,
  body: unknown,
  o: {
    cookie?: string | null;
    origin?: string | null;
    type?: string | null;
    id?: string;
  } = {},
) => {
  const cookie = o.cookie === undefined ? await operatorCookie() : o.cookie;
  const headers: Record<string, string> = {};
  if (o.type !== null) headers["content-type"] = o.type ?? "application/json";
  const request = req(`/api/runs/${o.id ?? RUN}/review`, {
    method: "POST",
    ...(cookie === null ? {} : { cookie }),
    ...(o.origin === undefined ? {} : { origin: o.origin }),
    headers,
  });
  return handleRequest(
    new Request(request, {
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    w.env,
    deps(g),
  );
};
const cookieOf = (res: Response, name: string) =>
  res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
const pair = (c: string | undefined) => c!.split(";")[0]!;

/** Starts a review and returns the cookies and state of the round trip. */
async function start(
  w: ReturnType<typeof world>,
  action = "approve",
  headSha = HEAD,
) {
  const g = noFetch();
  const res = await post(w, g, { action, headSha });
  expect(res.status).toBe(200);
  const { redirect } = (await res.json()) as { redirect: string };
  const url = new URL(redirect);
  return {
    res,
    url,
    state: url.searchParams.get("state")!,
    cookies: `${pair(cookieOf(res, "__Host-oauth"))}; ${pair(cookieOf(res, "__Host-review"))}`,
  };
}
const callback = (
  w: ReturnType<typeof world>,
  g: Gh,
  state: string,
  cookie: string,
  query = "code=abc",
) =>
  handleRequest(
    req(`/api/auth/callback?${query}&state=${state}`, { cookie }),
    w.env,
    deps(g),
  );
const reviewCalls = (g: Gh) =>
  g.calls.filter((c) => c.url.endsWith("/reviews"));

describe("review start", () => {
  it("answers the authorize address with public_repo and sets both cookies", async () => {
    const w = world();
    const s = await start(w);
    expect(s.url.origin + s.url.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(s.url.searchParams.get("scope")).toBe("public_repo");
    expect(cookieOf(s.res, "__Host-review")).toMatch(
      /; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/,
    );
  });

  it("test_head_moved_stale: a different head is 409 head_changed", async () => {
    const w = world();
    const res = await post(w, noFetch(), {
      action: "approve",
      headSha: "other",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "head_changed" });
  });

  it("test_not_awaiting_409", async () => {
    const w = world();
    const res = await post(
      w,
      noFetch(),
      { action: "approve", headSha: "x" },
      { id: "aaaaaaaaaaa2" },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_awaiting_approval" });
  });

  it("test_bad_action_400 and other bad bodies", async () => {
    const w = world();
    for (const [body, type] of [
      [{ action: "merge", headSha: HEAD }, undefined],
      [{ action: "approve" }, undefined],
      [{ action: "approve", headSha: 5 }, undefined],
      ["not json", undefined],
      ["[]", undefined],
      [{ action: "approve", headSha: HEAD }, "text/plain"],
      [{ action: "approve", headSha: HEAD }, null],
    ] as const) {
      const res = await post(w, noFetch(), body, { type });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_request" });
    }
  });

  it("is 404 for an unknown run or one outside PROJECTS", async () => {
    const w = world();
    expect(
      (
        await post(
          w,
          noFetch(),
          { action: "approve", headSha: HEAD },
          { id: "nope" },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await post(
          w,
          noFetch(),
          { action: "approve", headSha: HEAD },
          { id: "aaaaaaaaaaa5" },
        )
      ).status,
    ).toBe(404);
  });

  it("is 503 auth_not_configured without OAuth settings", async () => {
    const w = world({ GITHUB_OAUTH_CLIENT_SECRET: "" });
    const res = await post(w, noFetch(), { action: "approve", headSha: HEAD });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "auth_not_configured" });
  });

  it("test_observer_403_no_fetch, test_anonymous_401_no_fetch, test_bad_origin_403", async () => {
    const w = world();
    const g = noFetch();
    const b = { action: "approve", headSha: HEAD };
    expect(
      (await post(w, g, b, { cookie: await observerCookie() })).status,
    ).toBe(403);
    expect((await post(w, g, b, { cookie: null })).status).toBe(401);
    expect((await post(w, g, b, { origin: "https://evil.test" })).status).toBe(
      403,
    );
    expect((await post(w, g, b, { origin: null })).status).toBe(403);
    expect(g.calls).toEqual([]);
  });
});

describe("review completion", () => {
  it("approve posts APPROVE on the displayed commit and operatorStanding counts it", async () => {
    const w = world();
    const s = await start(w);
    const g = fakeGitHub();
    const res = await callback(w, g, s.state, s.cookies);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/runs/${RUN}?review=ok`);
    const [call] = reviewCalls(g);
    const sent = JSON.parse(String(call!.init!.body));
    expect(sent).toEqual({
      commit_id: HEAD,
      event: "APPROVE",
      body: "콘솔에서 운영자가 승인했습니다.",
    });
    expect(
      (call!.init!.headers as Record<string, string>)["authorization"],
    ).toBe(`Bearer ${TOKEN}`);
    expect(
      operatorStanding(
        [
          {
            userId: OPERATOR_ID,
            userType: "User",
            state: "APPROVED",
            commitId: sent.commit_id,
          },
        ],
        { headSha: HEAD, operatorIds: [OPERATOR_ID], authorId: null },
      ),
    ).toEqual({ approved: true, blocked: false });
    const cleared = res.headers.getSetCookie().join("\n");
    expect(cleared).toMatch(/__Host-oauth=; .*Max-Age=0/);
    expect(cleared).toMatch(/__Host-review=; .*Max-Age=0/);
    expect(cleared).not.toContain("__Host-session");
  });

  it("request_changes posts the fixed body", async () => {
    const w = world();
    const s = await start(w, "request_changes");
    const g = fakeGitHub();
    await callback(w, g, s.state, s.cookies);
    expect(JSON.parse(String(reviewCalls(g)[0]!.init!.body))).toEqual({
      commit_id: HEAD,
      event: "REQUEST_CHANGES",
      body: "콘솔에서 수정을 요청했습니다. 자세한 내용은 이 PR에 이어서 남깁니다.",
    });
  });

  it("test_state_mismatch_no_review", async () => {
    const w = world();
    const s = await start(w);
    const g = fakeGitHub();
    const res = await callback(w, g, "x".repeat(43), s.cookies);
    expect(res.headers.get("location")).toBe("/?login=failed");
    expect(g.calls).toEqual([]);
  });

  it("test_login_state_cannot_post_review: a plain login state with a review cookie only signs in", async () => {
    const w = world();
    const s = await start(w);
    const login = await handleRequest(req("/api/auth/login"), w.env);
    const state = new URL(login.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const oauth = pair(cookieOf(login, "__Host-oauth"));
    const review = s.cookies.split("; ")[1]!;
    const g = fakeGitHub();
    const res = await callback(w, g, state, `${oauth}; ${review}`);
    expect(reviewCalls(g)).toEqual([]);
    expect(g.calls.some((c) => c.url.includes("/pulls/"))).toBe(false);
    expect(res.headers.get("location")).toBe("/");
  });

  it("a forged or session-signed review cookie is ignored", async () => {
    const w = world();
    const s = await start(w);
    const forged = await signPayload("another-secret-".repeat(4), "review", {
      state: s.state,
      runId: RUN,
      action: "approve",
      headSha: HEAD,
      userId: OPERATOR_ID,
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    const wrongPurpose = await signPayload(SESSION_SECRET, "other", {
      state: s.state,
      runId: RUN,
      action: "approve",
      headSha: HEAD,
      userId: OPERATOR_ID,
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    for (const v of [forged, wrongPurpose]) {
      const g = fakeGitHub();
      await callback(
        w,
        g,
        s.state,
        `${s.cookies.split("; ")[0]}; __Host-review=${v}`,
      );
      expect(reviewCalls(g)).toEqual([]);
    }
  });

  it("an expired review cookie is ignored", async () => {
    const w = world();
    const s = await start(w);
    const old = await signPayload(SESSION_SECRET, "review", {
      state: s.state,
      runId: RUN,
      action: "approve",
      headSha: HEAD,
      userId: OPERATOR_ID,
      exp: Math.floor(Date.now() / 1000) - 1,
    });
    const g = fakeGitHub();
    await callback(
      w,
      g,
      s.state,
      `${s.cookies.split("; ")[0]}; __Host-review=${old}`,
    );
    expect(reviewCalls(g)).toEqual([]);
  });

  it("test_other_user_denied_no_session_change", async () => {
    const w = world();
    const s = await start(w);
    const g = fakeGitHub({ userId: Number(OBSERVER_ID) });
    const res = await callback(w, g, s.state, s.cookies);
    expect(res.headers.get("location")).toBe(`/runs/${RUN}?review=denied`);
    expect(res.headers.getSetCookie().join("\n")).not.toContain(
      "__Host-session=",
    );
    expect(reviewCalls(g)).toEqual([]);
  });

  it("test_operator_removed_denied", async () => {
    const w = world();
    const s = await start(w);
    w.env.OPERATOR_IDS = "999";
    const g = fakeGitHub();
    const res = await callback(w, g, s.state, s.cookies);
    expect(res.headers.get("location")).toBe(`/runs/${RUN}?review=denied`);
    expect(reviewCalls(g)).toEqual([]);
  });

  it("is stale when the stored head, the live head or the state moved", async () => {
    for (const change of ["store", "live", "state"] as const) {
      const w = world();
      const s = await start(w);
      if (change === "store")
        w.exec(`UPDATE runs SET head_sha = 'new' WHERE id = '${RUN}'`);
      if (change === "state")
        w.exec(`UPDATE runs SET state = 'merged' WHERE id = '${RUN}'`);
      const g = fakeGitHub(change === "live" ? { live: "moved" } : {});
      const res = await callback(w, g, s.state, s.cookies);
      expect(res.headers.get("location"), change).toBe(
        `/runs/${RUN}?review=stale`,
      );
      expect(reviewCalls(g)).toEqual([]);
    }
  });

  it("GitHub 403 or 404 on posting gives review=failed", async () => {
    for (const status of [403, 404]) {
      const w = world();
      const s = await start(w);
      const res = await callback(
        w,
        fakeGitHub({ reviewStatus: status }),
        s.state,
        s.cookies,
      );
      expect(res.headers.get("location")).toBe(`/runs/${RUN}?review=failed`);
    }
  });

  it("a token whose scopes lack public_repo ends in review=failed without a write", async () => {
    for (const scopes of ["", "read:user", "user:email, gist"]) {
      const w = world();
      const s = await start(w);
      const g = fakeGitHub({ scopes });
      const res = await callback(w, g, s.state, s.cookies);
      expect(res.headers.get("location")).toBe(`/runs/${RUN}?review=failed`);
      expect(reviewCalls(g)).toHaveLength(0);
    }
    const w = world();
    const s = await start(w);
    const g = fakeGitHub({ scopes: "gist, public_repo" });
    const res = await callback(w, g, s.state, s.cookies);
    expect(res.headers.get("location")).toBe(`/runs/${RUN}?review=ok`);
    expect(reviewCalls(g)).toHaveLength(1);
  });

  it("the user denying access gives review=denied", async () => {
    const w = world();
    const s = await start(w);
    const g = fakeGitHub();
    const res = await handleRequest(
      req(`/api/auth/callback?error=access_denied&state=${s.state}`, {
        cookie: s.cookies,
      }),
      w.env,
      deps(g),
    );
    expect(res.headers.get("location")).toBe(`/runs/${RUN}?review=denied`);
    expect(g.calls).toEqual([]);
  });

  it("test_token_absent_from_response_and_logs", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    for (const status of [200, 403]) {
      const w = world();
      const s = await start(w);
      const res = await callback(
        w,
        fakeGitHub({ reviewStatus: status }),
        s.state,
        s.cookies,
      );
      const seen = [
        ...[...res.headers.entries()].map(([k, v]) => `${k}: ${v}`),
        await res.text(),
        JSON.stringify(log.mock.calls),
      ].join("\n");
      expect(seen).not.toContain(TOKEN);
    }
  });

  it("an exception inside logs only its class", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const w = world();
    const s = await start(w);
    const g = fakeGitHub();
    const boom = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/pulls/40"))
        throw new TypeError(`x ${TOKEN}`);
      return g.fetch(input, init);
    }) as typeof fetch;
    const res = await callback(
      w,
      { calls: g.calls, fetch: boom },
      s.state,
      s.cookies,
    );
    expect(res.headers.get("location")).toBe(`/runs/${RUN}?review=failed`);
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(log.mock.calls)).toContain("TypeError");
  });
});

describe("plain login", () => {
  it("is unchanged: no scope, and the session cookie is set", async () => {
    const w = world();
    const login = await handleRequest(req("/api/auth/login"), w.env);
    const url = new URL(login.headers.get("location")!);
    expect(url.searchParams.has("scope")).toBe(false);
    const g = fakeGitHub({ userId: Number(OBSERVER_ID) });
    const res = await callback(
      w,
      g,
      url.searchParams.get("state")!,
      pair(cookieOf(login, "__Host-oauth")),
    );
    expect(res.headers.get("location")).toBe("/");
    expect(cookieOf(res, "__Host-session")).toBeDefined();
  });
});
