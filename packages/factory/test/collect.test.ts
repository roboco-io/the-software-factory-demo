import { describe, expect, it } from "vitest";
import { writeMarker } from "../src/report/text";
import { failureEvents, IMPROVE_MARKER, rankCandidates, runCollect } from "../src/stages/collect";
import type { RunRecord } from "../src/runs/store";
import { makeTestDeps } from "./helpers";

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
const finding = (category: string, message = "m") => ({
  category,
  file: "apps/api/src/routes/x.ts",
  message,
});

describe("collect", () => {
  it("needs three distinct issues before a key becomes a candidate", () => {
    const runs = [1, 2, 2].map((issue) =>
      rec({ issue, role: "review", findings: [finding("error-format")] }),
    );
    expect(rankCandidates(failureEvents(runs, []), new Set()).candidates).toEqual([]);
    runs.push(rec({ issue: 3, role: "review", findings: [finding("error-format")] }));
    const { candidates } = rankCandidates(failureEvents(runs, []), new Set());
    expect(candidates[0]).toMatchObject({
      key: "review:error-format",
      distinct: 3,
      count: 4,
      issues: [1, 2, 3],
    });
  });

  it("ignores policy holds and permission denials, and counts smoke by day", () => {
    const runs = [
      rec({ issue: 1, ok: false, role: "gate", failureReason: "risk_t2" }),
      rec({ issue: 2, ok: false, role: "command", failureReason: "permission_denied" }),
      rec({
        issue: 0,
        ok: false,
        role: "smoke",
        failureReason: "smoke_failed",
        ts: "2026-10-01T01:00:00Z",
      }),
      rec({
        issue: 0,
        ok: false,
        role: "smoke",
        failureReason: "smoke_failed",
        ts: "2026-10-01T07:00:00Z",
      }),
    ];
    const ev = failureEvents(runs, []);
    expect(ev.map((e) => e.key)).toEqual(["smoke", "smoke"]);
    expect(new Set(ev.map((e) => e.distinctKey)).size).toBe(1);
  });

  it("uses the recorded smoke failure excerpt as the sample", () => {
    const runs = ["01", "02", "03"].map((d) =>
      rec({
        issue: 66,
        ok: false,
        role: "smoke",
        failureReason: "smoke_failed",
        ts: `2026-10-${d}T00:00:00Z`,
        detail: `expected <conduit> ${d}`,
      }),
    );
    const { candidates } = rankCandidates(failureEvents(runs, []), new Set());
    expect(candidates[0]).toMatchObject({ key: "smoke", issues: [66] });
    expect(candidates[0]!.samples).toEqual([
      "expected <conduit> 03",
      "expected <conduit> 02",
      "expected <conduit> 01",
    ]);
  });

  it("skips improve records so improve failures are not candidates", () => {
    const ev = failureEvents(
      [
        rec({ issue: 1, ok: false, role: "improve", failureReason: "checks_failed" }),
        rec({ issue: 2, ok: false, role: "improve", failureReason: "checks_failed" }),
        rec({ issue: 3, ok: false, role: "implement", failureReason: "timeout" }),
      ],
      [],
    );
    expect(ev.map((e) => e.key)).toEqual(["run:timeout"]);
  });

  it("keys run failures by reason and distinct issue", () => {
    const ev = failureEvents(
      [rec({ issue: 4, ok: false, failureReason: "timeout" }), rec({ issue: 5, ok: false })],
      [],
    );
    expect(ev.map((e) => [e.key, e.distinctKey])).toEqual([
      ["run:timeout", "issue:4"],
      ["run:unknown", "issue:5"],
    ]);
  });

  it("turns revert commits into events keyed by sha", () => {
    const ev = failureEvents(
      [],
      [
        {
          sha: "a".repeat(40),
          message: 'Revert "feat: x"\n\nFactory-Issue: #7',
          date: "2026-10-10T00:00:00Z",
        },
        { sha: "b".repeat(40), message: "feat: y", date: "2026-10-10T00:00:00Z" },
      ],
    );
    expect(ev).toEqual([
      expect.objectContaining({ key: "revert", issue: 7, distinctKey: "a".repeat(40) }),
    ]);
  });

  it("excludes keys covered by an open improve PR and caps samples", () => {
    const runs = [1, 2, 3, 4, 5, 6].map((issue) =>
      rec({
        issue,
        role: "review",
        findings: [finding("style", `msg-${issue}-` + "y".repeat(2000))],
      }),
    );
    const open = rankCandidates(failureEvents(runs, []), new Set(["review:style"]));
    expect(open.candidates).toEqual([]);
    expect(open.excluded).toEqual([{ key: "review:style", reason: "open_improve_pr" }]);
    const c = rankCandidates(failureEvents(runs, []), new Set()).candidates[0]!;
    expect(c.samples).toHaveLength(5);
    expect(c.samples.every((s) => s.length <= 1000)).toBe(true);
  });

  it("orders by distinct, then count, then key", () => {
    const runs = [
      ...[1, 2, 3].map((i) => rec({ issue: i, role: "review", findings: [finding("b")] })),
      ...[1, 2, 3].map((i) => rec({ issue: i, role: "review", findings: [finding("a")] })),
      ...[1, 2, 3, 4].map((i) => rec({ issue: i, role: "review", findings: [finding("c")] })),
      rec({ issue: 1, role: "review", findings: [finding("b")] }),
    ];
    const keys = rankCandidates(failureEvents(runs, []), new Set()).candidates.map((c) => c.key);
    expect(keys).toEqual(["review:c", "review:b", "review:a"]);
  });
});

