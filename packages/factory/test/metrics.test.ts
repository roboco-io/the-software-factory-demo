import { describe, expect, it } from "vitest";
import type { MergedPull, Review } from "../src/github/port";
import {
  authorShare,
  completionRate,
  engineStats,
  isoWeek,
  ratio,
  ruleEffects,
  topFailureReasons,
  unapprovedByTier,
} from "../src/report/metrics";
import type { RunRecord } from "../src/runs/store";

const BOT = "bot[bot]";

const rec = (o: Partial<RunRecord>): RunRecord => ({
  ts: "2026-10-10T00:00:00Z",
  issue: 1,
  pr: null,
  role: "implement",
  engine: "claude",
  model: "m",
  ok: true,
  turns: 1,
  costUsd: null,
  durationMs: 1,
  failureReason: null,
  round: 0,
  ...o,
});

const pull = (number: number, o: Partial<MergedPull> = {}): MergedPull => ({
  number,
  title: "t",
  body: "",
  author: BOT,
  labels: [],
  mergedAt: "2026-10-10T00:00:00Z",
  mergeSha: null,
  headSha: null,
  ...o,
});

const review = (author: string, state = "APPROVED"): Review => ({
  author,
  state,
  body: "",
  commitId: "c",
});

describe("metrics", () => {
  it("prints a ratio only when the sample is large enough", () => {
    expect(ratio(3, 5).text).toBe("60% (3/5)");
    expect(ratio(1, 4).text).toBe("데이터 부족 (n=4)");
    expect(ratio(0, 0).text).toBe("데이터 부족 (n=0)");
  });

  it("counts an issue as completed only when it deployed without any failed run", () => {
    const runs = [
      rec({ issue: 1, role: "implement" }),
      rec({ issue: 1, role: "deploy" }),
      rec({ issue: 2, role: "implement" }),
      rec({ issue: 2, role: "review", ok: false, failureReason: "timeout" }),
      rec({ issue: 2, role: "deploy" }),
      rec({ issue: 3, role: "implement" }),
      rec({ issue: 4, role: "implement" }),
      rec({ issue: 4, role: "gate", ok: false, failureReason: "risk_t2" }),
      rec({ issue: 4, role: "deploy" }),
      rec({ issue: 5, role: "implement" }),
      rec({ issue: 5, role: "deploy" }),
    ];
    expect(completionRate(runs)).toMatchObject({ k: 2, n: 5 }); // 1과 5. risk_t2(사람 승인)는 개입으로 본다
  });

  it("compares a category before and after an improvement merge", () => {
    const ev = (ts: string) => ({
      key: "review:error-format",
      issue: 1,
      pr: null,
      ts,
      detail: null,
      distinctKey: ts,
    });
    const effects = ruleEffects(
      [{ pr: 9, key: "review:error-format", mergedAt: "2026-10-10T00:00:00Z" }],
      [
        ev("2026-09-01T00:00:00Z"),
        ev("2026-10-01T00:00:00Z"),
        ev("2026-10-05T00:00:00Z"),
        ev("2026-10-11T00:00:00Z"),
      ],
      new Date("2026-10-12T00:00:00Z"),
    );
    expect(effects[0]).toMatchObject({ before: 2, after: 1, afterDays: 2 }); // 09-01은 28일 밖이다
  });

  it("computes ISO weeks across a year boundary", () => {
    expect(isoWeek(new Date("2026-10-12T00:00:00Z"))).toBe("2026-W42");
    expect(isoWeek(new Date("2027-01-01T00:00:00Z"))).toBe("2026-W53");
    expect(isoWeek(new Date("2027-01-04T00:00:00Z"))).toBe("2027-W01");
  });

  it("aggregates success and known cost per engine for agent roles only", () => {
    const stats = engineStats([
      rec({ engine: "claude", role: "implement", costUsd: 1.5 }),
      rec({ engine: "claude", role: "review", ok: false, costUsd: null }),
      rec({ engine: "codex", role: "fix", costUsd: 0.25 }),
      rec({ engine: "codex", role: "deploy" }),
      rec({ engine: null, role: "gate" }),
    ]);
    expect(stats).toEqual([
      { engine: "claude", runs: ratio(1, 2), costUsd: 1.5, costKnown: 1 },
      { engine: "codex", runs: ratio(1, 1), costUsd: 0.25, costKnown: 1 },
    ]);
    expect(engineStats([rec({ costUsd: null })])[0]).toMatchObject({
      costUsd: null,
      costKnown: 0,
    });
  });

  it("shares merged pulls by author, largest first", () => {
    expect(authorShare([pull(1), pull(2, { author: "alice" }), pull(3)])).toEqual([
      { author: BOT, share: ratio(2, 3) },
      { author: "alice", share: ratio(1, 3) },
    ]);
  });

  it("counts merges without a human approval per risk tier; bot approvals do not count", () => {
    const pulls = [
      pull(1, { labels: ["risk:T1"] }),
      pull(2, { labels: ["risk:T1"] }),
      pull(3, { labels: ["risk:T2"] }),
      pull(4, { labels: ["risk:T2"] }),
      pull(5, { labels: [] }),
    ];
    const reviews = new Map<number, Review[]>([
      [1, [review(BOT)]],
      [2, [review("alice", "COMMENTED")]],
      [3, [review("alice")]],
      [4, [review(BOT), review("bob", "CHANGES_REQUESTED")]],
    ]);
    expect(unapprovedByTier(pulls, reviews, BOT)).toEqual([
      { tier: "T1", share: ratio(2, 2) },
      { tier: "T2", share: ratio(1, 2) },
    ]);
  });

  it("ranks failure reasons by count", () => {
    const runs = [
      rec({ ok: false, failureReason: "timeout" }),
      rec({ ok: false, failureReason: "checks_failed" }),
      rec({ ok: false, failureReason: "timeout" }),
      rec({ ok: false, failureReason: null }),
      rec({ ok: false, failureReason: "risk_t2" }),
      rec({ ok: false, failureReason: "risk_t3" }),
      rec({ ok: false, failureReason: "permission_denied" }),
      rec({ ok: true }),
    ];
    expect(topFailureReasons(runs)).toEqual([
      { reason: "timeout", count: 2 },
      { reason: "checks_failed", count: 1 },
      { reason: "unknown", count: 1 },
    ]);
    expect(topFailureReasons(runs, 1)).toEqual([{ reason: "timeout", count: 2 }]);
  });
});
