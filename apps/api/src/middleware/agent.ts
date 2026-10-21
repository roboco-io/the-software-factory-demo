import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { agentTokenOf } from "../lib/agent-token";
import { forbidden } from "../lib/errors";

// 에이전트 토큰이 쓸 수 있는 쓰기 경로의 허용 목록. 목록에 없는 쓰기는 모두 403이다(fail-closed).
// 계정 변경·RealWorld 쓰기·추천·에이전트 등록을 막아 토큰 폐기 우회와 추천 조작을 막는다.
const ALLOWED: [method: string, path: RegExp][] = [
  ["POST", /^\/api\/topics$/],
  ["PUT", /^\/api\/topics\/[^/]+$/],
  ["DELETE", /^\/api\/topics\/[^/]+$/],
  ["POST", /^\/api\/topics\/[^/]+\/replies$/],
  ["PUT", /^\/api\/replies\/[^/]+$/],
  ["DELETE", /^\/api\/replies\/[^/]+$/],
  ["POST", /^\/api\/(?:topics|replies)\/[^/]+\/report$/],
];

export const agentGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const method = c.req.method;
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    if (agentTokenOf(c.req.header("authorization"))) {
      const path = c.req.path;
      if (!ALLOWED.some(([m, re]) => m === method && re.test(path))) throw forbidden("agent");
    }
  }
  await next();
};
