import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRequest, type AppDeps } from "./app";
import { SESSION_COOKIE, verifySession } from "./session";
import {
  CLIENT_ID,
  CLIENT_SECRET,
  ORIGIN,
  SESSION_SECRET,
  makeWorld,
  req,
} from "./testing/api-world";

const TOKEN = "test-oauth-token-sentinel-not-real";

afterEach(() => vi.restoreAllMocks());

interface Fake {
  calls: { url: string; init: RequestInit | undefined }[];
  fetch: typeof fetch;
}
/** A fake GitHub. `token` and `user` are the JSON bodies of the two answers. */
function fakeGitHub(
  o: {
    token?: unknown;
    tokenStatus?: number;
    user?: unknown;
    userStatus?: number;
    throwOn?: "token" | "user";
  } = {},
): Fake {
  const calls: Fake["calls"] = [];
  const f = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "https://github.com/login/oauth/access_token") {
      if (o.throwOn === "token") throw new Error(`boom ${TOKEN}`);
      return Response.json(
        o.token ?? { access_token: TOKEN, token_type: "bearer", scope: "" },
        { status: o.tokenStatus ?? 200 },
      );
    }
    if (url === "https://api.github.com/user") {
      if (o.throwOn === "user") throw new Error(`boom ${TOKEN}`);
      return Response.json(
        "user" in o
          ? o.user
          : {
              id: 555,
              login: "visitor",
              name: "Real Name",
              email: "a@b.c",
              avatar_url: "x",
            },
        { status: o.userStatus ?? 200 },
      );
    }
    return new Response("unexpected", { status: 500 });
  };
  return { calls, fetch: f as typeof fetch };
}

const deps = (fake: Fake): AppDeps => ({ fetch: fake.fetch });
const setCookies = (res: Response) => res.headers.getSetCookie();
const cookieNamed = (res: Response, name: string) =>
  setCookies(res).find((c) => c.startsWith(`${name}=`));

/** Runs the login step and returns the state, the challenge and the cookie to send back. */
async function login(env: ReturnType<typeof makeWorld>["env"]) {
  const res = await handleRequest(req("/api/auth/login"), env);
  const location = new URL(res.headers.get("location")!);
  const set = cookieNamed(res, "__Host-oauth")!;
  return {
    res,
    location,
    state: location.searchParams.get("state")!,
    cookie: set.split(";")[0]!,
    set,
  };
}
const callback = (
  env: ReturnType<typeof makeWorld>["env"],
  query: string,
  cookie: string | undefined,
  fake: Fake,
) =>
  handleRequest(
    req(`/api/auth/callback?${query}`, cookie ? { cookie } : {}),
    env,
    deps(fake),
  );

describe("login", () => {
  it("redirects to GitHub with a random state and a PKCE S256 challenge, and no scope", async () => {
    const w = makeWorld();
    const a = await login(w.env);
    const b = await login(w.env);
    expect(a.res.status).toBe(302);
    expect(a.location.origin + a.location.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    const p = a.location.searchParams;
    expect(p.get("client_id")).toBe(CLIENT_ID);
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.has("scope")).toBe(false);
    expect(p.get("state")).not.toBe(b.location.searchParams.get("state"));
    expect(a.res.headers.get("cache-control")).toBe("no-store");
  });

  it("stores state and verifier in a short-lived __Host- cookie, and the challenge is the hash of the verifier", async () => {
    const w = makeWorld();
    const a = await login(w.env);
    expect(a.set).toMatch(
      /^__Host-oauth=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/,
    );
    const [state, verifier] = a.cookie.split("=")[1]!.split(".") as [
      string,
      string,
    ];
    expect(state).toBe(a.state);
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    );
    const challenge = btoa(String.fromCharCode(...digest))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(a.location.searchParams.get("code_challenge")).toBe(challenge);
    // The verifier itself never goes to GitHub at this step.
    expect(a.location.toString()).not.toContain(verifier);
  });

  it("answers 503 auth_not_configured when any setting is missing, while read APIs keep working", async () => {
    for (const missing of [
      "GITHUB_OAUTH_CLIENT_ID",
      "GITHUB_OAUTH_CLIENT_SECRET",
      "SESSION_SECRET",
    ] as const) {
      const w = makeWorld({ [missing]: "" });
      const res = await handleRequest(req("/api/auth/login"), w.env);
      expect(res.status, missing).toBe(503);
      expect(await res.json()).toEqual({ error: "auth_not_configured" });
      expect((await handleRequest(req("/api/me"), w.env)).status).toBe(200);
      expect((await handleRequest(req("/api/projects"), w.env)).status).toBe(
        200,
      );
    }
    const short = makeWorld({ SESSION_SECRET: "too-short" });
    expect(
      (await handleRequest(req("/api/auth/login"), short.env)).status,
    ).toBe(503);
    const cb = await handleRequest(
      req("/api/auth/callback?code=x&state=y"),
      makeWorld({ SESSION_SECRET: "" }).env,
    );
    expect(cb.status).toBe(503);
  });
});

