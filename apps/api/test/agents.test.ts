import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { issueToken } from "../src/lib/token";
import { api, register } from "./helpers";

let seq = 0;
const name = () => `bot-${Date.now()}-${++seq}`;

async function agentFor(token: string) {
  const n = name();
  const res = await api("/agents", { method: "POST", token, body: { agent: { name: n } } });
  expect(res.status).toBe(201);
  const { agent } = (await res.json()) as { agent: { token: string; name: string } };
  return agent;
}

const topic = (token: string, title = "t") =>
  api("/topics", { method: "POST", token, body: { topic: { title, body: "b" } } });

describe("agents", () => {
  it("registers an agent, shows the token once and stores only its hash", async () => {
    const h = await register("ah");
    const a = await agentFor(h.token);
    expect(a.token).toMatch(/^sfa_[0-9a-f]{64}$/);
    const list = (await (await api("/agents", { token: h.token })).json()) as {
      agents: Record<string, unknown>[];
    };
    expect(list.agents).toEqual([
      expect.objectContaining({ name: a.name, owner: h.username, revoked: false }),
    ]);
    expect(list.agents[0]).not.toHaveProperty("token");
    const row = await env.DB.prepare(
      "SELECT t.token_hash FROM agent_tokens t JOIN users u ON u.id = t.user_id WHERE u.username = ?",
    )
      .bind(a.name)
      .first<{ token_hash: string }>();
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.token_hash).not.toContain(a.token.slice(4));
  });

  it("marks authors as human or agent with the owner", async () => {
    const h = await register("ak");
    const a = await agentFor(h.token);
    const mine = (await (await topic(h.token)).json()) as {
      topic: { id: number; author: unknown };
    };
    expect(mine.topic.author).toMatchObject({ username: h.username, kind: "human", owner: null });
    const r = await api(`/topics/${mine.topic.id}/replies`, {
      method: "POST",
      token: a.token,
      body: { reply: { body: "agent" } },
    });
    expect(r.status).toBe(201);
    expect(((await r.json()) as { reply: { author: unknown } }).reply.author).toMatchObject({
      username: a.name,
      kind: "agent",
      owner: h.username,
    });
  });

  it("keeps agents out of account, RealWorld, vote and agent registration routes", async () => {
    const h = await register("ag");
    const a = await agentFor(h.token);
    const forbidden = { errors: { agent: ["forbidden"] } };
    for (const [method, path, body] of [
      ["PUT", "/user", { user: { password: "password123" } }],
      ["POST", "/articles", { article: { title: "x", description: "d", body: "b" } }],
      ["POST", "/agents", { agent: { name: name() } }],
      ["POST", "/replies/1/vote", undefined],
    ] as const) {
      const res = await api(path, { method, token: a.token, body });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await res.json()).toEqual(forbidden);
    }
    const login = await api("/users/login", {
      method: "POST",
      body: { user: { email: `${a.name}@agents.invalid`, password: "" } },
    });
    expect(login.status).not.toBe(200);
  });

  it("does not let an owner vote on their agent's reply", async () => {
    const h = await register("ao");
    const other = await register("ap");
    const a = await agentFor(h.token);
    const t = (await (await topic(h.token)).json()) as { topic: { id: number } };
    const r = (await (
      await api(`/topics/${t.topic.id}/replies`, {
        method: "POST",
        token: a.token,
        body: { reply: { body: "x" } },
      })
    ).json()) as { reply: { id: number } };
    const own = await api(`/replies/${r.reply.id}/vote`, { method: "POST", token: h.token });
    expect(own.status).toBe(422);
    expect(await own.json()).toEqual({ errors: { reply: ["is invalid"] } });
    expect(
      (await api(`/replies/${r.reply.id}/vote`, { method: "POST", token: other.token })).status,
    ).toBe(200);
  });

  it("limits an agent to 20 successful writes in 10 minutes", async () => {
    const h = await register("aq");
    const a = await agentFor(h.token);
    for (let i = 0; i < 20; i += 1) expect((await topic(a.token, `t${i}`)).status).toBe(201);
    const over = await topic(a.token, "t21");
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ errors: { agent: ["too many requests"] } });
    expect((await topic(h.token)).status).toBe(201);
    // 10분이 지난 쓰기는 세지 않는다.
    await env.DB.prepare(
      "UPDATE agent_writes SET created_at = '2000-01-01T00:00:00.000Z' WHERE user_id = (SELECT id FROM users WHERE username = ?)",
    )
      .bind(a.name)
      .run();
    expect((await topic(a.token, "later")).status).toBe(201);
  });

  it("revokes a token, keeps the account and its posts, and checks ownership", async () => {
    const h = await register("ar");
    const other = await register("as");
    const a = await agentFor(h.token);
    const t = (await (await topic(a.token)).json()) as { topic: { id: number } };
    expect((await api(`/agents/${a.name}`, { method: "DELETE", token: other.token })).status).toBe(
      403,
    );
    expect((await api(`/agents/none-${a.name}`, { method: "DELETE", token: h.token })).status).toBe(
      404,
    );
    expect((await api(`/agents/${a.name}`, { method: "DELETE", token: h.token })).status).toBe(204);
    const after = await topic(a.token);
    expect(after.status).toBe(401);
    expect(await after.json()).toEqual({ errors: { token: ["is invalid"] } });
    expect((await api(`/topics/${t.topic.id}`)).status).toBe(200);
  });

  it("validates names and keeps agent and human usernames unique", async () => {
    const h = await register("at");
    const bad = async (n: string, field: string, msg: string, status = 422) => {
      const res = await api("/agents", {
        method: "POST",
        token: h.token,
        body: { agent: { name: n } },
      });
      expect(res.status, n).toBe(status);
      expect(await res.json()).toEqual({ errors: { [field]: [msg] } });
    };
    await bad("", "name", "can't be blank");
    await bad("Has Space", "name", "is invalid");
    await bad("ab", "name", "is invalid");
    await bad("-lead", "name", "is invalid");
    await bad(
      h.username.toLowerCase().replace(/[^a-z0-9-]/g, ""),
      "name",
      "has already been taken",
      409,
    );
  });

  it("never hands an agent a login token and rejects JWTs of agent accounts", async () => {
    const h = await register("au");
    const a = await agentFor(h.token);
    const me = await api("/user", { token: a.token });
    expect(me.status).toBe(403);
    expect(await me.json()).toEqual({ errors: { agent: ["forbidden"] } });
    const id = await env.DB.prepare("SELECT id FROM users WHERE username = ?")
      .bind(a.name)
      .first<{ id: number }>();
    const jwt = await issueToken(id!.id, env.JWT_SECRET);
    for (const [method, path] of [
      ["GET", "/user"],
      ["POST", "/topics"],
      ["POST", "/agents"],
    ] as const) {
      const res = await api(path, { method, token: jwt, body: method === "GET" ? undefined : {} });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it("still counts writes that were deleted afterwards", async () => {
    const h = await register("av");
    const a = await agentFor(h.token);
    for (let i = 0; i < 20; i += 1) {
      const t = (await (await topic(a.token, `d${i}`)).json()) as { topic: { id: number } };
      expect(
        (await api(`/topics/${t.topic.id}`, { method: "DELETE", token: a.token })).status,
      ).toBe(204);
    }
    expect((await topic(a.token, "over")).status).toBe(429);
  });

  it("keeps the agent email domain out of human sign-ups", async () => {
    const res = await api("/users", {
      method: "POST",
      body: {
        user: {
          username: `hx${Date.now()}`,
          email: `squat${Date.now()}@agents.invalid`,
          password: "password123",
        },
      },
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ errors: { email: ["is invalid"] } });
  });
});
