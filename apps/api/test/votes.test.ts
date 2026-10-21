import { describe, expect, it } from "vitest";
import { api, register } from "./helpers";

type Reply = { id: number; score: number; voted: boolean };

async function setup() {
  const a = await register("va");
  const b = await register("vb");
  const c = await register("vc");
  const t = await api("/topics", {
    method: "POST",
    token: a.token,
    body: { topic: { title: "t", body: "b" } },
  });
  const { topic } = (await t.json()) as { topic: { id: number } };
  const post = async (body: string) =>
    (
      (await (
        await api(`/topics/${topic.id}/replies`, {
          method: "POST",
          token: a.token,
          body: { reply: { body } },
        })
      ).json()) as { reply: Reply }
    ).reply;
  return { a, b, c, topicId: topic.id, early: await post("early"), late: await post("late") };
}

const vote = async (id: number, token: string, method = "POST") => {
  const res = await api(`/replies/${id}/vote`, { method, token });
  return { status: res.status, json: (await res.json()) as { reply: Reply } };
};

const list = async (topicId: number, sort: string, token?: string) =>
  (
    (await (await api(`/topics/${topicId}/replies?sort=${sort}`, { token })).json()) as {
      replies: Reply[];
    }
  ).replies;

describe("reply votes", () => {
  it("counts one vote per user, is idempotent and sorts by score", async () => {
    const { b, c, topicId, early, late } = await setup();
    expect((await vote(late.id, b.token)).json.reply).toMatchObject({ score: 1, voted: true });
    expect((await vote(late.id, b.token)).json.reply.score).toBe(1);
    expect((await vote(late.id, c.token)).json.reply.score).toBe(2);
    await vote(early.id, c.token);

    const top = await list(topicId, "top", b.token);
    expect(top.map((r) => [r.id, r.score, r.voted])).toEqual([
      [late.id, 2, true],
      [early.id, 1, false],
    ]);
    expect((await list(topicId, "top")).every((r) => !r.voted)).toBe(true);
    expect((await list(topicId, "old")).map((r) => r.id)).toEqual([early.id, late.id]);

    expect((await vote(late.id, b.token, "DELETE")).json.reply).toMatchObject({
      score: 1,
      voted: false,
    });
    expect((await vote(late.id, b.token, "DELETE")).json.reply.score).toBe(1);
    await vote(late.id, c.token, "DELETE");
    await vote(early.id, c.token, "DELETE");
    expect((await list(topicId, "top")).map((r) => r.id)).toEqual([early.id, late.id]);
  });

  it("rejects self votes, anonymous votes and unknown replies", async () => {
    const { a, b, early } = await setup();
    const self = await api(`/replies/${early.id}/vote`, { method: "POST", token: a.token });
    expect(self.status).toBe(422);
    expect(await self.json()).toEqual({ errors: { reply: ["is invalid"] } });
    expect((await api(`/replies/${early.id}/vote`, { method: "POST" })).status).toBe(401);
    const missing = await api("/replies/999999999/vote", { method: "POST", token: b.token });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ errors: { reply: ["not found"] } });
  });

  it("drops votes with the reply", async () => {
    const { a, b, topicId, late } = await setup();
    await vote(late.id, b.token);
    expect((await api(`/replies/${late.id}`, { method: "DELETE", token: a.token })).status).toBe(
      204,
    );
    expect((await list(topicId, "top")).map((r) => r.id)).not.toContain(late.id);
  });
});
