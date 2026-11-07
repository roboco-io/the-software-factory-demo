import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthDeps } from "./auth-api";
import { handleAuth } from "./auth-api";
import { signToken } from "./session";

const completeReview = vi.hoisted(() => vi.fn());
vi.mock("./review-api", () => ({ completeReview }));

const ORIGIN = "https://factory.example";
const SECRET = "test-secret";
const TOKEN = "user-token-xyz";
const NOW = 1_000_000;

function makeDeps(over: Partial<AuthDeps> = {}) {
  const github = {
    exchangeCode: vi.fn(async () => TOKEN),
    getUser: vi.fn(async () => ({ id: "1", login: "op" })),
  };
  const deps: AuthDeps = {
    sessionSecret: SECRET,
    clientId: "cid",
    operatorIds: ["1"],
    github,
    review: {} as AuthDeps["review"],
    now: () => NOW,
    origin: ORIGIN,
    ...over,
  };
  return { deps, github };
}

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, { headers });

async function sessionCookieFor(id: string, login: string): Promise<string> {
  const token = await signToken({ id, login }, SECRET, NOW, 1000 * 60);
  return `factory_session=${token}`;
}

async function reviewState(over: Record<string, unknown> = {}, nonce = "n1") {
  return signToken(
    {
      kind: "review",
      nonce,
      runId: "r1",
      action: "approve",
      headSha: "abc",
      userId: "1",
      ...over,
    },
    SECRET,
    NOW,
    600000,
  );
}

beforeEach(() => completeReview.mockReset());

