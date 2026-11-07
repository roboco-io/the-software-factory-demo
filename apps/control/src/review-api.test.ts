import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunDetail } from "./run-query";
import {
  completeReview,
  handleReviewRequest,
  type ReviewDeps,
} from "./review-api";
import { signToken, verifyToken } from "./session";

const getRunMock = vi.hoisted(() => vi.fn());
vi.mock("./run-query", async (importOriginal) => {
  const real = await importOriginal<typeof import("./run-query")>();
  return { ...real, getRun: (...a: unknown[]) => getRunMock(...a) };
});

vi.mock("./session", async (importOriginal) => {
  const real = await importOriginal<typeof import("./session")>();
  const sign = async (p: object, _s: string, now: number, ttl: number) =>
    btoa(JSON.stringify({ ...p, exp: now + ttl }));
  const verify = async (
    t: string | undefined,
    s: string | undefined,
    now: number,
  ) => {
    if (!t || !s) return null;
    try {
      const o = JSON.parse(atob(t));
      return o.exp > now ? o : null;
    } catch {
      return null;
    }
  };
  return {
    ...real,
    signToken: sign,
    verifyToken: verify,
    readUser: async (c: string | null, s: string | undefined, now: number) => {
      const m = /factory_session=([^;]+)/.exec(c ?? "");
      const o = await verify(m?.[1], s, now);
      return o ? { id: String(o.id), login: String(o.login) } : null;
    },
    roleOf: (u: { id: string } | null, ids: readonly string[]) =>
      !u ? "anonymous" : ids.includes(u.id) ? "operator" : "observer",
  };
});

const NOW = 1_000_000;
const SECRET = "s3cret";
const ORIGIN = "https://factory.example";
const APPROVE_BODY = "콘솔에서 운영자가 승인했습니다.";
const CHANGES_BODY =
  "콘솔에서 수정을 요청했습니다. 자세한 내용은 이 PR에 이어서 남깁니다.";

function run(over: Partial<RunDetail> = {}): RunDetail {
  return {
    id: "r1",
    repo: "o/pub",
    issueNumber: 1,
    title: "t",
    tier: "low",
    state: "awaiting_approval",
    reasonCode: null,
    prNumber: 7,
    headSha: "abc",
    createdAt: 1,
    updatedAt: 2,
    bucket: "attention",
    cost: {
      status: "not_measured",
      totalUsd: null,
      implementUsd: null,
      reviewUsd: null,
    },
    events: [],
    ...over,
  };
}

function makeDeps(over: Partial<ReviewDeps> = {}) {
  const github = {
    getPullHead: vi.fn(async () => ({ headSha: "abc", open: true })),
    postReview: vi.fn(async () => {}),
  };
  const deps: ReviewDeps = {
    db: {} as never,
    publicRepos: ["o/pub"],
    operatorIds: ["1"],
    sessionSecret: SECRET,
    clientId: "cid",
    github,
    now: () => NOW,
    origin: ORIGIN,
    ...over,
  };
  return { deps, github };
}

async function cookieFor(id: string) {
  return `factory_session=${await signToken({ id, login: "u" + id }, SECRET, NOW, 60_000)}`;
}

