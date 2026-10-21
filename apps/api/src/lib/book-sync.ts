import type { Env } from "../env";

type ManifestEntry = { revision: string | number; anchors?: Record<string, string> };

export function docPath(docId: string): { kind: string; path: string } | null {
  if (docId === "preface")
    return { kind: "preface", path: "manuscript/front-matter/00-preface.md" };
  if (/^ch\d+$/.test(docId)) return { kind: "chapter", path: `manuscript/chapters/${docId}.md` };
  if (/^p\d+$/.test(docId)) return { kind: "pattern", path: `manuscript/patterns/${docId}.md` };
  const demo = /^demo-([A-Za-z0-9_-]+)$/.exec(docId);
  if (demo) return { kind: "demo", path: `manuscript/demo/${demo[1]}.md` };
  return null;
}

export function parseManuscript(md: string): { title: string; headings: string[] } {
  let title = "";
  const headings: string[] = [];
  let fence: string | null = null;
  for (const line of md.split(/\r?\n/)) {
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (f) {
      if (fence === null) fence = f[1]![0]!;
      else if (f[1]![0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    if (!title && /^# /.test(line)) title = line.slice(2).trim();
    else if (/^## /.test(line)) headings.push(line.slice(3).trim());
  }
  return { title, headings };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** DB를 바꾸기 전에 매니페스트 구조를 검증한다. 잘못된 응답은 동기화 실패로 다룬다. */
function validateManifest(raw: unknown): Record<string, ManifestEntry> {
  if (!isRecord(raw)) throw new Error("manifest is not an object");
  let docs = 0;
  for (const [docId, entry] of Object.entries(raw)) {
    if (!docPath(docId)) continue;
    if (!isRecord(entry)) throw new Error(`bad manifest entry for ${docId}`);
    const { revision, anchors } = entry;
    if (typeof revision !== "string" && typeof revision !== "number")
      throw new Error(`bad revision for ${docId}`);
    if (anchors !== undefined) {
      if (!isRecord(anchors) || !Object.values(anchors).every((a) => typeof a === "string"))
        throw new Error(`bad anchors for ${docId}`);
    }
    docs += 1;
  }
  if (docs === 0) throw new Error("manifest has no documents");
  return raw as Record<string, ManifestEntry>;
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  return res.text();
}

/** 매니페스트와 revision이 바뀐 원고를 읽어 한 번에 반영한다. 어느 단계든 실패하면 아무것도 바꾸지 않는다. */
export async function syncBook(env: Env): Promise<void> {
  const base = env.BOOK_SOURCE_URL?.replace(/\/+$/, "");
  if (!base) throw new Error("BOOK_SOURCE_URL is not set");
  const manifest = validateManifest(
    JSON.parse(await getText(`${base}/website/content-manifest.json`)),
  );
  const existing = await env.DB.prepare("SELECT doc_id, revision FROM book_documents").all<{
    doc_id: string;
    revision: number;
  }>();
  const known = new Map(existing.results.map((r) => [r.doc_id, r.revision]));

  const stmts: D1PreparedStatement[] = [];
  const ids: string[] = [];
  let position = 0;
  for (const [docId, entry] of Object.entries(manifest)) {
    const info = docPath(docId);
    if (!info) continue;
    const revision = Number(entry.revision);
    if (!Number.isInteger(revision)) throw new Error(`bad revision for ${docId}`);
    position += 1;
    ids.push(docId);
    if (known.get(docId) === revision) {
      stmts.push(
        env.DB.prepare("UPDATE book_documents SET position = ? WHERE doc_id = ?").bind(
          position,
          docId,
        ),
      );
      continue;
    }
    const { title, headings } = parseManuscript(await getText(`${base}/${info.path}`));
    if (!title) throw new Error(`no title in ${docId}`);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO book_documents (doc_id, kind, title, revision, position) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(doc_id) DO UPDATE SET kind = excluded.kind, title = excluded.title,
           revision = excluded.revision, position = excluded.position`,
      ).bind(docId, info.kind, title, revision, position),
      env.DB.prepare("DELETE FROM book_sections WHERE doc_id = ?").bind(docId),
    );
    const seen = new Set<string>();
    let sp = 0;
    for (const heading of headings) {
      const anchor = entry.anchors?.[heading];
      if (!anchor || seen.has(anchor)) continue;
      seen.add(anchor);
      sp += 1;
      stmts.push(
        env.DB.prepare(
          "INSERT INTO book_sections (doc_id, anchor, heading, position) VALUES (?, ?, ?, ?)",
        ).bind(docId, anchor, heading, sp),
      );
    }
  }
  for (const id of known.keys()) {
    if (!ids.includes(id)) {
      stmts.push(
        env.DB.prepare("DELETE FROM book_sections WHERE doc_id = ?").bind(id),
        env.DB.prepare("DELETE FROM book_documents WHERE doc_id = ?").bind(id),
      );
    }
  }
  stmts.push(
    env.DB.prepare(
      `INSERT INTO book_meta (id, synced_at) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET synced_at = excluded.synced_at`,
    ).bind(new Date().toISOString()),
  );
  await env.DB.batch(stmts);
}
