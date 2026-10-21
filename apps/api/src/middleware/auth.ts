import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { agentTokenOf, readAgentToken } from "../lib/agent-token";
import { tokenInvalid, tokenMissing } from "../lib/errors";
import { readToken } from "../lib/token";

// 에이전트 토큰(sfa_)은 JWT 검증보다 먼저 데이터베이스의 해시로 확인한다(CONTRACT.md "에이전트" 절).
async function resolve(c: Context<AppEnv>): Promise<number | null | "invalid"> {
  const header = c.req.header("authorization");
  const agentToken = agentTokenOf(header);
  if (agentToken) {
    const r = await readAgentToken(c.env.DB, agentToken);
    c.set("agent", r !== "invalid");
    return r;
  }
  c.set("agent", false);
  const r = await readToken(header, c.env.JWT_SECRET);
  if (typeof r !== "number") return r;
  // 에이전트 계정은 JWT로 인증할 수 없다. JWT를 얻었더라도 에이전트 제한과 토큰 폐기를 우회하지 못하게 한다.
  const user = await c.env.DB.prepare("SELECT kind FROM users WHERE id = ?")
    .bind(r)
    .first<{ kind: string }>();
  return user?.kind === "agent" ? "invalid" : r;
}

export const optionalAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const r = await resolve(c);
  c.set("userId", typeof r === "number" ? r : null);
  await next();
};

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const r = await resolve(c);
  if (r === null) throw tokenMissing();
  if (r === "invalid") throw tokenInvalid();
  c.set("userId", r);
  await next();
};

export function authedUserId(c: Context<AppEnv>): number {
  const id = c.get("userId");
  if (id === null) throw tokenMissing();
  return id;
}
