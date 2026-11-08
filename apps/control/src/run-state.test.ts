import { describe, expect, it } from "vitest";
import {
  IllegalTransitionError,
  POST_PR_STATES,
  assertTransition,
  isTerminal,
} from "./run-state";
import { STATES, type RunState } from "./run-types";

const FLOW: RunState[] = [
  "queued",
  "cloning",
  "implementing",
  "publishing",
  "pr_opened",
  "reviewing",
  "awaiting_checks",
];
const LEGAL: [RunState, RunState][] = [
  ...FLOW.slice(0, -1).map((s, i): [RunState, RunState] => [s, FLOW[i + 1]!]),
  ["awaiting_checks", "awaiting_approval"],
  ["awaiting_checks", "merged"],
  ["awaiting_approval", "merged"],
  // Stage 5: the review waits for an engine with budget, then starts.
  ["reviewing", "awaiting_engine"],
  ["awaiting_engine", "reviewing"],
  // Any active state may stop with a fixed code.
  ...[
    ...FLOW,
    "awaiting_approval" as RunState,
    "awaiting_engine" as RunState,
  ].flatMap((s): [RunState, RunState][] => [
    [s, "needs_human"],
    [s, "failed"],
  ]),
];

describe("run state machine", () => {
  it("allows exactly the documented transitions and throws on all others", () => {
    for (const from of STATES) {
      for (const to of STATES) {
        const legal = LEGAL.some(([f, t]) => f === from && t === to);
        if (legal) expect(() => assertTransition(from, to)).not.toThrow();
        else
          expect(() => assertTransition(from, to), `${from} -> ${to}`).toThrow(
            IllegalTransitionError,
          );
      }
    }
  });
  it("treats merged, needs_human and failed as terminal", () => {
    expect(STATES.filter(isTerminal)).toEqual([
      "merged",
      "needs_human",
      "failed",
    ]);
  });
  it("cannot skip review or checks on the way to merged", () => {
    for (const from of [
      "queued",
      "publishing",
      "pr_opened",
      "reviewing",
    ] as const) {
      expect(() => assertTransition(from, "merged")).toThrow(
        IllegalTransitionError,
      );
    }
    expect(() => assertTransition("reviewing", "awaiting_approval")).toThrow(
      IllegalTransitionError,
    );
  });
  it("lists the states that exist after the pull request is open", () => {
    expect(POST_PR_STATES).toEqual([
      "pr_opened",
      "reviewing",
      "awaiting_engine",
      "awaiting_checks",
      "awaiting_approval",
    ]);
  });
  it("cannot leave awaiting_engine for checks or merge without a review", () => {
    for (const to of [
      "awaiting_checks",
      "awaiting_approval",
      "merged",
    ] as const)
      expect(() => assertTransition("awaiting_engine", to)).toThrow(
        IllegalTransitionError,
      );
  });
});
