import { describe, expect, it } from "vitest";
import { durationText, stageCells, stageCounts, STAGES } from "./flow";

const at = (...states: string[]) =>
  states.map((state, i) => ({ state, at: i * 60_000 }));
const statuses = (run: Parameters<typeof stageCells>[0], now = 0) =>
  stageCells(run, now).map((c) => c.status);

describe("stageCells", () => {
  it("has seven stages in the order work moves", () => {
    expect(STAGES.map((s) => s.label)).toEqual([
      "접수",
      "구현",
      "PR",
      "리뷰",
      "체크",
      "승인",
      "병합",
    ]);
  });

  it("marks the approval stage skipped when a merged run never waited there", () => {
    const path = at(
      "queued",
      "cloning",
      "implementing",
      "publishing",
      "pr_opened",
      "reviewing",
      "awaiting_checks",
      "merged",
    );
    expect(statuses({ state: "merged", path })).toEqual([
      "done",
      "done",
      "done",
      "done",
      "done",
      "skipped",
      "done",
    ]);
  });

  it("marks where a stopped run stopped and leaves later stages untouched", () => {
    const path = at(
      "queued",
      "cloning",
      "implementing",
      "publishing",
      "pr_opened",
      "reviewing",
      "needs_human",
    );
    expect(statuses({ state: "needs_human", path })).toEqual([
      "done",
      "done",
      "done",
      "stopped",
      "todo",
      "todo",
      "todo",
    ]);
  });

  it("marks a failed run on the stage it was in", () => {
    const path = at("queued", "cloning", "implementing", "failed");
    expect(statuses({ state: "failed", path }).slice(0, 3)).toEqual([
      "done",
      "stopped",
      "todo",
    ]);
  });

  it("marks the current stage of an active run and not the optional one before it", () => {
    const path = at("queued", "cloning", "implementing");
    expect(statuses({ state: "implementing", path })).toEqual([
      "done",
      "current",
      "todo",
      "todo",
      "todo",
      "todo",
      "todo",
    ]);
  });

  it("adds up the time of the states inside one stage", () => {
    const path = [
      { state: "queued", at: 0 },
      { state: "cloning", at: 10_000 },
      { state: "implementing", at: 30_000 },
      { state: "needs_human", at: 90_000 },
    ];
    const cells = stageCells({ state: "needs_human", path }, 999_000);
    expect(cells[0]!.ms).toBe(30_000);
    expect(cells[1]!.ms).toBe(60_000);
    expect(cells[2]!.ms).toBeNull();
  });

  it("counts an active stage up to now and a merged stage not at all", () => {
    const active = stageCells(
      { state: "implementing", path: [{ state: "implementing", at: 1_000 }] },
      61_000,
    );
    expect(active[1]!.ms).toBe(60_000);
    const merged = stageCells(
      { state: "merged", path: [{ state: "merged", at: 1_000 }] },
      61_000,
    );
    expect(merged[6]!.ms).toBeNull();
  });

  it("shows nothing as reached for an empty path or an unknown state", () => {
    expect(statuses({ state: "needs_human", path: [] })).toEqual(
      Array(7).fill("todo"),
    );
    expect(statuses({ state: "brand_new", path: [] })).toEqual(
      Array(7).fill("todo"),
    );
  });

  it("still shows the current stage of an active run with an empty path", () => {
    expect(statuses({ state: "reviewing", path: [] })[3]).toBe("current");
  });

  it("ignores a stored state it does not know", () => {
    const path = at("queued", "brand_new", "implementing");
    expect(statuses({ state: "implementing", path }).slice(0, 2)).toEqual([
      "done",
      "current",
    ]);
  });
});

describe("stageCounts", () => {
  it("counts running and stopped runs per stage", () => {
    const counts = stageCounts(
      [
        { state: "implementing", path: at("implementing") },
        { state: "needs_human", path: at("implementing", "needs_human") },
        { state: "merged", path: at("merged") },
      ],
      0,
    );
    expect(counts[1]).toEqual({ active: 1, stopped: 1 });
    expect(counts[6]).toEqual({ active: 0, stopped: 0 });
  });
});

describe("durationText", () => {
  it.each([
    [0, "1초 미만"],
    [999, "1초 미만"],
    [12_000, "12초"],
    [59_999, "59초"],
    [60_000, "1분"],
    [200_000, "3분"],
    [7_200_000, "2시간"],
    [259_200_000, "3일"],
  ])("%d ms is %s", (ms, text) => {
    expect(durationText(ms)).toBe(text);
  });
});

describe("awaiting_engine (stage 5)", () => {
  it("belongs to the review stage", () => {
    expect(STAGES.find((s) => s.key === "review")!.states).toContain(
      "awaiting_engine",
    );
  });
});
