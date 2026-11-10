import type { Api, BudgetInfo, BudgetLimits, Me } from "./api";
import { h } from "./dom";

const MAX_LIMIT_USD = 100_000;
const money = (n: number | null) =>
  n === null ? "알 수 없음" : `$${n.toFixed(2)}`;

const MODE_TEXT: Record<BudgetInfo["mode"], string> = {
  normal: "정상: 두 엔진을 모두 씁니다.",
  single_engine: "단일 엔진: 한 계정의 한도가 소진되어 남은 엔진만 씁니다.",
  paused: "중지: 두 계정 모두 소진되어 새 실행을 받지 않습니다.",
};

function sourceText(info: BudgetInfo): string {
  const l = info.limits;
  if (l === undefined || l.source === "default" || l.updatedAt === null)
    return "한도 출처: 기본값(배포 설정의 환경 변수). 운영자가 아직 바꾸지 않았습니다.";
  const at = new Date(l.updatedAt).toISOString().slice(0, 16).replace("T", " ");
  return `한도 출처: 운영자 변경(${at} UTC). 변경은 다음 모델 호출부터 바로 적용됩니다.`;
}

/** One amount from a form field, or null when it is empty, not a number, or out of range. */
function amount(raw: string): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= MAX_LIMIT_USD ? n : null;
}

function limitsForm(
  info: BudgetInfo,
  deps: { api: Api; done(): void },
): HTMLElement {
  const field = (name: keyof BudgetLimits, label: string, value: number) =>
    h(
      "label",
      null,
      label,
      h("input", {
        type: "number",
        name,
        min: "0",
        max: String(MAX_LIMIT_USD),
        step: "0.01",
        required: "",
        value: String(value),
      }),
    );
  const message = h("div");
  const save = h("button", { type: "submit" }, "한도 저장");
  const form = h(
    "form",
    { class: "budget-limits", novalidate: "" },
    h(
      "p",
      { class: "note" },
      "운영자만 바꿀 수 있습니다. 배포 없이 바로 적용되고, 누가 언제 바꿨는지 기록됩니다. 한도를 0으로 두면 그 계정은 소진으로 취급됩니다.",
    ),
    field(
      "anthropicUsd",
      "Anthropic 월 한도(USD)",
      info.providers.anthropic.limitUsd,
    ),
    field("openaiUsd", "OpenAI 월 한도(USD)", info.providers.openai.limitUsd),
    field("runCapUsd", "실행 1건 상한(USD)", info.runCapUsd),
    save,
    message,
  );
  const show = (kind: "alert" | "status", text: string) =>
    message.replaceChildren(
      h("div", { class: `message ${kind}`, role: kind }, text),
    );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const read = (name: keyof BudgetLimits) =>
      amount(
        form.querySelector<HTMLInputElement>(`input[name="${name}"]`)?.value ??
          "",
      );
    const anthropicUsd = read("anthropicUsd");
    const openaiUsd = read("openaiUsd");
    const runCapUsd = read("runCapUsd");
    if (anthropicUsd === null || openaiUsd === null || runCapUsd === null) {
      show(
        "alert",
        `세 값 모두 0 이상 ${MAX_LIMIT_USD} 이하의 숫자여야 합니다.`,
      );
      return;
    }
    save.disabled = true;
    deps.api
      .setBudgetLimits({ anthropicUsd, openaiUsd, runCapUsd })
      .then(() => deps.done())
      .catch(() => {
        save.disabled = false;
        show(
          "alert",
          "한도를 저장하지 못했습니다. 운영자로 로그인했는지 확인하고 다시 시도해 주세요.",
        );
      });
  });
  return form;
}

/**
 * Stage 5. This period's estimated spend against the limits in force. Everyone sees it;
 * an operator also gets a form that changes the limits without a deploy.
 */
export async function budgetPanel(deps: {
  api: Api;
  me: Me;
  done(): void;
}): Promise<HTMLElement> {
  let info: BudgetInfo;
  try {
    info = await deps.api.budget();
  } catch {
    return h(
      "p",
      { class: "note budget-panel" },
      "예산 정보를 지금 읽을 수 없습니다.",
    );
  }
  const row = (name: string, p: BudgetInfo["providers"]["anthropic"]) =>
    h(
      "tr",
      null,
      h("th", { scope: "row" }, name),
      h("td", null, `${money(p.spentUsd)} / ${money(p.limitUsd)}`),
      h("td", null, p.exhausted ? "소진" : "여유 있음"),
    );
  return h(
    "div",
    { class: "budget-panel" },
    h(
      "p",
      null,
      `${info.period} 청구 주기(UTC 달력 월). ${MODE_TEXT[info.mode]} 지출은 기록된 토큰 수에 고정 단가를 곱한 추정치입니다.`,
    ),
    h(
      "table",
      null,
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          h("th", null, "계정"),
          h("th", null, "추정 지출 / 월 한도"),
          h("th", null, "상태"),
        ),
      ),
      h(
        "tbody",
        null,
        row("Anthropic", info.providers.anthropic),
        row("OpenAI", info.providers.openai),
      ),
    ),
    h("p", null, `실행 1건 상한: ${money(info.runCapUsd)}`),
    h("p", { class: "note" }, sourceText(info)),
    deps.me.role === "operator" ? limitsForm(info, deps) : null,
  );
}
