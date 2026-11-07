import { describe, expect, it } from "vitest";
import { handleRequest } from "./app";
import { operatorStanding } from "./decision";
import { signToken } from "./session";
import { createTestD1, readMigrations } from "./testing/d1";
import { sign } from "./testing/sign";

const NOW = 1_700_000_000_000;
const ORIGIN = "https://factory.test";
const SECRET = "sess-secret";

function world(repo = "o/pub") {
  const t = createTestD1(readMigrations());
  t.exec(
    `INSERT INTO runs (id, repo, issue_number, state, pr_number, created_at, updated_at, head_sha)
     VALUES ('r1', '${repo}', 1, 'awaiting_approval', 7, ${NOW - 10}, ${NOW - 5}, 'abc')`,
  );
  const env = {
    DB: t.d1 as never,
    PUBLIC_REPOS: "o/pub",
    OPERATOR_IDS: "1",
    GITHUB_OAUTH_CLIENT_ID: "cid",
    GITHUB_OAUTH_CLIENT_SECRET: "csecret",
    SESSION_SECRET: SECRET,
  };
  return env;
}

const cookie = async (id: string) =>
  `factory_session=${await signToken({ id, login: `u${id}` }, SECRET, NOW, 60_000)}`;

function fakeFetch(calls: { url: string; init?: RequestInit }[]) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const j = (b: unknown) =>
      new Response(JSON.stringify(b), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (url.endsWith("/access_token")) return j({ access_token: "utok" });
    if (url.endsWith("/user")) return j({ id: 1, login: "u1" });
    if (url.endsWith("/pulls/7"))
      return j({ state: "open", head: { sha: "abc" } });
    if (url.endsWith("/pulls/7/reviews")) return j({ id: 9 });
    return new Response("no", { status: 500 });
  }) as typeof fetch;
}

const postReview = async (env: object, user: string, calls: never[]) =>
  handleRequest(
    new Request(`${ORIGIN}/api/runs/r1/review`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        cookie: await cookie(user),
      },
      body: JSON.stringify({ action: "approve", headSha: "abc" }),
    }),
    env,
    { fetch: fakeFetch(calls), now: () => NOW },
  );

const get = (path: string, method = "GET") =>
  handleRequest(new Request(`https://factory.test${path}`, { method }));

