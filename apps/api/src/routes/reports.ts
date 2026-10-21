import { Hono, type Context } from "hono";
import type { AppEnv } from "../env";
import { readWrapped, requireString } from "../lib/body";
import { notFound, tooLong } from "../lib/errors";
import { authedUserId, requireAuth } from "../middleware/auth";

export const reportsRouter = new Hono<AppEnv>();

const REASON_MAX = 500;

type TargetType = "topic" | "reply";

type ReportRow = {
  id: number;
  target_type: TargetType;
  target_id: number;
  reason: string;
  created_at: string;
};

const serialize = (r: ReportRow) => ({
  id: r.id,
  targetType: r.target_type,
  targetId: r.target_id,
  reason: r.reason,
  createdAt: r.created_at,
});

// 신고는 접수만 한다. 숨김은 사람이 데이터베이스에서 처리한다(2026-10-21 사용자 결정, 이슈 #90).
// 삭제 표시로 남은 답글은 내용이 없으므로 신고 대상이 아니다.
async function targetExists(db: D1Database, type: TargetType, raw: string): Promise<number> {
  const id = Number(raw);
  const sql =
    type === "topic"
      ? "SELECT id FROM topics WHERE id = ?"
      : "SELECT id FROM replies WHERE id = ? AND deleted = 0";
  const row = Number.isInteger(id) ? await db.prepare(sql).bind(id).first<{ id: number }>() : null;
  if (!row) throw notFound(type);
  return row.id;
}

async function fileReport(c: Context<AppEnv>, type: TargetType) {
  const userId = authedUserId(c);
  const targetId = await targetExists(c.env.DB, type, c.req.param("id") ?? "");
  const input = await readWrapped<{ reason: unknown }>(c, "report");
  const reason = requireString(input.reason, "reason");
  if (reason.length > REASON_MAX) throw tooLong("reason", REASON_MAX);
  const find = c.env.DB.prepare(
    `SELECT id, target_type, target_id, reason, created_at FROM reports
     WHERE reporter_id = ? AND target_type = ? AND target_id = ?`,
  ).bind(userId, type, targetId);
  const existing = await find.first<ReportRow>();
  if (existing) return c.json({ report: serialize(existing) }, 200);
  const inserted = await c.env.DB.prepare(
    `INSERT INTO reports (reporter_id, target_type, target_id, reason, created_at)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  )
    .bind(userId, type, targetId, reason, new Date().toISOString())
    .run();
  const row = await find.first<ReportRow>();
  if (!row) throw notFound(type);
  // 동시에 같은 신고가 들어와 INSERT가 무시되면 기존 신고로 응답한다.
  return c.json({ report: serialize(row) }, inserted.meta.changes > 0 ? 201 : 200);
}

reportsRouter.post("/topics/:id/report", requireAuth, (c) => fileReport(c, "topic"));
reportsRouter.post("/replies/:id/report", requireAuth, (c) => fileReport(c, "reply"));
