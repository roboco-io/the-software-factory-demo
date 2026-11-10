import { describe, expect, it, vi } from "vitest";
import { ApiError, createApi, startLogin } from "./api";

const reply = (status: number, body: unknown) =>
  (async () => Response.json(body, { status })) as unknown as typeof fetch;

describe("createApi", () => {
  it("returns parsed JSON and sends a POST for stop and logout", async () => {
    const fetchFn = vi.fn(async () => Response.json({ role: "anonymous" }));
    const api = createApi(fetchFn as unknown as typeof fetch);
    expect(await api.me()).toEqual({ role: "anonymous" });
    await api.stop("abc");
    await api.logout();
    expect(fetchFn).toHaveBeenCalledWith(
      "/api/runs/abc/stop",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchFn).toHaveBeenCalledWith(
      "/api/auth/logout",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("sends the budget limits as JSON in a POST", async () => {
    const fetchFn = vi.fn(async () => Response.json({}));
    const api = createApi(fetchFn as unknown as typeof fetch);
    await api.setBudgetLimits({ anthropicUsd: 40, openaiUsd: 0, runCapUsd: 3 });
    expect(fetchFn).toHaveBeenCalledWith(
      "/api/budget/limits",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ anthropicUsd: 40, openaiUsd: 0, runCapUsd: 3 }),
      }),
    );
  });

  it("turns an error answer into an ApiError with the status and fixed code", async () => {
    const api = createApi(reply(409, { error: "merge_attempted" }));
    await expect(api.stop("abc")).rejects.toMatchObject({
      status: 409,
      code: "merge_attempted",
    });
    await expect(createApi(reply(500, "text")).run("x")).rejects.toBeInstanceOf(
      ApiError,
    );
    const down = createApi((async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch);
    await expect(down.me()).rejects.toMatchObject({
      status: 0,
      code: "network",
    });
  });

  it("pages runs with a limit and a cursor", async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({ runs: [], nextCursor: null }),
    );
    await createApi(fetchFn as unknown as typeof fetch).runs(
      "acme/demo",
      "1_ab",
    );
    expect(String((fetchFn.mock.calls[0] as unknown[])[0])).toBe(
      "/api/projects/acme/demo/runs?limit=20&cursor=1_ab",
    );
  });
});

describe("review", () => {
  it("posts JSON with the action and the displayed commit, and returns the redirect", async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({ redirect: "https://github.com/login/oauth/authorize?x" }),
    );
    const api = createApi(fetchFn as unknown as typeof fetch);
    expect(await api.review("r 1", "approve", "abc")).toBe(
      "https://github.com/login/oauth/authorize?x",
    );
    const [path, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(path).toBe("/api/runs/r%201/review");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      action: "approve",
      headSha: "abc",
    });
  });

  it("turns a 409 into an ApiError with the code, and rejects an answer without redirect", async () => {
    await expect(
      createApi(reply(409, { error: "head_changed" })).review(
        "r",
        "approve",
        "a",
      ),
    ).rejects.toMatchObject({ status: 409, code: "head_changed" });
    await expect(
      createApi(reply(200, {})).review("r", "approve", "a"),
    ).rejects.toMatchObject({ code: "bad_response" });
  });
});

describe("startLogin", () => {
  it("navigates to the login route when sign-in is set up", async () => {
    const go = vi.fn();
    await startLogin(
      (async () =>
        new Response(null, { status: 302 })) as unknown as typeof fetch,
      go,
    );
    expect(go).toHaveBeenCalledWith("/api/auth/login");
  });

  it("reports a missing configuration instead of navigating", async () => {
    const go = vi.fn();
    await expect(
      startLogin(reply(503, { error: "auth_not_configured" }), go),
    ).rejects.toMatchObject({ status: 503 });
    expect(go).not.toHaveBeenCalled();
  });
});