describe("control API", () => {
  it("reports health as JSON without caching", async () => {
    const res = await get("/api/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("rejects non-GET health requests", async () => {
    const res = await get("/api/health", "POST");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });

  it("returns a JSON 404 for unknown API paths", async () => {
    const res = await get("/api/unknown");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("existing health and webhook routes unchanged", async () => {
    for (const path of ["/api/events", "/api/github", "/api/runs/1/x/y"]) {
      expect((await get(path)).status).toBe(404);
    }
    const health = await get("/api/health");
    expect(await health.text()).toBe('{"status":"ok"}');
    expect((await get("/api/github/webhook", "POST")).status).toBe(503);
  });

  it("answers 503 on the webhook when no secret is configured", async () => {
    const res = await get("/api/github/webhook", "POST");
    expect(res.status).toBe(503);
  });

  it("routes a signed, non-actionable webhook to 202 with no bindings needed", async () => {
    const body = new TextEncoder().encode("{}");
    const res = await handleRequest(
      new Request("https://factory.test/api/github/webhook", {
        method: "POST",
        headers: {
          "x-github-event": "ping",
          "x-hub-signature-256": await sign("s3cret", body),
        },
        body,
      }),
      { GITHUB_WEBHOOK_SECRET: "s3cret" },
    );
    expect(res.status).toBe(202);
  });

  it("returns 500 and keeps the delivery retryable when secrets for a run are missing", async () => {
    const claimed = new Set<string>();
    const db = {
      prepare(sql: string) {
        let id = "";
        const stmt = {
          bind: (...v: unknown[]) => ((id = String(v[0])), stmt),
          run: async () => {
            if (sql.startsWith("INSERT OR IGNORE")) {
              const fresh = !claimed.has(id);
              claimed.add(id);
              return { meta: { changes: fresh ? 1 : 0 } };
            }
            claimed.delete(id);
            return { meta: { changes: 1 } };
          },
        };
        return stmt;
      },
      batch: async () => undefined,
    };
    const payload = new TextEncoder().encode(
      JSON.stringify({
        action: "labeled",
        label: { name: "factory:go" },
        sender: { id: 101, login: "alice", type: "User" },
        repository: { full_name: "acme/demo" },
        issue: { number: 1, state: "open", title: "t", body: "b" },
      }),
    );
    const res = await handleRequest(
      new Request("https://factory.test/api/github/webhook", {
        method: "POST",
        headers: {
          "x-github-event": "issues",
          "x-github-delivery": "abc-123",
          "x-hub-signature-256": await sign("s3cret", payload),
        },
        body: payload,
      }),
      {
        GITHUB_WEBHOOK_SECRET: "s3cret",
        RUNS_ENABLED: "true",
        OPERATOR_IDS: "101",
        PROJECTS: "acme/demo",
        DB: db as never,
      },
    );
    expect(res.status).toBe(500);
    expect(claimed.has("abc-123")).toBe(false);
  });

  it("test_no_env_nothing_public: empty env gives empty runs and no 500", async () => {
    const res = await get("/api/runs");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { runs: unknown[] }).runs).toEqual([]);
    expect((await get("/api/runs/r1")).status).toBe(404);
    expect(await (await get("/api/session")).json()).toMatchObject({
      role: "anonymous",
      loginEnabled: false,
    });
    expect((await get("/api/auth/login")).status).toBe(503);
  });

  it("test_private_run_absent_end_to_end", async () => {
    const env = { ...world("o/private") };
    const list = (await (
      await handleRequest(new Request(`${ORIGIN}/api/runs`), env, {
        now: () => NOW,
      })
    ).json()) as { runs: unknown[] };
    expect(list.runs).toEqual([]);
    const one = await handleRequest(new Request(`${ORIGIN}/api/runs/r1`), env, {
      now: () => NOW,
    });
    expect(one.status).toBe(404);
  });

  it("test_session_without_secret_anonymous", async () => {
    const env = { ...world(), SESSION_SECRET: undefined };
    const res = await handleRequest(
      new Request(`${ORIGIN}/api/session`, {
        headers: { cookie: await cookie("1") },
      }),
      env,
      { now: () => NOW },
    );
    expect(await res.json()).toMatchObject({
      role: "anonymous",
      loginEnabled: false,
    });
  });

  it("test_observer_post_denied_end_to_end", async () => {
    const calls: never[] = [];
    const res = await postReview(world(), "2", calls);
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("operator approve flow writes APPROVE on displayed sha with fake GitHub and operatorStanding counts it", async () => {
    const env = world();
    const calls: { url: string; init?: RequestInit }[] = [];
    const first = await postReview(env, "1", calls as never[]);
    expect(first.status).toBe(200);
    const { redirect } = (await first.json()) as { redirect: string };
    const state = new URL(redirect).searchParams.get("state") as string;
    const nonce = /factory_oauth=([^;]+)/.exec(
      first.headers.get("set-cookie") ?? "",
    )?.[1];
    expect(nonce).toBeTruthy();

    const cb = await handleRequest(
      new Request(
        `${ORIGIN}/api/auth/callback?code=c&state=${encodeURIComponent(state)}`,
        {
          headers: { cookie: `factory_oauth=${nonce}` },
        },
      ),
      env,
      { fetch: fakeFetch(calls), now: () => NOW },
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/?run=r1&review=ok");
    const review = calls.find((c) => c.url.endsWith("/pulls/7/reviews"));
    expect(review).toBeDefined();
    const sent = JSON.parse(String(review?.init?.body)) as {
      commit_id: string;
      event: string;
    };
    expect(sent).toMatchObject({ commit_id: "abc", event: "APPROVE" });
    expect(
      operatorStanding(
        [
          {
            userId: "1",
            userType: "User",
            state: "APPROVED",
            commitId: sent.commit_id,
          },
        ] as never,
        { headSha: "abc", operatorIds: ["1"], authorId: null },
      ),
    ).toEqual({ approved: true, blocked: false });
  });
});
