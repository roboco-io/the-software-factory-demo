import { describe, expect, it } from "vitest";
import { filterText, matchesFilter, sameFilter } from "./run-filter";

const DAY = 24 * 60 * 60 * 1000;
const run = (state: string, path: string[], updatedAt = 0) => ({
  state,
  updatedAt,
  path: path.map((s, i) => ({ state: s, at: i * 60_000 })),
});

const merged = run("merged", ["queued", "implementing", "merged"]);
const implementing = run("implementing", ["queued", "implementing"]);
const waiting = run("awaiting_approval", ["queued", "awaiting_approval"]);
const stuckInReview = run("needs_human", [
  "queued",
  "reviewing",
  "needs_human",
]);
const oldFailure = run("failed", ["queued", "implementing", "failed"], 0);

describe("matchesFilter", () => {
  it("keeps every run for all", () => {
    expect(matchesFilter(merged, { kind: "all" }, 0)).toBe(true);
  });

  it("uses the attention rule, so an old failure drops out", () => {
    const f = { kind: "attention" } as const;
    expect(matchesFilter(waiting, f, 0)).toBe(true);
    expect(matchesFilter(stuckInReview, f, DAY)).toBe(true);
    expect(matchesFilter(oldFailure, f, 8 * DAY)).toBe(false);
    expect(matchesFilter(merged, f, 0)).toBe(false);
  });

  it("counts a run as active until it is merged, stuck or failed, like the summary", () => {
    const f = { kind: "active" } as const;
    expect(matchesFilter(implementing, f, 0)).toBe(true);
    expect(matchesFilter(waiting, f, 0)).toBe(true);
    expect(matchesFilter(stuckInReview, f, 0)).toBe(false);
    expect(matchesFilter(merged, f, 0)).toBe(false);
  });

  it("keeps merged runs for merged", () => {
    expect(matchesFilter(merged, { kind: "merged" }, 0)).toBe(true);
    expect(matchesFilter(implementing, { kind: "merged" }, 0)).toBe(false);
  });

  it("keeps runs stopped at one stage, matching the board's 멈춤 count", () => {
    const review = { kind: "stage", stage: 3, status: "stopped" } as const;
    expect(matchesFilter(stuckInReview, review, 0)).toBe(true);
    expect(matchesFilter(oldFailure, review, 0)).toBe(false);
    expect(
      matchesFilter(
        oldFailure,
        { kind: "stage", stage: 1, status: "stopped" },
        0,
      ),
    ).toBe(true);
  });

  it("keeps runs in progress at one stage, matching the board's 진행 count", () => {
    const f = { kind: "stage", stage: 1, status: "current" } as const;
    expect(matchesFilter(implementing, f, 0)).toBe(true);
    expect(matchesFilter(oldFailure, f, 0)).toBe(false);
  });
});

describe("filterText", () => {
  it("names the filter in words", () => {
    expect(filterText({ kind: "attention" })).toBe("주의가 필요한 실행");
    expect(filterText({ kind: "active" })).toBe("진행 중인 실행");
    expect(filterText({ kind: "merged" })).toBe("병합된 실행");
    expect(filterText({ kind: "stage", stage: 5, status: "stopped" })).toBe(
      "승인 단계에서 멈춘 실행",
    );
    expect(filterText({ kind: "stage", stage: 1, status: "current" })).toBe(
      "구현 단계에서 진행 중인 실행",
    );
  });
});

describe("sameFilter", () => {
  it("compares by value, so a second click on the same control can clear it", () => {
    expect(
      sameFilter(
        { kind: "stage", stage: 3, status: "stopped" },
        { kind: "stage", stage: 3, status: "stopped" },
      ),
    ).toBe(true);
    expect(
      sameFilter(
        { kind: "stage", stage: 3, status: "stopped" },
        { kind: "stage", stage: 3, status: "current" },
      ),
    ).toBe(false);
    expect(sameFilter({ kind: "merged" }, { kind: "merged" })).toBe(true);
  });
});
