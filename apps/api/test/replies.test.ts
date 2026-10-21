import { describe, expect, it } from "vitest";
import { api, register } from "./helpers";

type Reply = { id: number; parentId: number | null; body: string; deleted: boolean };

describe("replies", () => {
  it("threads replies, keeps placeholders and updates topic activity", async () => {
    const a = await register("ra");
    const b = await register("rb");
    const t = await api("/topics", {
      method: "POST",
      token: a.token,
      body: { topic: { title: "t", body: "b" } },
    });
    const { topic } = (await t.json()) as { topic: { id: number } };
    const post = async (body: string, parentId?: number) => {
      const res = await api(`/topics/${topic.id}/replies`, {
        method: "POST",
        token: b.token,
        body: { reply: { body, parentId } },
      });
      expect(res.status).toBe(201);
      return ((await res.json()) as { reply: Reply & { createdAt: string } }).reply;
    };
    const root = await post("root");
    const child = await post("child", root.id);
    const last = await post("leaf");
    const got = (await (await api(`/topics/${topic.id}`)).json()) as {
      topic: { replyCount: number; lastActivityAt: string };
    };
    expect(got.topic.replyCount).toBe(3);
    expect(got.topic.lastActivityAt).toBe(last.createdAt);

    const bad = await api(`/topics/${topic.id}/replies`, {
      method: "POST",
      token: b.token,
      body: { reply: { body: "x", parentId: 999999 } },
    });
    expect(bad.status).toBe(422);
    expect((await api(`/replies/${root.id}`, { method: "DELETE", token: a.token })).status).toBe(
      403,
    );

    await api(`/replies/${root.id}`, { method: "DELETE", token: b.token });
    await api(`/replies/${last.id}`, { method: "DELETE", token: b.token });
    let list = (await (await api(`/topics/${topic.id}/replies`)).json()) as { replies: Reply[] };
    expect(list.replies.map((r) => [r.id, r.deleted, r.body])).toEqual([
      [root.id, true, ""],
      [child.id, false, "child"],
    ]);
    await api(`/replies/${child.id}`, { method: "DELETE", token: b.token });
    list = (await (await api(`/topics/${topic.id}/replies`)).json()) as { replies: Reply[] };
    expect(list.replies).toEqual([]);

    await api(`/topics/${topic.id}`, { method: "DELETE", token: a.token });
    expect((await api(`/topics/${topic.id}/replies`)).status).toBe(404);
  });
});
