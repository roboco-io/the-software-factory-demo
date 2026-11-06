import type { RunState } from "./run-types";

const NEXT: Readonly<Record<RunState, readonly RunState[]>> = {
  queued: ["cloning", "failed"],
  cloning: ["implementing", "failed"],
  implementing: ["publishing", "failed"],
  publishing: ["pr_opened", "failed"],
  pr_opened: [],
  failed: [],
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: RunState,
    readonly to: RunState,
  ) {
    super(`illegal transition ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export const isTerminal = (state: RunState): boolean =>
  NEXT[state].length === 0;

export function canTransition(from: RunState, to: RunState): boolean {
  return NEXT[from].includes(to);
}

export function assertTransition(from: RunState, to: RunState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}
