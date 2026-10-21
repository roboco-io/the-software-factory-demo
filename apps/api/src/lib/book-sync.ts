import type { Env } from "../env";
import { sha256Hex } from "./hash";

type ManifestEntry = { revision: string | number; anchors?: Record<string, string> };

// 패턴(매니페스트의 pNN)은 문서 하나로 묶고 패턴 하나를 절 하나로 다룬다(2026-10-21).
export const PATTERNS_DOC = "patterns";
const PATTERNS_TITLE = "패턴";
const isPattern = (docId: string) => /^p\d+$/.test(docId);
const patternPath = (id: string) => `manuscript/patterns/${id}.md`;

export function docPath(docId: string): { kind: string; path: string } | null {
  if (docId === "preface")
    return { kind: "preface", path: "manuscript/front-matter/00-preface.md" };
  if (/^ch\d+$/.test(docId)) return { kind: "chapter", path: `manuscript/chapters/${docId}.md` };
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

// 패턴 원고는 첫 `# ` 제목이 절 제목이고, 그 다음 줄부터 파일 끝까지가 절 본문이다.
export function parsePattern(md: string): ManuscriptSection {
  const lines = md.split(/\r?\n/);
  const at = lines.findIndex((l) => /^# /.test(l));
  if (at < 0) return { heading: "", body: "" };
  return {
    heading: lines[at]!.slice(2).trim(),
    body: normalizeBody(lines.slice(at + 1).join("\n")),
  };
}

// 정규식 대신 문자열 연산으로 끝의 `/`를 지운다(설정값이라도 CodeQL ReDoS 경고를 피한다).
function trimSlashes(v: string): string {
  let end = v.length;
  while (end > 0 && v[end - 1] === "/") end -= 1;
  return v.slice(0, end);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** DB를 바꾸기 전에 매니페스트 구조를 검증한다. 잘못된 응답은 동기화 실패로 다룬다. */
function validateManifest(raw: unknown): Record<string, ManifestEntry> {
  if (!isRecord(raw)) throw new Error("manifest is not an object");
  let docs = 0;
  for (const [docId, entry] of Object.entries(raw)) {
    if (!docPath(docId) && !isPattern(docId)) continue;
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
// ref(40자 커밋 SHA)를 주면 BOOK_SOURCE_URL의 마지막 경로(브랜치 이름)를 그 커밋으로 바꿔 읽는다.
// raw.githubusercontent.com은 브랜치 주소를 몇 분간 캐시하므로, 책 배포 직후에는 커밋 주소로 읽어야 새 내용을 받는다.
// 전제: BOOK_SOURCE_URL은 `.../<owner>/<repo>/<브랜치>` 형식이고 브랜치 이름에 `/`가 없다(현재 `main`).
export async function syncBook(env: Env, opts: { ref?: string } = {}): Promise<number> {
  const configured = trimSlashes(env.BOOK_SOURCE_URL ?? "");
  if (!configured) throw new Error("BOOK_SOURCE_URL is not set");
  const base = opts.ref
    ? `${configured.slice(0, configured.lastIndexOf("/"))}/${opts.ref}`
    : configured;
  const manifest = validateManifest(
    JSON.parse(await getText(`${base}/website/content-manifest.json`)),
  );
  // 절 해시가 비어 있는 문서(해시 도입 이전 동기화)는 revision이 같아도 다시 읽는다.
  // 패턴이 빠지거나 바뀌어도 revision 합이 같을 수 있으므로 저장된 패턴 목록도 함께 읽는다.
  // 하위 요청 50회 한도 때문에 두 조회를 batch 한 번으로 보낸다.
  const [existing, storedPatterns] = (await env.DB.batch([
    env.DB.prepare(
      `SELECT d.doc_id, d.revision,
         EXISTS (SELECT 1 FROM book_sections s WHERE s.doc_id = d.doc_id AND s.hash IS NULL) AS missing_hash
       FROM book_documents d`,
    ),
    env.DB.prepare("SELECT anchor FROM book_sections WHERE doc_id = ? ORDER BY position").bind(
      PATTERNS_DOC,
    ),
  ])) as [
    D1Result<{ doc_id: string; revision: number; missing_hash: number }>,
    D1Result<{ anchor: string }>,
  ];
  const known = new Map(existing.results.map((r) => [r.doc_id, r.revision]));
  const missingHash = new Set(existing.results.filter((r) => r.missing_hash).map((r) => r.doc_id));

  // 문서 순서를 먼저 정한다. 패턴 문서는 매니페스트에서 첫 pNN이 있던 자리에 둔다.
  const plan: { docId: string; revision: number; entry?: ManifestEntry }[] = [];
  const patterns: string[] = [];
  let patternsRevision = 0;
  for (const [docId, entry] of Object.entries(manifest)) {
    const pattern = isPattern(docId);
    if (!pattern && !docPath(docId)) continue;
    const revision = Number(entry.revision);
    if (!Number.isInteger(revision)) throw new Error(`bad revision for ${docId}`);
    if (!pattern) {
      plan.push({ docId, revision, entry });
      continue;
    }
    if (patterns.length === 0) plan.push({ docId: PATTERNS_DOC, revision: 0 });
    patterns.push(docId);
    patternsRevision += revision;
  }

  const samePatterns = storedPatterns.results.map((r) => r.anchor).join(",") === patterns.join(",");

  const stmts: D1PreparedStatement[] = [];
  const ids = plan.map((p) => p.docId);
  for (const [i, doc] of plan.entries()) {
    const position = i + 1;
    const { docId, entry } = doc;
    const revision = docId === PATTERNS_DOC ? patternsRevision : doc.revision;
    if (
      known.get(docId) === revision &&
      !missingHash.has(docId) &&
      (docId !== PATTERNS_DOC || samePatterns)
    ) {
      stmts.push(
        env.DB.prepare("UPDATE book_documents SET position = ? WHERE doc_id = ?").bind(
          position,
          docId,
        ),
      );
      continue;
    }
    let kind: string;
    let title: string;
    let sections: { anchor: string; heading: string; body: string }[];
    if (docId === PATTERNS_DOC) {
      kind = PATTERNS_DOC;
      title = PATTERNS_TITLE;
      sections = [];
      for (const id of patterns) {
        const { heading, body } = parsePattern(await getText(`${base}/${patternPath(id)}`));
        if (!heading) throw new Error(`no title in ${id}`);
        sections.push({ anchor: id, heading, body });
      }
    } else {
      const info = docPath(docId)!;
      const parsed = parseManuscript(await getText(`${base}/${info.path}`));
      if (!parsed.title) throw new Error(`no title in ${docId}`);
      kind = info.kind;
      title = parsed.title;
      const seen = new Set<string>();
      sections = [];
      for (const { heading, body } of parsed.sections) {
        const anchor = entry?.anchors?.[heading];
        if (!anchor || seen.has(anchor)) continue;
        seen.add(anchor);
        sections.push({ anchor, heading, body });
      }
    }
    stmts.push(
      env.DB.prepare(
        `INSERT INTO book_documents (doc_id, kind, title, revision, position) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(doc_id) DO UPDATE SET kind = excluded.kind, title = excluded.title,
           revision = excluded.revision, position = excluded.position`,
      ).bind(docId, kind, title, revision, position),
      env.DB.prepare("DELETE FROM book_sections WHERE doc_id = ?").bind(docId),
    );
    for (const [sp, { anchor, heading, body }] of sections.entries()) {
      stmts.push(
        env.DB.prepare(
          "INSERT INTO book_sections (doc_id, anchor, heading, position, hash) VALUES (?, ?, ?, ?, ?)",
        ).bind(docId, anchor, heading, sp + 1, await sectionHash(body)),
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
  return ids.length;
}
