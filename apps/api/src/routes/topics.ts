import { Hono } from "hono";
import type { AppEnv } from "../env";
import { readWrapped, requireString } from "../lib/body";
import { blank, forbidden, invalid, notFound, tooLong } from "../lib/errors";
import { authedUserId, requireAuth } from "../middleware/auth";

export const topicsRouter = new Hono<AppEnv>();

const KINDS = ["question", "argument", "case", "general"];

type TopicRow = {
  id: number;
  title: string;
  body: string;
  kind: string;
  author_id: number;
  username: string;
  image: string | null;
  doc_id: string | null;
  anchor: string | null;
  doc_revision: number | null;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
  reply_count: number;
  current_revision: number | null;
  section_exists: number | null;
};

const SELECT = `SELECT t.id, t.title, t.body, t.kind, t.author_id, u.username, u.image,
  t.doc_id, t.anchor, t.doc_revision, t.created_at, t.updated_at, t.last_activity_at,
  (SELECT COUNT(*) FROM replies r WHERE r.topic_id = t.id AND r.deleted = 0) AS reply_count,
  d.revision AS current_revision,
  (SELECT 1 FROM book_sections s WHERE s.doc_id = t.doc_id AND s.anchor = t.anchor) AS section_exists
  FROM topics t JOIN users u ON u.id = t.author_id
  LEFT JOIN book_documents d ON d.doc_id = t.doc_id`;

function serialize(r: TopicRow) {
  let book = null;
  if (r.doc_id !== null) {
    let status = "current";
    if (r.current_revision === null || (r.anchor !== null && !r.section_exists)) status = "removed";
    else if (r.current_revision > (r.doc_revision ?? 0)) status = "revised";
    book = { docId: r.doc_id, anchor: r.anchor, revision: r.doc_revision, status };
  }
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    kind: r.kind,
    author: { username: r.username, image: r.image },
    book,
    replyCount: r.reply_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastActivityAt: r.last_activity_at,
  };
}

function checkText(value: unknown, field: string, max: number): string {
  const s = requireString(value, field);
  if (s.length > max) throw tooLong(field, max);
  return s;
}

function checkKind(value: unknown): string {
  if (typeof value !== "string" || !KINDS.includes(value)) throw invalid("kind");
  return value;
}

async function loadTopic(c: { env: AppEnv["Bindings"] }, rawId: string): Promise<TopicRow> {
  const id = Number(rawId);
  const row = Number.isInteger(id)
    ? await c.env.DB.prepare(`${SELECT} WHERE t.id = ?`).bind(id).first<TopicRow>()
    : null;
  if (!row) throw notFound("topic");
  return row;
}

topicsRouter.get("/topics", async (c) => {
  const q = c.req.query();
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q.docId) {
    where.push("t.doc_id = ?");
    params.push(q.docId);
  }
  if (q.anchor) {
    where.push("t.anchor = ?");
    params.push(q.anchor);
  }
  if (q.kind) {
    where.push("t.kind = ?");
    params.push(q.kind);
  }
  if (q.author) {
    where.push("u.username = ?");
    params.push(q.author);
  }
  const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const num = (v: string | undefined, def: number, max: number) => {
    const n = v === undefined ? def : Number(v);
    return Number.isInteger(n) && n >= 0 ? Math.min(n, max) : def;
  };
  const limit = num(q.limit, 20, 100);
  const offset = num(q.offset, 0, Number.MAX_SAFE_INTEGER);
  const order =
    q.sort === "new" ? "t.created_at DESC, t.id DESC" : "t.last_activity_at DESC, t.id DESC";
  const count = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM topics t JOIN users u ON u.id = t.author_id${clause}`,
  )
    .bind(...params)
    .first<{ n: number }>();
  const { results } = await c.env.DB.prepare(
    `${SELECT}${clause} ORDER BY ${order} LIMIT ? OFFSET ?`,
  )
    .bind(...params, limit, offset)
    .all<TopicRow>();
  return c.json({ topics: results.map(serialize), topicsCount: count?.n ?? 0 });
});

topicsRouter.get("/topics/:id", async (c) => {
  return c.json({ topic: serialize(await loadTopic(c, c.req.param("id"))) });
});

topicsRouter.post("/topics", requireAuth, async (c) => {
  const userId = authedUserId(c);
  const input = await readWrapped<{
    title: unknown;
    body: unknown;
    kind: unknown;
    docId: unknown;
    anchor: unknown;
  }>(c, "topic");
  const title = checkText(input.title, "title", 200);
  const body = checkText(input.body, "body", 20000);
  const kind = input.kind === undefined || input.kind === null ? "general" : checkKind(input.kind);
  const hasDoc = input.docId !== undefined && input.docId !== null;
  const hasAnchor = input.anchor !== undefined && input.anchor !== null;
  let docId: string | null = null;
  let anchor: string | null = null;
  let revision: number | null = null;
  if (hasAnchor && !hasDoc) throw blank("docId");
  if (hasDoc) {
    if (typeof input.docId !== "string") throw invalid("docId");
    const doc = await c.env.DB.prepare("SELECT revision FROM book_documents WHERE doc_id = ?")
      .bind(input.docId)
      .first<{ revision: number }>();
    if (!doc) throw invalid("docId");
    docId = input.docId;
    revision = doc.revision;
    if (hasAnchor) {
      if (typeof input.anchor !== "string") throw invalid("anchor");
      const s = await c.env.DB.prepare(
        "SELECT 1 AS ok FROM book_sections WHERE doc_id = ? AND anchor = ?",
      )
        .bind(docId, input.anchor)
        .first();
      if (!s) throw invalid("anchor");
      anchor = input.anchor;
    }
  }
  const now = new Date().toISOString();
  const res = await c.env.DB.prepare(
    `INSERT INTO topics (title, body, kind, author_id, doc_id, anchor, doc_revision, created_at, updated_at, last_activity_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(title, body, kind, userId, docId, anchor, revision, now, now, now)
    .run();
  const row = await loadTopic(c, String(res.meta.last_row_id));
  return c.json({ topic: serialize(row) }, 201);
});

topicsRouter.put("/topics/:id", requireAuth, async (c) => {
  const userId = authedUserId(c);
  const row = await loadTopic(c, c.req.param("id"));
  if (row.author_id !== userId) throw forbidden("topic");
  const input = await readWrapped<{ title: unknown; body: unknown; kind: unknown }>(c, "topic");
  const title = input.title === undefined ? row.title : checkText(input.title, "title", 200);
  const body = input.body === undefined ? row.body : checkText(input.body, "body", 20000);
  const kind = input.kind === undefined ? row.kind : checkKind(input.kind);
  await c.env.DB.prepare(
    "UPDATE topics SET title = ?, body = ?, kind = ?, updated_at = ? WHERE id = ?",
  )
    .bind(title, body, kind, new Date().toISOString(), row.id)
    .run();
  return c.json({ topic: serialize(await loadTopic(c, String(row.id))) });
});

topicsRouter.delete("/topics/:id", requireAuth, async (c) => {
  const userId = authedUserId(c);
  const row = await loadTopic(c, c.req.param("id"));
  if (row.author_id !== userId) throw forbidden("topic");
  await c.env.DB.prepare("DELETE FROM topics WHERE id = ?").bind(row.id).run();
  return c.body(null, 204);
});
