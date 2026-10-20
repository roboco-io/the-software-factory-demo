import { describe, expect, it } from "vitest";
import type { Run } from "./data";
import { improvementStories, incidents, issueStories, roleStats } from "./insights";

function run(
  issue: number,
  role: string,
  ts: string,
  extra: Partial<Run> & { pr?: number; model?: unknown } = {},
): Run {
  return {
    issue,
    role,
    ts,
    engine: "codex",
    ok: true,
    costUsd: null,
    failureReason: null,
    ...extra,
  };
}

const now = new Date("2026-10-20T00:00:00Z");
const improvement = { pr: 90, key: "review:security", mergedAt: "2026-10-10T00:00:00Z" };

const unavailable = {
  events: null,
  issues: null,
  affectedIssues: null,
  days: null,
  coverage: "unavailable",
  startAt: null,
  endAt: null,
};
const beforeCoverage = {
  coverage: "complete",
  startAt: "2026-09-12T00:00:00.000Z",
  endAt: "2026-10-10T00:00:00.000Z",
};
const afterCoverage = {
  coverage: "complete",
  startAt: "2026-10-10T00:00:00.000Z",
  endAt: "2026-10-20T00:00:00.000Z",
};

describe("issueStories", () => {
  it("orders cross-week histories and retains retries, holds and the last PR", () => {
    const runs = [
      run(1, "deploy", "2026-10-15T00:00:00Z"),
      run(1, "implement", "2026-10-08T00:00:00Z", { ok: false, pr: 4 }),
      run(2, "triage", "2026-10-16T00:00:00Z"),
      run(1, "triage", "2026-10-01T00:00:00Z"),
      run(1, "gate", "2026-10-10T00:00:00Z", { ok: false, failureReason: "risk_t2" }),
      run(1, "fix", "2026-10-12T00:00:00Z", { pr: 6 }),
    ];
    const stories = issueStories(runs);
    expect(stories.map((s) => s.issue)).toEqual([2, 1]);
    expect(stories[1]).toEqual({
      issue: 1,
      firstAt: "2026-10-01T00:00:00Z",
      latestAt: "2026-10-15T00:00:00Z",
      deployed: true,
      pr: 6,
      steps: [runs[3], runs[1], runs[4], runs[5], runs[0]],
    });
    expect(issueStories(runs, 1)).toHaveLength(1);
  });

  it("uses the last deployment result and excludes unrelated or invalid records", () => {
    const records = [
      run(1, "deploy", "2026-10-01"),
      run(1, "deploy", "2026-10-02", { ok: false }),
      ...["improve", "intake", "smoke"].map((role) => run(2, role, "2026-10-03")),
      run(3, "triage", "invalid"),
      run(0, "triage", "2026-10-04"),
      run(Infinity, "triage", "2026-10-04"),
    ];
    expect(issueStories(records)).toHaveLength(1);
    expect(issueStories(records)[0]).toMatchObject({ deployed: false, pr: null });
    expect(
      issueStories(Array.from({ length: 8 }, (_, i) => run(i + 1, "triage", "2026-10-01"))),
    ).toHaveLength(6);
  });
});

describe("roleStats", () => {
  it("keeps each role and engine denominator and counts reported zero costs", () => {
    expect(
      roleStats([
        run(1, "review", "2026-10-01", { costUsd: 0 }),
        run(2, "review", "2026-10-02", { ok: false, costUsd: 2 }),
        run(3, "review", "2026-10-03", { costUsd: NaN }),
        run(4, "implement", "2026-10-04", { costUsd: -1 }),
        run(5, "review", "2026-10-05", { engine: "claude", costUsd: Infinity }),
        run(6, "deploy", "2026-10-06", { costUsd: 10 }),
        run(7, "review", "invalid", { costUsd: 10 }),
      ]),
    ).toEqual([
      { engine: "codex", model: null, role: "implement", ok: 1, n: 1, costUsd: 0, costRuns: 0 },
      { engine: "claude", model: null, role: "review", ok: 1, n: 1, costUsd: 0, costRuns: 0 },
      { engine: "codex", model: null, role: "review", ok: 2, n: 3, costUsd: 2, costRuns: 2 },
    ]);
  });
  it("keeps model combinations separate and groups missing or invalid models together", () => {
    expect(
      roleStats([
        run(1, "review", "2026-10-01", { model: "gpt-6", costUsd: 2 }),
        run(2, "review", "2026-10-02", { model: "gpt-6", ok: false }),
        run(3, "review", "2026-10-03", { model: "gpt-5.4", costUsd: 0 }),
        run(4, "review", "2026-10-04", { model: "gpt-5.4", costUsd: 1 }),
        run(5, "review", "2026-10-05"),
        run(6, "review", "2026-10-06", {
          model: 123 as unknown as Run["model"],
          ok: false,
          costUsd: 3,
        }),
        run(7, "review", "2026-10-07", { model: "   " }),
        run(8, "review", "2026-10-08", { model: null }),
      ]),
    ).toEqual([
      { engine: "codex", model: null, role: "review", ok: 3, n: 4, costUsd: 3, costRuns: 1 },
      { engine: "codex", model: "gpt-5.4", role: "review", ok: 2, n: 2, costUsd: 1, costRuns: 2 },
      { engine: "codex", model: "gpt-6", role: "review", ok: 1, n: 2, costUsd: 2, costRuns: 1 },
    ]);
  });
});

