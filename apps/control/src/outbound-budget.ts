import { loadBudgetConfig } from "./budget";
import { BudgetService, type CallCheck } from "./budget-service";
import { D1BudgetRepo } from "./d1-budget";
import type { ControlEnv } from "./env";

/** Model calls one run may have in flight at once. It bounds the overshoot of the spend checks. */
export const MAX_CALLS_IN_FLIGHT = 4;
/** An in-flight slot older than this belongs to a call that crashed: the agent has stopped by then. */
export const INFLIGHT_STALE_MS = 20 * 60 * 1000;

type BudgetEnv = Pick<
  ControlEnv,
  "DB" | "BUDGET_ANTHROPIC_USD" | "BUDGET_OPENAI_USD" | "RUN_BUDGET_USD"
>;

/** The budget check of one model call, read from D1. Kept apart so tests can replace it. */
export function checkCallBudget(
  env: BudgetEnv,
  runId: string,
  model: string,
  phase: string,
): Promise<CallCheck> {
  const repo = new D1BudgetRepo(env.DB);
  return new BudgetService({
    repo,
    config: () => loadBudgetConfig(env, repo),
    now: () => Date.now(),
    factoryRepo: "",
  }).callCheck(runId, model, phase);
}

/** Takes an in-flight slot for one model call. Null when the run has too many calls in flight. */
export function acquireCallSlot(
  env: BudgetEnv,
  runId: string,
): Promise<number | null> {
  return new D1BudgetRepo(env.DB).acquireInflight(
    runId,
    Date.now(),
    MAX_CALLS_IN_FLIGHT,
    INFLIGHT_STALE_MS,
  );
}

export function releaseCallSlot(env: BudgetEnv, id: number): Promise<void> {
  return new D1BudgetRepo(env.DB).releaseInflight(id);
}
