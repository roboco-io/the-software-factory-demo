import { describe, expect, it } from "vitest";
import { createUserGitHub } from "./github-user";

type Call = { url: string; init: RequestInit };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

function setup(handler: (url: string, init: RequestInit) => Response) {
  const calls: Call[] = [];
  const fetchFake = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({ url: String(url), init: init ?? {} });
    return handler(String(url), init ?? {});
  }) as typeof fetch;
  const gh = createUserGitHub({
    clientId: "cid",
    clientSecret: "SECRET-xyz",
    fetch: fetchFake,
  });
  return { gh, calls };
}

describe("github-user", () => {
  it("exchangeCode returns the access token", async () => {
    const { gh, calls } = setup(() => json({ access_token: "user-token" }));
    expect(await gh.exchangeCode("c")).toBe("user-token");
    expect(calls[0]!.url).toBe("https://github.com/login/oauth/access_token");
    expect(calls[0]!.init.method).toBe("POST");
    const h = new Headers(calls[0]!.init.headers);
    expect(h.get("accept")).toBe("application/json");
  });

  it("getUser returns id and login", async () => {
    const { gh } = setup(() => json({ id: 3435720, login: "op" }));
    expect(await gh.getUser("user-token")).toEqual({
      id: "3435720",
      login: "op",
    });
  });

  it("numeric id becomes string", async () => {
    const { gh } = setup(() => json({ id: 5, login: "x" }));
    expect((await gh.getUser("t")).id).toBe("5");
  });

  it("getPullHead returns head sha and open state", async () => {
    const { gh, calls } = setup(() =>
      json({ state: "open", head: { sha: "abc" } }),
    );
    expect(await gh.getPullHead("user-token", "a/b", 7)).toEqual({
      headSha: "abc",
      open: true,
    });
    expect(calls[0]!.url).toBe("https://api.github.com/repos/a/b/pulls/7");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe(
      "Bearer user-token",
    );
  });

  it("postReview sends commit_id and event", async () => {
    const { gh, calls } = setup(() => json({ id: 1 }));
    await expect(
      gh.postReview("user-token", "a/b", 7, {
        commitId: "abc",
        event: "APPROVE",
        body: "x",
      }),
    ).resolves.toBeUndefined();
    expect(calls[0]!.url).toBe(
      "https://api.github.com/repos/a/b/pulls/7/reviews",
    );
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      commit_id: "abc",
      event: "APPROVE",
      body: "x",
    });
  });

  it("test_exchange_error_body: 200 with error body throws", async () => {
    const { gh } = setup(() => json({ error: "bad_verification_code" }));
    await expect(gh.exchangeCode("c")).rejects.toThrow();
  });

  it("test_errors_hide_token", async () => {
    const msgs: string[] = [];
    const cases: Array<() => Promise<unknown>> = [];
    const bad = setup(() => json({ message: "no user-token SECRET-xyz" }, 401));
    cases.push(
      () => bad.gh.getUser("user-token"),
      () => bad.gh.getPullHead("user-token", "a/b", 7),
      () =>
        bad.gh.postReview("user-token", "a/b", 7, {
          commitId: "a",
          event: "REQUEST_CHANGES",
          body: "b",
        }),
      () => bad.gh.exchangeCode("c"),
    );
    const boom = setup(() => {
      throw new Error("net user-token SECRET-xyz");
    });
    cases.push(
      () => boom.gh.getUser("user-token"),
      () => boom.gh.exchangeCode("c"),
    );
    const err = setup(() =>
      json({ error: "bad", error_description: "SECRET-xyz" }),
    );
    cases.push(() => err.gh.exchangeCode("c"));
    for (const c of cases) {
      try {
        await c();
        msgs.push("NO THROW");
      } catch (e) {
        msgs.push(String((e as Error).message));
      }
    }
    for (const m of msgs) {
      expect(m).not.toBe("NO THROW");
      expect(m).not.toContain("user-token");
      expect(m).not.toContain("SECRET-xyz");
    }
  });
});
