import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, register } from "./helpers";
// 마이그레이션 파일의 이전 구문(INSERT)만 다시 실행한다. 테스트 DB에는 마이그레이션 적용 시점에 글이 없기 때문이다.
const inserts = (env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0010_"))?.queries ?? []).filter(
  (q) => /^\s*INSERT/i.test(q.replace(/^\s*--.*$/gm, "")),
);

async function runInserts() {
  for (const sql of inserts) await env.DB.prepare(sql).run();
}

type Topic = {
  id: number;
  title: string;
  body: string;
  kind: string;
  book: unknown;
  replyCount: number;
  author: { username: string };
  lastActivityAt: string;
};
type Reply = { body: string; parentId: number | null; author: { username: string } };

describe("0010 legacy articles → topics", () => {
  it("has the two INSERT statements", () => {
    expect(inserts).toHaveLength(2);
  });

  it("moves articles to general topics and comments to top-level replies, once", async () => {
    const a = await register("lm");
    const b = await register("ln");
    // RealWorld 경로는 제거되었으므로 원본 행을 직접 넣는다.
    const uid = async (username: string) =>
      (await env.DB.prepare("SELECT id FROM users WHERE username = ?")
        .bind(username)
        .first<{ id: number }>())!.id;
    const slug = `old-${Date.now()}`;
    const art = await env.DB.prepare(
      "INSERT INTO articles (slug, title, description, body, author_id, created_at, updated_at) VALUES (?, '옛 글', '요약', '**본문**', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    )
      .bind(slug, await uid(a.username))
      .run();
    const articleId = art.meta.last_row_id;
    for (const [who, body, at] of [
      [b.username, "첫 댓글", "2026-01-02T00:00:00.000Z"],
      [a.username, "둘째 댓글", "2026-01-03T00:00:00.000Z"],
    ] as const)
      await env.DB.prepare(
        "INSERT INTO comments (body, article_id, author_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
        .bind(body, articleId, await uid(who), at, at)
        .run();

    await runInserts();
    await runInserts();

    const list = (await (await api(`/topics?author=${a.username}`)).json()) as {
      topics: Topic[];
      topicsCount: number;
    };
    expect(list.topicsCount).toBe(1);
    const t = list.topics[0]!;
    expect(t).toMatchObject({ title: "옛 글", kind: "general", book: null, replyCount: 2 });
    expect(t.body).toBe("요약\n\n**본문**");
    const { replies } = (await (await api(`/topics/${t.id}/replies`)).json()) as {
      replies: Reply[];
    };
    expect(replies.map((r) => [r.body, r.parentId, r.author.username])).toEqual([
      ["첫 댓글", null, b.username],
      ["둘째 댓글", null, a.username],
    ]);
    const lastComment = await env.DB.prepare(
      "SELECT MAX(c.created_at) AS at FROM comments c JOIN articles x ON x.id = c.article_id WHERE x.slug = ?",
    )
      .bind(slug)
      .first<{ at: string }>();
    expect(t.lastActivityAt).toBe(lastComment!.at);
  });
});
