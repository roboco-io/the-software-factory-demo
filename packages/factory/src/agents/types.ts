export const ENGINES = ["claude", "codex", "pi"] as const;
export type EngineName = (typeof ENGINES)[number];
export type Role = "triage" | "implement" | "review" | "fix" | "improve" | "postmortem";
export type FailureReason = "max_turns" | "timeout" | "budget" | "engine_error" | "invalid_output";

export interface Budget {
  maxTurns: number;
  timeoutMs: number;
  maxUsd?: number;
}

export interface AgentTask {
  role: Role;
  prompt: string; // factory/prompts/<role>.md 템플릿 + 이슈/PR 컨텍스트
  cwd: string;
  readOnly: boolean; // triage, review는 true
  budget: Budget;
  signal?: AbortSignal; // runWithBudget()이 채운다
}

export interface AgentResult {
  ok: boolean;
  summary: string; // 최종 메시지
  structured?: unknown; // triage·review의 JSON 출력(검증 후)
  model: string;
  turns: number;
  costUsd?: number; // 엔진이 제공하는 추정치. 청구 금액이 아님
  usage: { inputTokens: number; outputTokens: number };
  failureReason?: FailureReason;
}

export interface AgentAdapter {
  readonly name: EngineName | "fake";
  run(task: AgentTask): Promise<AgentResult>;
}

export function failedResult(model: string, reason: FailureReason, summary: string): AgentResult {
  return {
    ok: false,
    summary,
    model,
    turns: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    failureReason: reason,
  };
}
