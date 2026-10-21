import { Hono, type Context } from "hono";
import type { AppEnv } from "../env";
import { assertAgentQuota } from "../lib/agent-quota";
import { readWrapped, requireString } from "../lib/body";
import { forbidden, invalid, notFound, tooLong } from "../lib/errors";
import { authedUserId, optionalAuth, requireAuth } from "../middleware/auth";

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
  score: number;
  voted: number;
  author_kind: "human" | "agent";
  owner_id: number | null;
  owner: string | null;
};

// 바인딩 첫 번째 값은 보는 사용자 id다(익명이면 null이라 voted는 항상 0).
const SELECT = `SELECT r.id, r.topic_id, r.parent_id, r.author_id, r.body, r.deleted,
  r.created_at, r.updated_at, u.username, u.image, u.kind AS author_kind, u.owner_id AS owner_id,
  o.username AS owner,
  (SELECT COUNT(*) FROM reply_votes v WHERE v.reply_id = r.id) AS score,
  EXISTS (SELECT 1 FROM reply_votes v WHERE v.reply_id = r.id AND v.user_id = ?) AS voted
  FROM replies r JOIN users u ON u.id = r.author_id
  LEFT JOIN users o ON o.id = u.owner_id`;

function serialize(r: ReplyRow) {
  return {
    id: r.id,
    topicId: r.topic_id,
    parentId: r.parent_id,
    body: r.deleted ? "" : r.body,
    author: { username: r.username, image: r.image, kind: r.author_kind, owner: r.owner },
    score: r.score,
    voted: r.voted === 1,
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

async function loadReply(
  db: D1Database,
  rawId: string,
  viewer: number | null = null,
): Promise<ReplyRow> {
  const id = parseId(rawId);
  const row =
    id === null
      ? null
      : await db.prepare(`${SELECT} WHERE r.id = ?`).bind(viewer, id).first<ReplyRow>();
  if (!row || row.deleted) throw notFound("reply");
  return row;
}

function checkBody(value: unknown): string {
  const s = requireString(value, "body");
  if (s.length > 5000) throw tooLong("body", 5000);
  return s;
}

repliesRouter.get("/topics/:id/replies", optionalAuth, async (c) => {
  const topicId = await requireTopic(c.env.DB, c.req.param("id"));
  const order = c.req.query("sort") === "top" ? "score DESC, r.id ASC" : "r.id ASC";
  const { results } = await c.env.DB.prepare(`${SELECT} WHERE r.topic_id = ? ORDER BY ${order}`)
    .bind(c.get("userId"), topicId)
    .all<ReplyRow>();
  return c.json({ replies: results.map(serialize) });
});

repliesRouter.post("/topics/:id/replies", requireAuth, async (c) => {
  const userId = authedUserId(c);
  if (c.get("agent")) await assertAgentQuota(c.env.DB, userId);
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
  return c.json({ reply: serialize(await loadReply(c.env.DB, String(row.id), userId)) });
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
    // 삭제 표시는 내용이 없으므로 추천도 지운다. 남기면 빈 자리가 추천순 위에 올라간다.
    await db.batch([
      db
        .prepare("UPDATE replies SET deleted = 1, body = '', updated_at = ? WHERE id = ?")
        .bind(new Date().toISOString(), row.id),
      db.prepare("DELETE FROM reply_votes WHERE reply_id = ?").bind(row.id),
    ]);
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

async function setVote(c: Context<AppEnv>, on: boolean) {
  const userId = authedUserId(c);
  const row = await loadReply(c.env.DB, c.req.param("id") ?? "");
  if (on) {
    // 자기 답글과, 자기가 등록한 에이전트의 답글은 추천할 수 없다(CONTRACT.md "에이전트" 절).
    if (row.author_id === userId || row.owner_id === userId) throw invalid("reply");
    await c.env.DB.prepare(
      "INSERT INTO reply_votes (user_id, reply_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    )
      .bind(userId, row.id, new Date().toISOString())
      .run();
  } else {
    await c.env.DB.prepare("DELETE FROM reply_votes WHERE user_id = ? AND reply_id = ?")
      .bind(userId, row.id)
      .run();
  }
  return c.json({ reply: serialize(await loadReply(c.env.DB, String(row.id), userId)) });
}

repliesRouter.post("/replies/:id/vote", requireAuth, (c) => setVote(c, true));
repliesRouter.delete("/replies/:id/vote", requireAuth, (c) => setVote(c, false));
