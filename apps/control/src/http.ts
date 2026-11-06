import type { ControlEnv } from "./env";
import type { Role } from "./roles";
import type { Session } from "./session";

/** Test seams. In production both are the Worker's own. */
export interface AppDeps {
  fetch?: typeof fetch;
  /** Milliseconds since the epoch. */
  now?: () => number;
}

export interface RouteContext {
  request: Request;
  url: URL;
  /** Path parameters, already validated against their rule. */
  params: Readonly<Record<string, string>>;
  env: Partial<ControlEnv>;
  fetch: typeof fetch;
  now(): number;
  role: Role;
  session: Session | null;
}

export type Handler = (ctx: RouteContext) => Promise<Response> | Response;

export const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
} as const;

export const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...SECURITY_HEADERS,
      ...headers,
    },
  });