async function post(
  deps: ReviewDeps,
  o: {
    user?: string;
    origin?: string | null;
    ct?: string | null;
    body?: unknown;
    id?: string;
  } = {},
) {
  const headers: Record<string, string> = {};
  if (o.origin !== null) headers.origin = o.origin ?? ORIGIN;
  if (o.ct !== null) headers["content-type"] = o.ct ?? "application/json";
  if (o.user) headers.cookie = await cookieFor(o.user);
  const body =
    o.body === undefined ? { action: "approve", headSha: "abc" } : o.body;
  return handleReviewRequest(
    new Request(`${ORIGIN}/api/runs/${o.id ?? "r1"}/review`, {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    deps,
  );
}

beforeEach(() => {
  getRunMock.mockReset();
  getRunMock.mockResolvedValue(run());
});

describe("handleReviewRequest", () => {
  it("anonymous -> 401 login_required", async () => {
    const { deps } = makeDeps();
    const res = await post(deps);
    expect(res?.status).toBe(401);
    expect(await res?.json()).toEqual({ error: "login_required" });
  });

  it("observer -> 403 forbidden", async () => {
    const { deps } = makeDeps();
    const res = await post(deps, { user: "2" });
    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({ error: "forbidden" });
  });

  it("operator, displayed head differs -> 409 head_changed", async () => {
    const { deps } = makeDeps();
    const res = await post(deps, {
      user: "1",
      body: { action: "approve", headSha: "zzz" },
    });
    expect(res?.status).toBe(409);
    expect(await res?.json()).toEqual({ error: "head_changed" });
  });

  it("operator, matching -> 200 redirect with state and nonce cookie", async () => {
    const { deps, github } = makeDeps();
    const res = await post(deps, { user: "1" });
    expect(res?.status).toBe(200);
    const { redirect } = (await res!.json()) as { redirect: string };
    const u = new URL(redirect);
    expect(u.origin + u.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(u.searchParams.get("client_id")).toBe("cid");
    expect(u.searchParams.get("scope")).toBe("");
    expect(u.searchParams.get("redirect_uri")).toBe(
      `${deps.origin}/api/auth/callback`,
    );
    const st = await verifyToken(
      u.searchParams.get("state") ?? undefined,
      SECRET,
      NOW,
    );
    expect(st).toMatchObject({
      kind: "review",
      runId: "r1",
      action: "approve",
      headSha: "abc",
      userId: "1",
    });
    expect(st!.exp).toBe(NOW + 600_000);
    const setCookie = res!.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`factory_oauth=${st!.nonce}`);
    expect(setCookie).toContain("HttpOnly");
    expect(github.postReview).not.toHaveBeenCalled();
  });

  it("test_denied_no_github_call", async () => {
    const { deps, github } = makeDeps();
    await post(deps);
    await post(deps, { user: "2" });
    expect(
      (await post(deps, { user: "1", origin: "https://evil.example" }))?.status,
    ).toBe(403);
    expect((await post(deps, { user: "1", origin: null }))?.status).toBe(403);
    expect((await post(deps, { user: "1", ct: "text/plain" }))?.status).toBe(
      415,
    );
    expect((await post(deps, { user: "1", ct: null }))?.status).toBe(415);
    expect(github.getPullHead).not.toHaveBeenCalled();
    expect(github.postReview).not.toHaveBeenCalled();
  });

  it("test_private_repo_404", async () => {
    getRunMock.mockResolvedValue(null);
    const { deps } = makeDeps({ publicRepos: [] });
    const res = await post(deps, { user: "1" });
    expect(res?.status).toBe(404);
  });

  it("test_not_awaiting_approval_409", async () => {
    getRunMock.mockResolvedValue(run({ state: "reviewing" }));
    const { deps } = makeDeps();
    const res = await post(deps, { user: "1" });
    expect(res?.status).toBe(409);
    expect(await res?.json()).toEqual({ error: "not_awaiting_approval" });
  });

  it("test_bad_action_400", async () => {
    const { deps } = makeDeps();
    for (const body of [
      { action: "merge", headSha: "abc" },
      { headSha: "abc" },
      { action: "approve" },
      "not json",
    ]) {
      expect((await post(deps, { user: "1", body }))?.status).toBe(400);
    }
  });

  it("no client id -> 503", async () => {
    const { deps } = makeDeps({ clientId: undefined });
    expect((await post(deps, { user: "1" }))?.status).toBe(503);
  });

  it("other paths and methods return null", async () => {
    const { deps } = makeDeps();
    expect(
      await handleReviewRequest(new Request(`${ORIGIN}/api/runs`), deps),
    ).toBeNull();
    expect(
      await handleReviewRequest(
        new Request(`${ORIGIN}/api/runs/r1/review`),
        deps,
      ),
    ).toBeNull();
  });
});

describe("completeReview", () => {
  const intent = {
    runId: "r1",
    action: "approve" as const,
    headSha: "abc",
    userId: "1",
  };

  it("completeReview with moved head -> stale", async () => {
    const { deps, github } = makeDeps();
    github.getPullHead.mockResolvedValue({ headSha: "new", open: true });
    expect(await completeReview(deps, intent, "t")).toBe("stale");
    expect(github.postReview).not.toHaveBeenCalled();
  });

  it("closed PR is stale", async () => {
    const { deps, github } = makeDeps();
    github.getPullHead.mockResolvedValue({ headSha: "abc", open: false });
    expect(await completeReview(deps, intent, "t")).toBe("stale");
  });

  it("approve posts APPROVE on the displayed commit", async () => {
    const { deps, github } = makeDeps();
    expect(await completeReview(deps, intent, "t")).toBe("ok");
    expect(github.postReview).toHaveBeenCalledWith("t", "o/pub", 7, {
      commitId: "abc",
      event: "APPROVE",
      body: APPROVE_BODY,
    });
  });

  it("request_changes posts REQUEST_CHANGES with the fixed body", async () => {
    const { deps, github } = makeDeps();
    expect(
      await completeReview(deps, { ...intent, action: "request_changes" }, "t"),
    ).toBe("ok");
    expect(github.postReview).toHaveBeenCalledWith("t", "o/pub", 7, {
      commitId: "abc",
      event: "REQUEST_CHANGES",
      body: CHANGES_BODY,
    });
  });

  it("test_operator_removed_denied", async () => {
    const { deps, github } = makeDeps({ operatorIds: ["9"] });
    expect(await completeReview(deps, intent, "t")).toBe("denied");
    expect(github.getPullHead).not.toHaveBeenCalled();
    expect(github.postReview).not.toHaveBeenCalled();
  });

  it("run no longer awaiting approval -> stale", async () => {
    getRunMock.mockResolvedValue(run({ state: "merged" }));
    const { deps, github } = makeDeps();
    expect(await completeReview(deps, intent, "t")).toBe("stale");
    expect(github.postReview).not.toHaveBeenCalled();
  });

  it("missing run or GitHub errors -> failed", async () => {
    const a = makeDeps();
    getRunMock.mockResolvedValue(null);
    expect(await completeReview(a.deps, intent, "t")).toBe("failed");
    getRunMock.mockResolvedValue(run());
    const b = makeDeps();
    b.github.postReview.mockRejectedValue(new Error("x"));
    expect(await completeReview(b.deps, intent, "t")).toBe("failed");
    const c = makeDeps();
    c.github.getPullHead.mockRejectedValue(new Error("x"));
    expect(await completeReview(c.deps, intent, "t")).toBe("failed");
  });
});
