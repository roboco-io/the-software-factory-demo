import type { BudgetInfo } from "./api";

type ProviderInfo = BudgetInfo["providers"]["anthropic"];

const money = (n: number | null) =>
  n === null ? "알 수 없음" : `$${n.toFixed(2)}`;

function amounts(info: BudgetInfo): string {
  const one = (name: string, p: ProviderInfo) =>
    p.spentUsd === null
      ? `${name} ${money(null)}`
      : `${name} ${money(p.spentUsd)} / ${money(p.limitUsd)}`;
  return `${one("Anthropic", info.providers.anthropic)}, ${one("OpenAI", info.providers.openai)}`;
}

/**
 * Stage 5. The notice the portal shows above every screen, or null in normal mode.
 * Spend is an estimate: recorded tokens times fixed prices.
 */
export function budgetNotice(
  info: BudgetInfo,
): { kind: "alert" | "status"; text: string } | null {
  if (info.mode === "paused") {
    return {
      kind: "alert",
      text: `${info.period} 청구 주기(UTC 달력 월)의 예산이 두 계정 모두 소진되어 팩토리가 새 실행을 멈췄습니다. 다음 달 1일(UTC)에 다시 시작하며, 리뷰를 기다리는 PR은 그때 이어서 진행합니다. 추정 지출: ${amounts(info)}.`,
    };
  }
  if (info.mode === "single_engine") {
    const left = info.providers.anthropic.exhausted ? "OpenAI" : "Anthropic";
    return {
      kind: "status",
      text: `${info.period} 청구 주기에 한 계정의 예산이 소진되어 ${left} 엔진만 씁니다. 위험 등급 T0·T1 변경은 같은 엔진의 다른 모델이 새 세션에서 리뷰하고, T2·T3 변경은 다른 엔진을 쓸 수 있을 때까지 기다립니다. 추정 지출: ${amounts(info)}.`,
    };
  }
  return null;
}