describe("improvementStories", () => {
  it("counts findings individually and exposures by distinct issue across merge boundaries", () => {
    const stories = improvementStories(
      [
        run(1, "review", "2026-09-12T00:00:00Z", {
          findings: [{ category: "security" }, { category: "security" }],
        }),
        run(1, "review", "2026-10-09", { findings: [{ category: "security" }] }),
        run(2, "review", "2026-10-09", { findings: [{ category: "style" }] }),
        run(3, "review", "2026-09-11T23:59:59Z", { findings: [{ category: "security" }] }),
        run(4, "review", improvement.mergedAt, { findings: [{ category: "security" }] }),
        run(5, "review", "2026-10-20T00:00:00Z"),
        run(6, "review", "2026-10-20T00:00:01Z", { findings: [{ category: "security" }] }),
        run(0, "review", "2026-10-11", { findings: [{ category: "security" }] }),
        run(7, "review", "invalid"),
      ],
      [improvement],
      now,
    );
    expect(stories[0]).toEqual({
      ...improvement,
      before: { events: 3, issues: 2, affectedIssues: 1, days: 28, ...beforeCoverage },
      after: { events: 1, issues: 2, affectedIssues: 1, days: 10, ...afterCoverage },
      supported: true,
      enoughSamples: false,
    });
  });

  it("matches run failure reasons and smoke roles while excluding holds and improvement runs", () => {
    const runs = [
      run(1, "implement", "2026-10-09", { ok: false, failureReason: "tests" }),
      run(1, "fix", "2026-10-09", { ok: false, failureReason: "tests" }),
      run(2, "review", "2026-10-09"),
      run(3, "gate", "2026-10-09", { ok: false, failureReason: "risk_t3" }),
      run(4, "command", "2026-10-09", { ok: false, failureReason: "permission_denied" }),
      run(5, "improve", "2026-10-09", { ok: false, failureReason: "tests" }),
      run(6, "smoke", "2026-10-09", { ok: false, failureReason: "tests" }),
      run(7, "smoke", "2026-10-11"),
      run(8, "implement", "2026-10-11", { ok: false, failureReason: "other" }),
      run(9, "gate", "2026-10-11", { ok: false, failureReason: "risk_t2" }),
      run(10, "improve", "2026-10-11", { ok: false, failureReason: "tests" }),
    ];
    const stories = improvementStories(
      runs,
      [
        { ...improvement, key: "run:tests" },
        { ...improvement, key: "smoke" },
      ],
      now,
    );
    expect(stories[0]!.before).toEqual({
      events: 3,
      issues: 3,
      affectedIssues: 2,
      days: 28,
      ...beforeCoverage,
    });
    expect(stories[0]!.after).toEqual({
      events: 0,
      issues: 2,
      affectedIssues: 0,
      days: 10,
      ...afterCoverage,
    });
    expect(stories[1]!.before).toEqual({
      events: 1,
      issues: 1,
      affectedIssues: 1,
      days: 28,
      ...beforeCoverage,
    });
    expect(stories[1]!.after).toEqual({
      events: 0,
      issues: 1,
      affectedIssues: 0,
      days: 10,
      ...afterCoverage,
    });
  });

  it("ignores malformed findings and unknown improvement keys", () => {
    const malformed = [
      run(1, "review", "2026-10-09", { findings: null as unknown as Run["findings"] }),
      run(2, "review", "2026-10-09", {
        findings: { category: "security" } as unknown as Run["findings"],
      }),
      run(3, "review", "2026-10-11", {
        findings: [null, { category: "security" }, {}] as unknown as Run["findings"],
      }),
    ];
    const stories = improvementStories(
      malformed,
      [improvement, { ...improvement, key: "other:security" }],
      now,
    );
    expect(stories[0]!.before).toEqual({
      events: 0,
      issues: 2,
      affectedIssues: 0,
      days: 28,
      ...beforeCoverage,
    });
    expect(stories[0]!.after).toEqual({
      events: 1,
      issues: 1,
      affectedIssues: 1,
      days: 10,
      ...afterCoverage,
    });
    expect(stories[1]!.before).toEqual(unavailable);
    expect(stories[1]!.after).toEqual(unavailable);
  });

  it("requires five exposed issues in both periods and caps observation at 28 days", () => {
    const runs = Array.from({ length: 5 }, (_, i) => [
      run(i + 1, "review", "2026-10-09"),
      run(i + 1, "review", "2026-10-11"),
    ]).flat();
    const stories = improvementStories(
      [...runs, run(99, "review", "2026-11-08", { findings: [{ category: "security" }] })],
      [
        improvement,
        { ...improvement, pr: 91, mergedAt: "2026-10-12" },
        { ...improvement, mergedAt: "invalid" },
        { ...improvement, mergedAt: "2027-01-01" },
      ],
      new Date("2026-11-08"),
    );
    expect(stories.map((s) => s.pr)).toEqual([91, 90]);
    expect(stories[1]!.enoughSamples).toBe(true);
    expect(stories[1]!.after).toEqual({
      events: 0,
      issues: 5,
      affectedIssues: 0,
      days: 28,
      coverage: "complete",
      startAt: "2026-10-10T00:00:00.000Z",
      endAt: "2026-11-07T00:00:00.000Z",
    });
    expect(stories[0]!.enoughSamples).toBe(false);
  });
  it("keeps old improvement metadata without fabricating activity outside loaded months", () => {
    const old = { pr: 4, key: "smoke", mergedAt: "2026-06-01T00:00:00Z" };
    expect(improvementStories([run(1, "smoke", "2026-06-02", { ok: false })], [old], now)).toEqual([
      { ...old, supported: true, before: unavailable, after: unavailable, enoughSamples: false },
    ]);
  });

  it("clips partial windows at the first loaded UTC calendar month and rejects partial samples", () => {
    const partial = { pr: 5, key: "review:security", mergedAt: "2026-08-10T00:00:00Z" };
    const records = Array.from({ length: 5 }, (_, i) => [
      run(i + 1, "review", "2026-08-02"),
      run(i + 1, "review", "2026-08-11"),
    ]).flat();
    const story = improvementStories(
      [...records, run(99, "review", "2026-07-31", { findings: [{ category: "security" }] })],
      [partial],
      now,
    )[0]!;
    expect(story.before).toEqual({
      events: 0,
      issues: 5,
      affectedIssues: 0,
      days: 9,
      coverage: "partial",
      startAt: "2026-08-01T00:00:00.000Z",
      endAt: "2026-08-10T00:00:00.000Z",
    });
    expect(story.after).toEqual({
      events: 0,
      issues: 5,
      affectedIssues: 0,
      days: 28,
      coverage: "complete",
      startAt: "2026-08-10T00:00:00.000Z",
      endAt: "2026-09-07T00:00:00.000Z",
    });
    expect(story.enoughSamples).toBe(false);
  });

  it.each(["revert", "review:", "run:", "review:   ", "run:   "])(
    "marks unsupported key %s as unmeasurable",
    (key) => {
      expect(
        improvementStories([run(1, "review", "2026-10-09")], [{ ...improvement, key }], now)[0],
      ).toEqual({
        ...improvement,
        key,
        supported: false,
        before: unavailable,
        after: unavailable,
        enoughSamples: false,
      });
    },
  );
});