describe("callback", () => {
  it("exchanges the code with the verifier, keeps only id and login, and sets the session", async () => {
    const w = makeWorld();
    const l = await login(w.env);
    const fake = fakeGitHub();
    const res = await callback(
      w.env,
      `code=abc123&state=${l.state}`,
      l.cookie,
      fake,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const session = cookieNamed(res, SESSION_COOKIE)!;
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/Secure/);
    expect(session).toMatch(/SameSite=Lax/);
    expect(session).toMatch(/Path=\//);
    expect(session).toMatch(/Max-Age=604800/);
    expect(session).not.toMatch(/Domain/);
    const value = session.split(";")[0]!.split("=")[1]!;
    const now = Math.floor(Date.now() / 1000);
    const parsed = await verifySession(SESSION_SECRET, value, now);
    expect(parsed).toMatchObject({ id: "555", login: "visitor" });
    expect(parsed!.exp).toBeGreaterThan(now + 7 * 86400 - 60);
    expect(parsed!.exp).toBeLessThanOrEqual(now + 7 * 86400 + 5);
    // The payload holds nothing else: no name, email, token.
    const payload = atob(
      value.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/"),
    );
    expect(Object.keys(JSON.parse(payload)).sort()).toEqual([
      "exp",
      "id",
      "login",
    ]);
    // The one-time cookie is cleared.
    expect(cookieNamed(res, "__Host-oauth")).toMatch(/Max-Age=0/);
    // The token request carried the verifier and the secret, in a POST body.
    const [tokenCall, userCall] = fake.calls;
    expect(tokenCall!.init?.method).toBe("POST");
    const body = JSON.parse(String(tokenCall!.init?.body));
    expect(body).toMatchObject({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: "abc123",
    });
    expect(body.code_verifier).toBe(l.cookie.split("=")[1]!.split(".")[1]);
    expect(tokenCall!.url).not.toContain(CLIENT_SECRET);
    expect(new Headers(userCall!.init?.headers).get("authorization")).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(new Headers(userCall!.init?.headers).get("user-agent")).toBeTruthy();
  });

  it("makes the new user an operator only through OPERATOR_IDS, and a session works on /api/me", async () => {
    const w = makeWorld({ OPERATOR_IDS: "555" });
    const l = await login(w.env);
    const res = await callback(
      w.env,
      `code=abc&state=${l.state}`,
      l.cookie,
      fakeGitHub(),
    );
    const cookie = cookieNamed(res, SESSION_COOKIE)!.split(";")[0]!;
    const me = await handleRequest(req("/api/me", { cookie }), w.env);
    expect(await me.json()).toEqual({ role: "operator", login: "visitor" });
    w.env.OPERATOR_IDS = "";
    const again = await handleRequest(req("/api/me", { cookie }), w.env);
    expect(await again.json()).toEqual({ role: "observer", login: "visitor" });
  });

  it("never stores, logs or returns the token or the client secret", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = makeWorld();
    const seen: string[] = [];
    for (const o of [
      {},
      { throwOn: "token" as const },
      { throwOn: "user" as const },
      { tokenStatus: 500 },
      { userStatus: 401 },
      { token: { error: "bad_verification_code" } },
    ]) {
      const l = await login(w.env);
      const res = await callback(
        w.env,
        `code=abc&state=${l.state}`,
        l.cookie,
        fakeGitHub(o),
      );
      seen.push(
        res.headers.get("location") ?? "",
        ...setCookies(res).map((c) =>
          c.split(";")[0]!.split("=").slice(1).join("="),
        ),
        await res.text(),
      );
    }
    const logs = JSON.stringify([
      ...log.mock.calls,
      ...err.mock.calls,
      ...warn.mock.calls,
    ]);
    for (const text of [logs, seen.join("\n"), w.snapshot()]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(CLIENT_SECRET);
      expect(text).not.toContain("SENTINELtoken");
    }
    // The failures were logged with fixed event names and codes only.
    for (const call of log.mock.calls) {
      const entry = JSON.parse(String(call[0]));
      expect(entry.event).toBe("auth_callback_failed");
      expect(entry.reason).toMatch(/^[a-z_]+$/);
    }
    expect(log.mock.calls.length).toBe(5);
  });

  it("redirects to /?login=failed on a state mismatch, a missing cookie, a missing code or a GitHub error", async () => {
    const w = makeWorld();
    const l = await login(w.env);
    const fake = fakeGitHub();
    const cases: [string, string | undefined][] = [
      [`code=abc&state=${"A".repeat(43)}`, l.cookie],
      [`code=abc&state=${l.state}`, undefined],
      [`code=abc&state=${l.state}`, "__Host-oauth=garbage"],
      [`state=${l.state}`, l.cookie],
      [`code=abc`, l.cookie],
      [`error=access_denied&state=${l.state}`, l.cookie],
      [`code=${"x".repeat(300)}&state=${l.state}`, l.cookie],
      [`code=a%20b&state=${l.state}`, l.cookie],
      ["", undefined],
    ];
    vi.spyOn(console, "log").mockImplementation(() => {});
    for (const [query, cookie] of cases) {
      const res = await callback(w.env, query, cookie, fake);
      expect(res.status, query).toBe(302);
      expect(res.headers.get("location"), query).toBe("/?login=failed");
      expect(cookieNamed(res, SESSION_COOKIE)).toBeUndefined();
    }
    expect(fake.calls).toEqual([]);
  });

  it("fails closed on bad GitHub answers and validates their shape", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const w = makeWorld();
    const bad = [
      { token: { error: "bad_verification_code" } },
      { token: { access_token: "" } },
      { token: { access_token: 12 } },
      { token: "text" },
      { tokenStatus: 500 },
      { throwOn: "token" as const },
      { user: { id: "555", login: "visitor" } },
      { user: { id: 0, login: "visitor" } },
      { user: { id: 1.5, login: "visitor" } },
      { user: { id: 555, login: "bad login!" } },
      { user: { id: 555 } },
      { user: null },
      { user: [] },
      { userStatus: 403 },
      { throwOn: "user" as const },
    ];
    for (const o of bad) {
      const l = await login(w.env);
      const res = await callback(
        w.env,
        `code=abc&state=${l.state}`,
        l.cookie,
        fakeGitHub(o),
      );
      expect(res.headers.get("location"), JSON.stringify(o)).toBe(
        "/?login=failed",
      );
      expect(cookieNamed(res, SESSION_COOKIE)).toBeUndefined();
    }
  });

  it("clears the one-time cookie on every outcome", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const w = makeWorld();
    const l = await login(w.env);
    const res = await callback(
      w.env,
      `code=abc&state=wrong`,
      l.cookie,
      fakeGitHub(),
    );
    expect(cookieNamed(res, "__Host-oauth")).toMatch(/Max-Age=0/);
  });
});

describe("logout", () => {
  it("clears the session cookie for any caller and needs a same-origin request", async () => {
    const w = makeWorld();
    const res = await handleRequest(
      req("/api/auth/logout", { method: "POST" }),
      w.env,
    );
    expect(res.status).toBe(200);
    expect(cookieNamed(res, SESSION_COOKIE)).toBe(
      "__Host-session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    );
    const foreign = await handleRequest(
      req("/api/auth/logout", {
        method: "POST",
        origin: "https://evil.example",
      }),
      w.env,
    );
    expect(foreign.status).toBe(403);
    expect(cookieNamed(foreign, SESSION_COOKIE)).toBeUndefined();
  });
});

void ORIGIN;