describe("handleAuth", () => {
  it("anonymous session", async () => {
    const { deps } = makeDeps();
    const res = await handleAuth(get("/api/session"), deps);
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({
      role: "anonymous",
      login: null,
      loginEnabled: true,
    });
  });

  it("session reports operator by numeric id", async () => {
    const { deps } = makeDeps();
    const cookie = await sessionCookieFor("1", "whoever");
    const res = await handleAuth(get("/api/session", { cookie }), deps);
    expect(await res?.json()).toEqual({
      role: "operator",
      login: "whoever",
      loginEnabled: true,
    });
    const other = await sessionCookieFor("2", "operatorname");
    const res2 = await handleAuth(get("/api/session", { cookie: other }), deps);
    expect(((await res2?.json()) as { role: string }).role).toBe("observer");
  });

  it("logout with a foreign Origin is forbidden", async () => {
    const { deps } = makeDeps();
    const res = await handleAuth(
      new Request(`${ORIGIN}/api/auth/logout`, {
        method: "POST",
        headers: { origin: "https://evil.example" },
      }),
      deps,
    );
    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({ error: "forbidden" });
  });

  it("logout clears the cookie", async () => {
    const { deps } = makeDeps();
    const res = await handleAuth(
      new Request(`${ORIGIN}/api/auth/logout`, {
        method: "POST",
        headers: { origin: ORIGIN },
      }),
      deps,
    );
    expect(res?.status).toBe(200);
    expect(res?.headers.get("set-cookie")).toContain("factory_session=;");
    expect(res?.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("other paths return null", async () => {
    const { deps } = makeDeps();
    expect(await handleAuth(get("/api/health"), deps)).toBeNull();
  });

  it("login redirects to github with client_id and state", async () => {
    const { deps } = makeDeps();
    const res = await handleAuth(get("/api/auth/login"), deps);
    expect(res?.status).toBe(302);
    const loc = new URL(res!.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(loc.searchParams.get("client_id")).toBe("cid");
    expect(loc.searchParams.get("state")).toBeTruthy();
    expect(res?.headers.get("set-cookie")).toMatch(
      /^factory_oauth=[0-9a-f]+;.*HttpOnly/,
    );
  });

  it("test_not_configured_503", async () => {
    for (const over of [{ sessionSecret: undefined }, { clientId: "" }]) {
      const { deps } = makeDeps(over);
      expect((await handleAuth(get("/api/auth/login"), deps))?.status).toBe(
        503,
      );
      const s = await handleAuth(get("/api/session"), deps);
      expect(
        ((await s?.json()) as { loginEnabled: boolean }).loginEnabled,
      ).toBe(false);
    }
  });

  it("callback sets session cookie and clears nonce", async () => {
    const { deps, github } = makeDeps();
    const login = await handleAuth(get("/api/auth/login"), deps);
    const nonce = /factory_oauth=([0-9a-f]+)/.exec(
      login!.headers.get("set-cookie")!,
    )![1];
    const state = new URL(login!.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const res = await handleAuth(
      get(`/api/auth/callback?code=c&state=${state}`, {
        cookie: `factory_oauth=${nonce}`,
      }),
      deps,
    );
    expect(res?.status).toBe(302);
    expect(res?.headers.get("location")).toBe("/");
    const cookies = res!.headers.getSetCookie().join("\n");
    expect(cookies).toContain("factory_session=");
    expect(cookies).toMatch(/factory_oauth=;.*Max-Age=0/);
    expect(github.exchangeCode).toHaveBeenCalledWith("c");
  });

  it("test_callback_state_tampered_400", async () => {
    const { deps, github } = makeDeps();
    const state = await reviewState();
    const res = await handleAuth(
      get(`/api/auth/callback?code=c&state=${state}x`, {
        cookie: "factory_oauth=n1",
      }),
      deps,
    );
    expect(res?.status).toBe(400);
    expect(github.exchangeCode).not.toHaveBeenCalled();
  });

  it("test_callback_no_nonce_cookie_400", async () => {
    const { deps, github } = makeDeps();
    const state = await reviewState();
    for (const cookie of [undefined, "factory_oauth=other"]) {
      const res = await handleAuth(
        get(
          `/api/auth/callback?code=c&state=${state}`,
          cookie ? { cookie } : {},
        ),
        deps,
      );
      expect(res?.status).toBe(400);
    }
    expect(github.exchangeCode).not.toHaveBeenCalled();
    expect(github.getUser).not.toHaveBeenCalled();
  });

  it("review callback completes and redirects with the result", async () => {
    completeReview.mockResolvedValue("ok");
    const { deps } = makeDeps();
    const state = await reviewState({ runId: "r/1" });
    const res = await handleAuth(
      get(`/api/auth/callback?code=c&state=${state}`, {
        cookie: "factory_oauth=n1",
      }),
      deps,
    );
    expect(res?.headers.get("location")).toBe("/?run=r%2F1&review=ok");
    expect(completeReview).toHaveBeenCalledWith(
      deps.review,
      { runId: "r/1", action: "approve", headSha: "abc", userId: "1" },
      TOKEN,
    );
  });

  it("test_review_intent_other_user_denied", async () => {
    const { deps } = makeDeps();
    const state = await reviewState({ userId: "99" });
    const res = await handleAuth(
      get(`/api/auth/callback?code=c&state=${state}`, {
        cookie: "factory_oauth=n1",
      }),
      deps,
    );
    expect(completeReview).not.toHaveBeenCalled();
    expect(res?.headers.get("location")).toBe("/?run=r1&review=denied");
    expect(
      res?.headers
        .getSetCookie()
        .some(
          (c) => c.startsWith("factory_session=") && !c.includes("Max-Age=0"),
        ),
    ).toBe(false);
  });

  it("test_token_not_in_response", async () => {
    completeReview.mockResolvedValue("ok");
    const { deps } = makeDeps();
    const state = await reviewState();
    const responses = [
      await handleAuth(
        get(`/api/auth/callback?code=c&state=${state}`, {
          cookie: "factory_oauth=n1",
        }),
        deps,
      ),
    ];
    const failing = makeDeps();
    failing.github.getUser.mockRejectedValue(new Error(`boom ${TOKEN}`));
    responses.push(
      await handleAuth(
        get(`/api/auth/callback?code=c&state=${state}`, {
          cookie: "factory_oauth=n1",
        }),
        failing.deps,
      ),
    );
    for (const res of responses) {
      const dump =
        JSON.stringify([...res!.headers.entries()]) + (await res!.text());
      expect(dump).not.toContain(TOKEN);
    }
    expect(responses[1]!.status).toBe(502);
  });
});
