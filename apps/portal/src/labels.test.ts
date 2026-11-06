import { describe, expect, it } from "vitest";
import { REASON_CODES, STATES } from "../../control/src/run-types";
import {
  EVENT_KIND_LABELS,
  REASON_LABELS,
  STATE_LABELS,
  describeOutcome,
} from "./labels";

describe("Korean labels", () => {
  it("explain every run state the control plane can store", () => {
    expect(Object.keys(STATE_LABELS).sort()).toEqual([...STATES].sort());
    for (const state of STATES) {
      const label = STATE_LABELS[state]!;
      expect(label.title.length, state).toBeGreaterThan(1);
      expect(label.text.length, state).toBeGreaterThan(15);
      expect(label.title + label.text).toMatch(/[가-힣]/);
    }
  });

  it("explain every reason code the control plane can store, and no other", () => {
    expect(Object.keys(REASON_LABELS).sort()).toEqual([...REASON_CODES].sort());
    for (const code of REASON_CODES) {
      const label = REASON_LABELS[code]!;
      expect(label.title.length, code).toBeGreaterThan(1);
      expect(label.text.length, code).toBeGreaterThan(15);
      expect(label.title + label.text).toMatch(/[가-힣]/);
      expect(["ok", "info", "wait", "attention", "fail"]).toContain(label.tone);
    }
  });

  it("names the three event kinds", () => {
    expect(Object.keys(EVENT_KIND_LABELS).sort()).toEqual([
      "cleanup",
      "created",
      "transition",
    ]);
  });

  it("reads merged_outside_factory as finished with no action needed", () => {
    const label = REASON_LABELS["merged_outside_factory"]!;
    expect(label.tone).toBe("ok");
    expect(label.text).toContain("조치");
    expect(label.text).toContain("필요 없");
    const outcome = describeOutcome("needs_human", "merged_outside_factory");
    expect(outcome.tone).toBe("ok");
    expect(outcome.text).toContain("필요 없");
  });

  it("describes an outcome from the state, or from the reason code when there is one", () => {
    expect(describeOutcome("merged", null).tone).toBe("ok");
    expect(describeOutcome("awaiting_approval", null).tone).toBe("wait");
    expect(describeOutcome("implementing", null).tone).toBe("wait");
    expect(describeOutcome("failed", "agent_failed").title).toBe(
      REASON_LABELS["agent_failed"]!.title,
    );
    expect(
      describeOutcome("needs_human", "stopped_by_operator").text,
    ).toContain("운영자");
    expect(describeOutcome("needs_human", null).tone).toBe("attention");
  });
});
