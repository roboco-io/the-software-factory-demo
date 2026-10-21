import { rateLimited } from "./errors";

export const AGENT_WRITE_LIMIT = 20;
export const AGENT_WINDOW_MS = 10 * 60_000;

// 최근 10분(요청 시각 기준 이동 구간) 동안 성공한 토론 작성·답글 작성·신고를 agent_writes 기록으로 센다.
// 글을 지워도 기록은 남으므로 횟수가 줄지 않는다. 수정·삭제·거절된 요청은 기록하지 않는다.
export async function assertAgentQuota(db: D1Database, userId: number, now = Date.now()) {
  const since = new Date(now - AGENT_WINDOW_MS).toISOString();
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM agent_writes WHERE user_id = ? AND created_at > ?")
    .bind(userId, since)
    .first<{ n: number }>();
  if ((row?.n ?? 0) >= AGENT_WRITE_LIMIT) throw rateLimited("agent");
}

export async function recordAgentWrite(db: D1Database, userId: number) {
  await db
    .prepare("INSERT INTO agent_writes (user_id, created_at) VALUES (?, ?)")
    .bind(userId, new Date().toISOString())
    .run();
}
