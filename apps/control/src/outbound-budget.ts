import { budgetConfig } from "./budget";
import { BudgetService, type CallCheck } from "./budget-service";
import { D1BudgetRepo } from "./d1-budget";
import type { ControlEnv } from "./env";

/** The budget check of one model call, read from D1. Kept apart so tests can replace it. */
export function checkCallBudget(
  env: Pick<
    ControlEnv,
    "DB" | "BUDGET_ANTHROPIC_USD" | "BUDGET_OPENAI_USD" | "RUN_BUDGET_USD"
  >,
  runId: string,
  model: string,
): Promise<CallCheck> {
  return new BudgetService({
    repo: new D1BudgetRepo(env.DB),
    config: budgetConfig(env),
    now: () => Date.now(),
    factoryRepo: "",
  }).callCheck(runId, model);
}
