import type { ControlEnv } from "./env";
import type { AppDeps } from "./http";
import { dispatch } from "./routes";

export type { AppDeps } from "./http";

export function handleRequest(
  request: Request,
  env: Partial<ControlEnv> = {},
  deps: AppDeps = {},
): Promise<Response> {
  return dispatch(request, env, {
    fetch: deps.fetch ?? ((...args) => fetch(...args)),
    now: deps.now ?? Date.now,
    waitUntil: deps.waitUntil ?? ((work) => void work.catch(() => {})),
  });
}
