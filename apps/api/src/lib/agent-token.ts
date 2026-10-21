import { sha256Hex } from "./hash";

export const AGENT_TOKEN_PREFIX = "sfa_";

export function newAgentToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return AGENT_TOKEN_PREFIX + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const hashAgentToken = (token: string): Promise<string> => sha256Hex(token);

// Authorization 헤더의 토큰이 에이전트 토큰이면 그 토큰 문자열을, 아니면 null을 돌려준다.
export function agentTokenOf(header: string | undefined): string | null {
  const match = /^(?:Token|Bearer) (sfa_\S+)$/.exec(header ?? "");
  return match ? match[1]! : null;
}

// 폐기되지 않은 에이전트 토큰이면 에이전트 사용자 id, 아니면 "invalid".
export async function readAgentToken(db: D1Database, token: string): Promise<number | "invalid"> {
  const row = await db
    .prepare("SELECT user_id FROM agent_tokens WHERE token_hash = ? AND revoked_at IS NULL")
    .bind(await hashAgentToken(token))
    .first<{ user_id: number }>();
  return row ? row.user_id : "invalid";
}
