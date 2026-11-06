import { describe, expect, it } from "vitest";
import {
  IllegalTransitionError,
  assertTransition,
  isTerminal,
} from "./run-state";
import { STATES, type RunState } from "./run-types";

const LEGAL: [RunState, RunState][] = [
  ["queued", "cloning"],
  ["cloning", "implementing"],
  ["implementing", "publishing"],
  ["publishing", "pr_opened"],
  ["queued", "failed"],
  ["cloning", "failed"],
  ["implementing", "failed"],
  ["publishing", "failed"],
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
  it("treats pr_opened and failed as terminal", () => {
    expect(STATES.filter(isTerminal)).toEqual(["pr_opened", "failed"]);
  });
});
