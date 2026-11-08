import type { RunState } from "./run-types";

/** Runs that stop here. A run in any other state is active. */
const TERMINAL: readonly RunState[] = ["merged", "needs_human", "failed"];

const STOPS: readonly RunState[] = ["needs_human", "failed"];

const NEXT: Readonly<Record<RunState, readonly RunState[]>> = {
  queued: ["cloning", ...STOPS],
  cloning: ["implementing", ...STOPS],
  implementing: ["publishing", ...STOPS],
  publishing: ["pr_opened", ...STOPS],
  pr_opened: ["reviewing", ...STOPS],
  reviewing: ["awaiting_checks", "awaiting_engine", ...STOPS],
  awaiting_engine: ["reviewing", ...STOPS],
  awaiting_checks: ["awaiting_approval", "merged", ...STOPS],
  awaiting_approval: ["merged", ...STOPS],
  merged: [],
  needs_human: [],
  failed: [],
};

/** States after the pull request exists. A stop here means a person must look: needs_human, not failed. */
export const POST_PR_STATES: readonly RunState[] = [
  "pr_opened",
  "reviewing",
  "awaiting_engine",
  "awaiting_checks",
  "awaiting_approval",
];

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
  TERMINAL.includes(state);

export function canTransition(from: RunState, to: RunState): boolean {
  return NEXT[from].includes(to);
}

export function assertTransition(from: RunState, to: RunState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}
