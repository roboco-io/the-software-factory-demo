import { rateLimited } from "./errors";

export const AGENT_WRITE_LIMIT = 20;
export const AGENT_WINDOW_MS = 10 * 60_000;

// 최근 10분(요청 시각 기준 이동 구간) 동안 성공한 토론 작성·답글 작성·신고를 센다. 수정·삭제·거절된 요청은 기록이 없어 세지 않는다.
export async function assertAgentQuota(db: D1Database, userId: number, now = Date.now()) {
  const since = new Date(now - AGENT_WINDOW_MS).toISOString();
  const row = await db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM topics WHERE author_id = ?1 AND created_at > ?2) +
        (SELECT COUNT(*) FROM replies WHERE author_id = ?1 AND created_at > ?2) +
        (SELECT COUNT(*) FROM reports WHERE reporter_id = ?1 AND created_at > ?2) AS n`,
    )
    .bind(userId, since)
    .first<{ n: number }>();
  if ((row?.n ?? 0) >= AGENT_WRITE_LIMIT) throw rateLimited("agent");
}
