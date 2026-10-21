import { Hono } from "hono";
import type { AppEnv } from "../env";
import { hashAgentToken, newAgentToken } from "../lib/agent-token";
import { readWrapped, requireString } from "../lib/body";
import { forbidden, invalid, notFound, taken } from "../lib/errors";
import { authedUserId, requireAuth } from "../middleware/auth";

export const agentsRouter = new Hono<AppEnv>();

const NAME = /^[a-z0-9][a-z0-9-]{2,29}$/;

type AgentRow = {
  username: string;
  owner: string;
  created_at: string;
  revoked_at: string | null;
};

const serialize = (r: AgentRow) => ({
  name: r.username,
  owner: r.owner,
  createdAt: r.created_at,
  revoked: r.revoked_at !== null,
});

const SELECT = `SELECT u.username, o.username AS owner, t.created_at, t.revoked_at
  FROM users u JOIN users o ON o.id = u.owner_id JOIN agent_tokens t ON t.user_id = u.id`;

agentsRouter.post("/agents", requireAuth, async (c) => {
  const ownerId = authedUserId(c);
  const input = await readWrapped<{ name: unknown }>(c, "agent");
  const name = requireString(input.name, "name");
  if (!NAME.test(name)) throw invalid("name");
  const db = c.env.DB;
  const exists = await db
    .prepare("SELECT 1 AS ok FROM users WHERE username = ?")
    .bind(name)
    .first();
  if (exists) throw taken("name");
  const token = newAgentToken();
  const now = new Date().toISOString();
  // 계정과 토큰을 한 batch(트랜잭션)로 만든다. 하나라도 실패하면 둘 다 남지 않는다.
  // 에이전트는 비밀번호가 없다. "!"는 어떤 비밀번호와도 맞지 않는 형식이라 로그인할 수 없다.
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO users (email, username, password_hash, kind, owner_id, created_at, updated_at)
           VALUES (?, ?, '!', 'agent', ?, ?, ?)`,
        )
        .bind(`${name}@agents.invalid`, name, ownerId, now, now),
      db
        .prepare(
          "INSERT INTO agent_tokens (user_id, token_hash, created_at) SELECT id, ?, ? FROM users WHERE username = ?",
        )
        .bind(await hashAgentToken(token), now, name),
    ]);
  } catch (e) {
    // 같은 이름을 동시에 등록하면 사전 확인을 지나 유일 제약에서 막힌다.
    if (/UNIQUE constraint failed: users\.(username|email)/.test(String(e))) throw taken("name");
    throw e;
  }
  const row = await db.prepare(`${SELECT} WHERE u.username = ?`).bind(name).first<AgentRow>();
  return c.json({ agent: { ...serialize(row!), token } }, 201);
});

agentsRouter.get("/agents", requireAuth, async (c) => {
  const { results } = await c.env.DB.prepare(`${SELECT} WHERE u.owner_id = ? ORDER BY u.id ASC`)
    .bind(authedUserId(c))
    .all<AgentRow>();
  return c.json({ agents: results.map(serialize) });
});

agentsRouter.delete("/agents/:name", requireAuth, async (c) => {
  const userId = authedUserId(c);
  const row = await c.env.DB.prepare(
    "SELECT id, owner_id FROM users WHERE username = ? AND kind = 'agent'",
  )
    .bind(c.req.param("name"))
    .first<{ id: number; owner_id: number }>();
  if (!row) throw notFound("agent");
  if (row.owner_id !== userId) throw forbidden("agent");
  await c.env.DB.prepare(
    "UPDATE agent_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
  )
    .bind(new Date().toISOString(), row.id)
    .run();
  return c.body(null, 204);
});
