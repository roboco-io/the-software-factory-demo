import {
  PROVIDERS,
  allExhausted,
  assessBudget,
  billingPeriod,
  spendByProvider,
  type BudgetConfig,
  type BudgetStatus,
  type Provider,
} from "./budget";
import type { ActiveRunBudget, D1BudgetRepo } from "./d1-budget";
import { errorKind, logDiagnostic } from "./diagnostics";
import { providerOf } from "./pricing";
import type { RunState } from "./run-types";

export interface IssueCreator {
  /** Opens an issue and returns its number. */
  createIssue(repo: string, title: string, body: string): Promise<number>;
}

export type CallCheck =
  | { allow: true }
  | {
      allow: false;
      reason:
        "model_not_priced" | "run_budget_exceeded" | "monthly_budget_exceeded";
    };

/** The budget questions the run machine asks. */
export interface BudgetPort {
  /** Spend this billing period and what the active runs other than `excludeRunId` still reserve. */
  status(excludeRunId?: string): Promise<BudgetStatus>;
  /** True when a call of `model` for this run would now be refused for budget. */
  overrun(runId: string, model: string): Promise<boolean>;
  /** Opens the period's factory issue once, when both accounts reached their limit. Never throws. */
  notifyExhausted(status: BudgetStatus): Promise<void>;
}

const IMPLEMENT_STATES: readonly RunState[] = [
  "queued",
  "cloning",
  "implementing",
  "publishing",
];

/** The model the run calls in its current state, or null when it calls none. */
function currentModel(run: ActiveRunBudget): string | null {
  if (IMPLEMENT_STATES.includes(run.state)) return run.implementModel;
  if (run.state === "reviewing") return run.reviewModel;
  return null;
}

const usd = (n: number | null) =>
  n === null ? "알 수 없음" : `$${n.toFixed(2)}`;

export class BudgetService implements BudgetPort {
  constructor(
    private readonly deps: {
      repo: Pick<
        D1BudgetRepo,
        | "periodUsage"
        | "runUsage"
        | "activeRuns"
        | "claimAlert"
        | "recordAlertIssue"
        | "releaseAlert"
      >;
      config: BudgetConfig;
      now(): number;
      /** Where the exhaustion issue goes. Not a managed project, so the factory never works on it. */
      factoryRepo: string;
      issues?: IssueCreator;
    },
  ) {}

  private async monthSpend() {
    const period = billingPeriod(this.deps.now());
    const rows = await this.deps.repo.periodUsage(period.start, period.end);
    return { period, spent: spendByProvider(rows) };
  }

  async status(excludeRunId?: string): Promise<BudgetStatus> {
    const [{ period, spent }, active] = await Promise.all([
      this.monthSpend(),
      this.deps.repo.activeRuns(),
    ]);
    const reserved: Record<Provider, number> = { anthropic: 0, openai: 0 };
    for (const run of active) {
      if (run.id === excludeRunId) continue;
      const model = currentModel(run);
      const provider = model === null ? null : providerOf(model);
      if (provider === null) continue;
      const used = spendByProvider(run.usage)[provider];
      // Unknown usage reserves the whole cap.
      reserved[provider] += Math.max(
        0,
        this.deps.config.runCapUsd - (used ?? 0),
      );
    }
    return assessBudget(this.deps.config, period.key, spent, reserved);
  }

  /** The egress check before each model call. Overshoot is bounded by the calls already in flight. */
  async callCheck(runId: string, model: string): Promise<CallCheck> {
    const provider = providerOf(model);
    if (provider === null) return { allow: false, reason: "model_not_priced" };
    const [runRows, { spent }] = await Promise.all([
      this.deps.repo.runUsage(runId),
      this.monthSpend(),
    ]);
    const runSpent = spendByProvider(runRows)[provider];
    if (runSpent === null || runSpent >= this.deps.config.runCapUsd)
      return { allow: false, reason: "run_budget_exceeded" };
    const monthSpent = spent[provider];
    if (
      monthSpent === null ||
      monthSpent >= this.deps.config.monthlyUsd[provider]
    )
      return { allow: false, reason: "monthly_budget_exceeded" };
    return { allow: true };
  }

  async overrun(runId: string, model: string): Promise<boolean> {
    return !(await this.callCheck(runId, model)).allow;
  }

  async notifyExhausted(status: BudgetStatus): Promise<void> {
    if (!allExhausted(status) || this.deps.issues === undefined) return;
    const period = status.period;
    try {
      if (!(await this.deps.repo.claimAlert(period, this.deps.now()))) return;
    } catch (error) {
      logDiagnostic("budget_alert_failed", { error: errorKind(error) });
      return;
    }
    try {
      const number = await this.deps.issues.createIssue(
        this.deps.factoryRepo,
        `예산 소진: ${period} 청구 주기에 두 계정이 월 상한에 도달`,
        this.issueBody(status),
      );
      await this.deps.repo.recordAlertIssue(period, number);
    } catch (error) {
      logDiagnostic("budget_alert_failed", { error: errorKind(error) });
      await this.deps.repo.releaseAlert(period).catch(() => undefined);
    }
  }

  private issueBody(status: BudgetStatus): string {
    const lines = PROVIDERS.map((p) => {
      const b = status.providers[p];
      return `| ${p === "anthropic" ? "Anthropic" : "OpenAI"} | ${usd(b.spentUsd)} | $${b.limitUsd.toFixed(2)} |`;
    });
    return [
      `${status.period} 청구 주기(UTC 달력 월)에 Anthropic과 OpenAI 계정의 추정 지출이 모두 월 상한에 도달했다. 남은 예산이 실행 하나의 상한($${status.runCapUsd.toFixed(2)})보다 적으면 상한에 도달한 것으로 본다.`,
      "",
      "| 계정 | 추정 지출 | 월 상한 |",
      "| --- | --- | --- |",
      ...lines,
      "",
      "팩토리는 다음 청구 주기가 시작될 때까지 새 실행을 시작하지 않는다. 리뷰를 기다리는 PR은 `awaiting_engine` 상태로 남아 있다가 예산이 생기면 이어서 진행한다.",
      "",
      "지출은 제어 평면이 기록한 호출별 토큰 수에 고정 단가를 곱한 추정치이며, 실제 청구액과 다를 수 있다. 이 이슈는 청구 주기마다 한 번만 등록되고, 팩토리의 자동 처리 대상이 아니다.",
    ].join("\n");
  }
}
