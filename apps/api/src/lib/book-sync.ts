import type { Env } from "../env";
import { sha256Hex } from "./hash";

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

export type ManuscriptSection = { heading: string; body: string };

// 문서 제목(첫 `# `), `## ` 절 제목, 절 본문(제목 다음 줄부터 다음 `## ` 제목 전까지)을 읽는다.
// 코드 블록 안의 `#` 줄은 제목이 아니며 본문에 포함한다.
export function parseManuscript(md: string): {
  title: string;
  headings: string[];
  sections: ManuscriptSection[];
} {
  let title = "";
  const sections: { heading: string; lines: string[] }[] = [];
  let fence: string | null = null;
  for (const line of md.split(/\r?\n/)) {
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (f) {
      if (fence === null) fence = f[1]![0]!;
      else if (f[1]![0] === fence) fence = null;
    } else if (!fence) {
      if (!title && /^# /.test(line)) {
        title = line.slice(2).trim();
        continue;
      }
      if (/^## /.test(line)) {
        sections.push({ heading: line.slice(3).trim(), lines: [] });
        continue;
      }
    }
    sections.at(-1)?.lines.push(line);
  }
  const parsed = sections.map((s) => ({
    heading: s.heading,
    body: normalizeBody(s.lines.join("\n")),
  }));
  return { title, headings: parsed.map((s) => s.heading), sections: parsed };
}

// 줄 끝 공백·CRLF·앞뒤 빈 줄 차이는 개정으로 보지 않는다.
const normalizeBody = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();

export const sectionHash = (body: string): Promise<string> => sha256Hex(normalizeBody(body));

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
  // 절 해시가 비어 있는 문서(해시 도입 이전 동기화)는 revision이 같아도 다시 읽는다.
  const existing = await env.DB.prepare(
    `SELECT d.doc_id, d.revision,
       EXISTS (SELECT 1 FROM book_sections s WHERE s.doc_id = d.doc_id AND s.hash IS NULL) AS missing_hash
     FROM book_documents d`,
  ).all<{ doc_id: string; revision: number; missing_hash: number }>();
  const known = new Map(existing.results.map((r) => [r.doc_id, r.revision]));
  const missingHash = new Set(existing.results.filter((r) => r.missing_hash).map((r) => r.doc_id));

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
    if (known.get(docId) === revision && !missingHash.has(docId)) {
      stmts.push(
        env.DB.prepare("UPDATE book_documents SET position = ? WHERE doc_id = ?").bind(
          position,
          docId,
        ),
      );
      continue;
    }
    const { title, sections } = parseManuscript(await getText(`${base}/${info.path}`));
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
    for (const { heading, body } of sections) {
      const anchor = entry.anchors?.[heading];
      if (!anchor || seen.has(anchor)) continue;
      seen.add(anchor);
      sp += 1;
      stmts.push(
        env.DB.prepare(
          "INSERT INTO book_sections (doc_id, anchor, heading, position, hash) VALUES (?, ?, ?, ?, ?)",
        ).bind(docId, anchor, heading, sp, await sectionHash(body)),
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
