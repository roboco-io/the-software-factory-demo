import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, register } from "./helpers";

async function setup() {
  const a = await register("pa");
  const b = await register("pb");
  const t = await api("/topics", {
    method: "POST",
    token: a.token,
    body: { topic: { title: "t", body: "b" } },
  });
  const { topic } = (await t.json()) as { topic: { id: number } };
  const r = await api(`/topics/${topic.id}/replies`, {
    method: "POST",
    token: a.token,
    body: { reply: { body: "r" } },
  });
  const { reply } = (await r.json()) as { reply: { id: number } };
  return { a, b, topicId: topic.id, replyId: reply.id };
}

const report = (path: string, token: string | undefined, reason: unknown) =>
  api(path, { method: "POST", token, body: { report: { reason } } });

describe("reports", () => {
  it("records one report per user and target", async () => {
    const { b, topicId, replyId } = await setup();
    const first = await report(`/topics/${topicId}/report`, b.token, "광고");
    expect(first.status).toBe(201);
    const { report: rp } = (await first.json()) as {
      report: { id: number; targetType: string; targetId: number; reason: string };
    };
    expect(rp).toMatchObject({ targetType: "topic", targetId: topicId, reason: "광고" });
    const again = await report(`/topics/${topicId}/report`, b.token, "다시");
    expect(again.status).toBe(200);
    expect(
      ((await again.json()) as { report: { id: number; reason: string } }).report,
    ).toMatchObject({ id: rp.id, reason: "광고" });
    const onReply = await report(`/replies/${replyId}/report`, b.token, "욕설");
    expect(onReply.status).toBe(201);
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM reports WHERE reporter_id = (SELECT id FROM users WHERE username = ?)",
    )
      .bind(b.username)
      .first<{ n: number }>();
    expect(rows?.n).toBe(2);
  });

  it("validates the reason, auth and target", async () => {
    const { a, b, topicId, replyId } = await setup();
    const blank = await report(`/replies/${replyId}/report`, a.token, "");
    expect(blank.status).toBe(422);
    expect(await blank.json()).toEqual({ errors: { reason: ["can't be blank"] } });
    const long = await report(`/replies/${replyId}/report`, a.token, "가".repeat(501));
    expect(await long.json()).toEqual({
      errors: { reason: ["is too long (maximum is 500 characters)"] },
    });
    expect((await report(`/topics/${topicId}/report`, undefined, "x")).status).toBe(401);
    const noTopic = await report("/topics/999999999/report", b.token, "x");
    expect(noTopic.status).toBe(404);
    expect(await noTopic.json()).toEqual({ errors: { topic: ["not found"] } });
    const noReply = await report("/replies/999999999/report", b.token, "x");
    expect(await noReply.json()).toEqual({ errors: { reply: ["not found"] } });
  });
});