describe("runCollect", () => {
  it("drops records older than 28 days and excludes keys with an open bot improve PR", async () => {
    const h = makeTestDeps();
    const f = [finding("error-format")];
    await h.deps.runs.append(
      rec({ ts: "2026-09-01T00:00:00Z", issue: 10, role: "review", findings: f }),
    );
    for (const issue of [1, 2, 3])
      await h.deps.runs.append(
        rec({ ts: "2026-10-10T00:00:00Z", issue, role: "review", findings: f }),
      );
    const res = await runCollect(h.deps);
    expect(res.from).toBe("2026-09-14T03:00:00.000Z");
    expect(res.to).toBe("2026-10-12T03:00:00.000Z");
    expect(res.events).toBe(3);
    expect(res.candidates[0]).toMatchObject({ key: "review:error-format", issues: [1, 2, 3] });

    h.gh.setBranch("factory/improve-x", "sha1", ["a.ts"]);
    const marker = writeMarker(IMPROVE_MARKER, { key: "review:error-format" });
    const n = await h.gh.createPull({
      title: "improve",
      body: `x\n${marker}`,
      head: "factory/improve-x",
      base: "main",
      draft: false,
    });
    // label missing: not counted
    expect((await runCollect(h.deps)).candidates).toHaveLength(1);
    await h.gh.addLabels(n, ["factory:improve"]);
    const after = await runCollect(h.deps);
    expect(after.candidates).toEqual([]);
    expect(after.excluded).toEqual([{ key: "review:error-format", reason: "open_improve_pr" }]);
    // author must be the bot
    h.gh.pulls.get(n)!.author = "someone";
    expect((await runCollect(h.deps)).candidates).toHaveLength(1);
  });
});

describe("runCollect after a merged improve PR", () => {
  it("ignores events of the same key from before the improve PR merged", async () => {
    const h = makeTestDeps();
    const f = [finding("error-format")];
    for (const issue of [1, 2, 3])
      await h.deps.runs.append(
        rec({ ts: "2026-10-10T00:00:00Z", issue, role: "review", findings: f }),
      );
    h.gh.setBranch("factory/improve-x", "sha1", ["a.ts"]);
    const n = await h.gh.createPull({
      title: "improve",
      body: `x\n${writeMarker(IMPROVE_MARKER, { key: "review:error-format" })}`,
      head: "factory/improve-x",
      base: "main",
      draft: false,
    });
    await h.gh.addLabels(n, ["factory:improve"]);
    const pr = h.gh.pulls.get(n)!;
    pr.state = "closed";
    pr.merged = true;
    pr.mergedAt = "2026-10-11T00:00:00Z";

    const res = await runCollect(h.deps);
    expect(res.candidates).toEqual([]);
    expect(res.events).toBe(0);

    // the same failure recurring after the merge in three issues is a candidate again
    for (const issue of [4, 5, 6])
      await h.deps.runs.append(
        rec({ ts: "2026-10-11T12:00:00Z", issue, role: "review", findings: f }),
      );
    const again = await runCollect(h.deps);
    expect(again.candidates[0]).toMatchObject({ key: "review:error-format", issues: [4, 5, 6] });

    // other keys and non-bot merged PRs are unaffected
    pr.author = "someone";
    expect((await runCollect(h.deps)).candidates[0]?.issues).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
