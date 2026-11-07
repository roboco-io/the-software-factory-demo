import { describe, expect, it } from "vitest";
import {
  ago,
  explain,
  fetchConsole,
  fetchRun,
  money,
  sendReview,
  stageOf,
  stageForRun,
} from "./console-model";

const REASON_CODES = [
  "empty_change",
  "too_many_files",
  "total_too_large",
  "file_too_large",
  "forbidden_path",
  "absolute_path",
  "path_traversal",
  "symlink",
  "submodule",
  "special_file",
  "path_not_utf8",
  "path_control_char",
  "malformed_output",
  "timeout",
  "agent_failed",
  "agent_timeout",
  "sandbox_lost",
  "clone_failed",
  "publish_failed",
  "internal_error",
  "cleanup_failed",
  "legacy_run",
  "pr_closed",
  "base_not_default",
  "head_changed",
  "policy_missing",
  "policy_invalid",
  "files_truncated",
  "diff_too_large",
  "review_failed",
  "review_invalid",
  "changes_requested",
  "check_failed",
  "checks_timeout",
  "checks_permission_missing",
  "operator_changes_requested",
  "approval_timeout",
  "merge_refused",
  "merge_conflict",
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("stageOf", () => {
  it("maps states", () => {
    expect(stageOf("queued")).toBe(0);
    expect(stageOf("awaiting_approval")).toBe(4);
    expect(stageOf("merged")).toBe(5);
    expect(stageOf("needs_human")).toBe(5);
  });
  it("stopped run keeps stage of last transition", () => {
    const events = [
      {
        ts: 1,
        kind: "transition",
        fromState: "queued",
        toState: "implementing",
        reasonCode: null,
      },
      {
        ts: 2,
        kind: "transition",
        fromState: "implementing",
        toState: "needs_human",
        reasonCode: "x",
      },
    ];
    expect(stageForRun({ state: "needs_human" }, events)).toBe(1);
    expect(stageForRun({ state: "failed" })).toBe(5);
    expect(stageForRun({ state: "reviewing" }, events)).toBe(2);
  });
});

describe("explain", () => {
  it("known examples", () => {
    expect(
      explain({
        state: "needs_human",
        reasonCode: "changes_requested",
        tier: "T2",
      }),
    ).toBe("교차 리뷰가 변경을 요청해 자동 처리를 멈췄습니다.");
    expect(
      explain({ state: "failed", reasonCode: "brand_new_code", tier: null }),
    ).toBe("실행이 실패했습니다. 사유 코드: brand_new_code");
  });
  it("test_every_reason_code_explained", () => {
    const seen = new Set<string>();
    for (const code of REASON_CODES) {
      const s = explain({ state: "needs_human", reasonCode: code, tier: null });
      expect(s, code).not.toContain(code);
      expect(s.length).toBeGreaterThan(5);
      expect(seen.has(s), `duplicate for ${code}`).toBe(false);
      seen.add(s);
    }
  });
  it("states without reason", () => {
    expect(
      explain({ state: "merged", reasonCode: null, tier: "T1" }),
    ).toContain("병합");
    expect(
      explain({ state: "awaiting_approval", reasonCode: null, tier: "T2" }),
    ).toContain("승인");
    expect(
      explain({ state: "implementing", reasonCode: null, tier: null }).length,
    ).toBeGreaterThan(3);
  });
});

describe("money", () => {
  it("formats", () => {
    expect(money({ status: "not_measured", totalUsd: null })).toBe("측정 전");
    expect(money({ status: "unknown", totalUsd: null })).toBe("계산 불가");
    expect(money({ status: "measured", totalUsd: 0.47 })).toBe("$0.47");
    expect(money({ status: "measured", totalUsd: 0 })).toBe("$0.00");
  });
});

describe("ago", () => {
  it("formats minutes and hours", () => {
    const now = 10_000_000_000;
    expect(ago(now - 10_000, now)).toBe("방금");
    expect(ago(now - 5 * 60_000, now)).toBe("5분 전");
    expect(ago(now - 3 * 3_600_000, now)).toBe("3시간 전");
    expect(ago(now - 50 * 3_600_000, now)).toBe("2일 전");
  });
});

describe("fetchConsole", () => {
  it("empty", async () => {
    const f = (async (url: string) =>
      String(url).endsWith("/api/session")
        ? json({ role: "anonymous", login: null, loginEnabled: false })
        : json({
            runs: [],
            totals: { attention: 0, active: 0, done: 0, usd: 0 },
          })) as unknown as typeof fetch;
    expect(await fetchConsole(f)).toEqual({
      runs: [],
      totals: { attention: 0, active: 0, done: 0, usd: 0 },
      session: { role: "anonymous", login: null, loginEnabled: false },
    });
  });
  it("test_fetch_error_rejects", async () => {
    const f = (async () =>
      json({ error: "x" }, 500)) as unknown as typeof fetch;
    await expect(fetchConsole(f)).rejects.toThrow();
    await expect(fetchRun(f, "r1")).rejects.toThrow();
  });
  it("fetchRun encodes id and returns null on 404", async () => {
    const urls: string[] = [];
    const f = (async (u: string) => (
      urls.push(String(u)),
      json({ error: "not_found" }, 404)
    )) as unknown as typeof fetch;
    expect(await fetchRun(f, "a/b")).toBeNull();
    expect(urls[0]).toBe("/api/runs/a%2Fb");
  });
});

describe("sendReview", () => {
  it("sends review with action and headSha", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const f = (async (url: string, init: RequestInit) => {
      seen = { url: String(url), init };
      return json({ redirect: "https://github.com/login/oauth/authorize?x" });
    }) as unknown as typeof fetch;
    const r = await sendReview(f, "r/1", "approve", "abc");
    expect(seen?.url).toBe("/api/runs/r%2F1/review");
    expect(seen?.init.method).toBe("POST");
    expect(JSON.parse(String(seen?.init.body))).toEqual({
      action: "approve",
      headSha: "abc",
    });
    expect(r).toEqual({
      ok: true,
      redirect: "https://github.com/login/oauth/authorize?x",
    });
  });
  it("sendReview 409 returns head_changed", async () => {
    const f = (async () =>
      json({ error: "head_changed" }, 409)) as unknown as typeof fetch;
    expect(await sendReview(f, "r1", "approve", "abc")).toEqual({
      ok: false,
      error: "head_changed",
    });
  });
});
