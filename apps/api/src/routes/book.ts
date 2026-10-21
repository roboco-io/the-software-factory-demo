import { Hono } from "hono";
import type { AppEnv } from "../env";
import { notFound } from "../lib/errors";

export const bookRouter = new Hono<AppEnv>();

type DocRow = {
  doc_id: string;
  kind: string;
  title: string;
  revision: number;
  topic_count: number;
};

const serializeDoc = (r: DocRow) => ({
  docId: r.doc_id,
  kind: r.kind,
  title: r.title,
  revision: r.revision,
  topicCount: r.topic_count,
});

const DOC_SQL = `SELECT d.doc_id, d.kind, d.title, d.revision,
  (SELECT COUNT(*) FROM topics t WHERE t.doc_id = d.doc_id) AS topic_count
  FROM book_documents d`;

bookRouter.get("/book", async (c) => {
  const { results } = await c.env.DB.prepare(`${DOC_SQL} ORDER BY d.position`).all<DocRow>();
  const meta = await c.env.DB.prepare("SELECT synced_at FROM book_meta WHERE id = 1").first<{
    synced_at: string;
  }>();
  return c.json({ documents: results.map(serializeDoc), syncedAt: meta?.synced_at ?? null });
});

bookRouter.get("/book/:docId", async (c) => {
  const docId = c.req.param("docId");
  const doc = await c.env.DB.prepare(`${DOC_SQL} WHERE d.doc_id = ?`).bind(docId).first<DocRow>();
  if (!doc) throw notFound("document");
  const { results } = await c.env.DB.prepare(
    `SELECT s.anchor, s.heading,
      (SELECT COUNT(*) FROM topics t WHERE t.doc_id = s.doc_id AND t.anchor = s.anchor) AS topic_count
     FROM book_sections s WHERE s.doc_id = ? ORDER BY s.position`,
  )
    .bind(docId)
    .all<{ anchor: string; heading: string; topic_count: number }>();
  return c.json({
    document: {
      ...serializeDoc(doc),
      sections: results.map((s) => ({
        anchor: s.anchor,
        heading: s.heading,
        topicCount: s.topic_count,
      })),
    },
  });
});
