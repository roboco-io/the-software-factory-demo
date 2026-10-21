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
    const art = await api("/articles", {
      method: "POST",
      token: a.token,
      body: { article: { title: "옛 글", description: "요약", body: "**본문**" } },
    });
    const { article } = (await art.json()) as { article: { slug: string } };
    for (const [t, body] of [
      [b.token, "첫 댓글"],
      [a.token, "둘째 댓글"],
    ] as const)
      await api(`/articles/${article.slug}/comments`, {
        method: "POST",
        token: t,
        body: { comment: { body } },
      });

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
      .bind(article.slug)
      .first<{ at: string }>();
    expect(t.lastActivityAt).toBe(lastComment!.at);
  });
});