describe("incidents", () => {
  const inc = (
    phase: "initial" | "followup",
    over: Partial<NonNullable<Run["incident"]>> = {},
  ): NonNullable<Run["incident"]> => ({
    key: "66#1",
    kind: "smoke",
    phase,
    detectedAt: "2026-10-20T01:00:00Z",
    recoveredAt: null,
    causePr: null,
    reverted: false,
    classification: null,
    ...over,
  });

  it("merges initial and followup into one row and prefers the followup recoveredAt", () => {
    const rows = incidents([
      run(66, "postmortem", "2026-10-20T01:05:00Z", { incident: inc("initial", { causePr: 65 }) }),
      run(66, "postmortem", "2026-10-20T03:00:00Z", {
        incident: inc("followup", {
          recoveredAt: "2026-10-20T01:45:00Z",
          causePr: 65,
          reverted: true,
          classification: "test_gap",
        }),
      }),
    ]);
    expect(rows).toEqual([
      {
        key: "66#1",
        issue: 66,
        kind: "smoke",
        detectedAt: "2026-10-20T01:00:00Z",
        recoveredAt: "2026-10-20T01:45:00Z",
        mttrMinutes: 45,
        causePr: 65,
        reverted: true,
        classification: "test_gap",
      },
    ]);
  });

  it("reports mttrMinutes null before recovery and sorts by latest detection", () => {
    const rows = incidents([
      run(66, "postmortem", "2026-10-20T01:05:00Z", { incident: inc("initial") }),
      run(70, "postmortem", "2026-10-20T05:05:00Z", {
        incident: inc("initial", { key: "70#1", detectedAt: "2026-10-20T05:00:00Z" }),
      }),
      run(1, "triage", "2026-10-20T06:00:00Z"),
    ]);
    expect(rows.map((r) => r.key)).toEqual(["70#1", "66#1"]);
    expect(rows[0]).toMatchObject({ recoveredAt: null, mttrMinutes: null, causePr: null });
  });

  it("returns an empty list without incident records", () => {
    expect(incidents([run(1, "triage", "2026-10-20T06:00:00Z")])).toEqual([]);
  });
});
