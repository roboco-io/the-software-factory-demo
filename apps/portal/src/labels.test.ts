import { describe, expect, it } from "vitest";
import { REASON_CODES, STATES } from "../../control/src/run-types";
import {
  EVENT_KIND_LABELS,
  REASON_LABELS,
  STATE_LABELS,
  describeNextStep,
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

  describe("next step", () => {
    it("tells a person what to do for every reason a stopped run can have", () => {
      for (const code of REASON_CODES) {
        if (code === "merged_outside_factory") continue;
        const step = describeNextStep("needs_human", code);
        expect(step?.action.length, code).toBeGreaterThan(10);
        expect(step?.action, code).toMatch(/[가-힣]/);
      }
    });

    it("says a stopped run ignores approval and the same issue's label", () => {
      const step = describeNextStep("needs_human", "changes_requested");
      expect(step?.action).toContain("직접 병합");
      expect(step?.action).toContain("닫");
      expect(step?.note).toContain("승인해도");
      expect(step?.note).toContain("새 이슈");
      expect(step?.note).toContain("이미 병합되었거나 닫혔다면");
    });

    it("sends a failed run back to the label on the same issue", () => {
      for (const code of ["agent_failed", "empty_change", "symlink"]) {
        const step = describeNextStep("failed", code);
        expect(step?.action, code).toContain("factory:go");
        expect(step?.action, code).toContain("다시 붙이");
      }
      expect(describeNextStep("failed", null)?.action).toContain("factory:go");
    });

    it("warns before re-running a change that tried to leave the allowed paths", () => {
      expect(describeNextStep("failed", "path_traversal")?.action).toContain(
        "이슈 내용",
      );
    });

    it("depends on the state when one reason can end either way", () => {
      expect(
        describeNextStep("failed", "stopped_by_operator")?.action,
      ).toContain("factory:go");
      expect(
        describeNextStep("needs_human", "stopped_by_operator")?.action,
      ).toContain("직접 병합");
    });

    it("asks nothing when no action is left or the run is still moving", () => {
      expect(
        describeNextStep("needs_human", "merged_outside_factory"),
      ).toBeNull();
      expect(describeNextStep("merged", null)).toBeNull();
      expect(describeNextStep("reviewing", null)).toBeNull();
      expect(describeNextStep("awaiting_approval", null)).toBeNull();
    });

    it("has no further action for a closed pull request except a new issue", () => {
      const step = describeNextStep("needs_human", "pr_closed");
      expect(step?.action).toContain("새 이슈");
      expect(step?.note).toBeUndefined();
    });

    it("ignores unknown and inherited reason names", () => {
      for (const code of ["constructor", "__proto__", "nonsense"]) {
        const step = describeNextStep("needs_human", code);
        expect(typeof step?.action, code).toBe("string");
      }
      expect(describeNextStep("constructor", null)).toBeNull();
    });
  });

  it("does not promise that approving a finished run does anything", () => {
    for (const code of REASON_CODES) {
      expect(REASON_LABELS[code]!.text, code).not.toContain("승인해야");
    }
  });
});
