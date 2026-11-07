import { signSession, SESSION_COOKIE } from "../session";
import type { ControlEnv } from "../env";
import { createTestD1, readMigrations } from "./d1";

export const ORIGIN = "https://factory.test";
export const CLIENT_ID = "Iv1.testclientid";
/** Sentinel values: tests search logs and responses for them. */
export const CLIENT_SECRET = "oauth-client-secret-SENTINEL-0123456789";
export const SESSION_SECRET =
  "session-secret-SENTINEL-0123456789-abcdefghijklmnop";
export const OPERATOR_ID = "3435720";
export const OBSERVER_ID = "555";

export interface StopCall {
  name: string;
  runId: string;
}

/** An in-memory D1 with the real migrations, a fake IssueRun namespace and a configured control env. */
export function makeWorld(over: Partial<ControlEnv> = {}) {
  const t = createTestD1(readMigrations());
  const stopCalls: StopCall[] = [];
  const state = { stopResult: "stop_requested" as string };
  const env: Partial<ControlEnv> = {
    DB: t.d1 as never,
    ISSUE_RUN: {
      getByName: (name: string) => ({
        stop: async (runId: string) => {
          stopCalls.push({ name, runId });
          return state.stopResult;
        },
      }),
    } as never,
    OPERATOR_IDS: OPERATOR_ID,
    PROJECTS: "acme/demo,acme/other",
    GITHUB_OAUTH_CLIENT_ID: CLIENT_ID,
    GITHUB_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
    SESSION_SECRET,
    ...over,
  };
  const snapshot = () =>
    JSON.stringify([
      t.query("SELECT * FROM runs ORDER BY id"),
      t.query("SELECT * FROM events ORDER BY id"),
    ]);
  return { ...t, env, stopCalls, state, snapshot };
}
export type World = ReturnType<typeof makeWorld>;

export function seedRuns(w: World) {
  w.exec(`
    INSERT INTO runs (id, repo, issue_number, state, reason_code, pr_number, created_at, updated_at) VALUES ('aaaaaaaaaaa1', 'acme/demo', 7, 'awaiting_approval', NULL, 40, 1000, 5000);
    INSERT INTO runs (id, repo, issue_number, state, reason_code, pr_number, created_at, updated_at) VALUES ('aaaaaaaaaaa2', 'acme/demo', 8, 'merged', NULL, 41, 2000, 6000);
    INSERT INTO runs (id, repo, issue_number, state, reason_code, pr_number, created_at, updated_at) VALUES ('aaaaaaaaaaa3', 'acme/demo', 9, 'failed', 'agent_failed', NULL, 3000, 7000);
    INSERT INTO runs (id, repo, issue_number, state, reason_code, pr_number, created_at, updated_at) VALUES ('aaaaaaaaaaa4', 'acme/other', 1, 'needs_human', 'merged_outside_factory', 5, 4000, 8000);
    INSERT INTO runs (id, repo, issue_number, state, reason_code, pr_number, created_at, updated_at) VALUES ('aaaaaaaaaaa5', 'gone/repo', 1, 'implementing', NULL, NULL, 4500, 8500);
    INSERT INTO events (run_id, ts, kind, from_state, to_state, reason_code) VALUES
      ('aaaaaaaaaaa1', 1000, 'created', NULL, 'queued', NULL),
      ('aaaaaaaaaaa1', 1100, 'transition', 'queued', 'cloning', NULL),
      ('aaaaaaaaaaa1', 1200, 'cleanup', NULL, NULL, NULL),
      ('aaaaaaaaaaa5', 4500, 'created', NULL, 'queued', NULL);
  `);
}

export async function cookieFor(
  id: string,
  login: string,
  opts: {
    secret?: string;
    expIn?: number;
    extra?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + (opts.expIn ?? 3600);
  const value = await signSession(opts.secret ?? SESSION_SECRET, {
    id,
    login,
    exp,
    ...(opts.extra ?? {}),
  } as never);
  return `${SESSION_COOKIE}=${value}`;
}
export const operatorCookie = () => cookieFor(OPERATOR_ID, "boss");
export const observerCookie = () => cookieFor(OBSERVER_ID, "visitor");

export function req(
  path: string,
  o: {
    method?: string;
    cookie?: string;
    origin?: string | null;
    headers?: Record<string, string>;
  } = {},
): Request {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.cookie !== undefined) headers.cookie = o.cookie;
  const method = o.method ?? "GET";
  const origin = o.origin === undefined ? ORIGIN : o.origin;
  if (method !== "GET" && method !== "HEAD" && origin !== null)
    headers.origin = origin;
  return new Request(`${ORIGIN}${path}`, { method, headers });
}
