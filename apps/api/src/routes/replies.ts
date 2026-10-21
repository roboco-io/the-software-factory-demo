import { Hono } from "hono";
import type { AppEnv } from "../env";
import { readWrapped, requireString } from "../lib/body";
import { forbidden, invalid, notFound, tooLong } from "../lib/errors";
import { authedUserId, requireAuth } from "../middleware/auth";

export const repliesRouter = new Hono<AppEnv>();

type ReplyRow = {
  id: number;
  topic_id: number;
  parent_id: number | null;
  author_id: number;
  body: string;
  deleted: number;
  created_at: string;
  updated_at: string;
  username: string;
  image: string | null;
};

const SELECT = `SELECT r.id, r.topic_id, r.parent_id, r.author_id, r.body, r.deleted,
  r.created_at, r.updated_at, u.username, u.image
  FROM replies r JOIN users u ON u.id = r.author_id`;

function serialize(r: ReplyRow) {
  return {
    id: r.id,
    topicId: r.topic_id,
    parentId: r.parent_id,
    body: r.deleted ? "" : r.body,
    author: { username: r.username, image: r.image },
    score: 0,
    voted: false,
    deleted: r.deleted === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) ? id : null;
}

async function requireTopic(db: D1Database, rawId: string): Promise<number> {
  const id = parseId(rawId);
  const row =
    id === null
      ? null
      : await db.prepare("SELECT id FROM topics WHERE id = ?").bind(id).first<{ id: number }>();
  if (!row) throw notFound("topic");
  return row.id;
}

async function loadReply(db: D1Database, rawId: string): Promise<ReplyRow> {
  const id = parseId(rawId);
  const row =
    id === null ? null : await db.prepare(`${SELECT} WHERE r.id = ?`).bind(id).first<ReplyRow>();
  if (!row || row.deleted) throw notFound("reply");
  return row;
}

function checkBody(value: unknown): string {
  const s = requireString(value, "body");
  if (s.length > 5000) throw tooLong("body", 5000);
  return s;
}

repliesRouter.get("/topics/:id/replies", async (c) => {
  const topicId = await requireTopic(c.env.DB, c.req.param("id"));
  const { results } = await c.env.DB.prepare(`${SELECT} WHERE r.topic_id = ? ORDER BY r.id ASC`)
    .bind(topicId)
    .all<ReplyRow>();
  return c.json({ replies: results.map(serialize) });
});

repliesRouter.post("/topics/:id/replies", requireAuth, async (c) => {
  const userId = authedUserId(c);
  const topicId = await requireTopic(c.env.DB, c.req.param("id"));
  const input = await readWrapped<{ body: unknown; parentId: unknown }>(c, "reply");
  const body = checkBody(input.body);
  let parentId: number | null = null;
  if (input.parentId !== undefined && input.parentId !== null) {
    if (typeof input.parentId !== "number" || !Number.isInteger(input.parentId))
      throw invalid("parentId");
    const parent = await c.env.DB.prepare("SELECT id FROM replies WHERE id = ? AND topic_id = ?")
      .bind(input.parentId, topicId)
      .first();
    if (!parent) throw invalid("parentId");
    parentId = input.parentId;
  }
  const now = new Date().toISOString();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO replies (topic_id, parent_id, author_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(topicId, parentId, userId, body, now, now),
    c.env.DB.prepare("UPDATE topics SET last_activity_at = ? WHERE id = ?").bind(now, topicId),
  ]);
  const row = await loadReply(c.env.DB, String(results[0]?.meta.last_row_id));
  return c.json({ reply: serialize(row) }, 201);
});

repliesRouter.put("/replies/:id", requireAuth, async (c) => {
  const userId = authedUserId(c);
  const row = await loadReply(c.env.DB, c.req.param("id"));
  if (row.author_id !== userId) throw forbidden("reply");
  const input = await readWrapped<{ body: unknown }>(c, "reply");
  const body = checkBody(input.body);
  await c.env.DB.prepare("UPDATE replies SET body = ?, updated_at = ? WHERE id = ?")
    .bind(body, new Date().toISOString(), row.id)
    .run();
  return c.json({ reply: serialize(await loadReply(c.env.DB, String(row.id))) });
});

repliesRouter.delete("/replies/:id", requireAuth, async (c) => {
  const userId = authedUserId(c);
  const row = await loadReply(c.env.DB, c.req.param("id"));
  if (row.author_id !== userId) throw forbidden("reply");
  const db = c.env.DB;
  const hasChildren = await db
    .prepare("SELECT 1 AS ok FROM replies WHERE parent_id = ?")
    .bind(row.id)
    .first();
  if (hasChildren) {
    await db
      .prepare("UPDATE replies SET deleted = 1, body = '', updated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), row.id)
      .run();
    return c.body(null, 204);
  }
  // 잎 답글은 지우고, 더는 하위 답글이 없는 삭제 표시 조상도 함께 지운다.
  let current: { id: number; parent_id: number | null } | null = row;
  while (current) {
    const parentId: number | null = current.parent_id;
    await db.prepare("DELETE FROM replies WHERE id = ?").bind(current.id).run();
    current = null;
    if (parentId !== null) {
      const parent: { id: number; parent_id: number | null } | null = await db
        .prepare(
          `SELECT id, parent_id FROM replies p WHERE p.id = ? AND p.deleted = 1
           AND NOT EXISTS (SELECT 1 FROM replies c WHERE c.parent_id = p.id)`,
        )
        .bind(parentId)
        .first<{ id: number; parent_id: number | null }>();
      current = parent;
    }
  }
  return c.body(null, 204);
});
