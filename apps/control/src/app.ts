import { parseList } from "./config";
import { handleConsoleRead } from "./console-api";
import { D1RunRepo, type D1Like } from "./d1-repo";
import type { ControlEnv } from "./env";
import { handleWebhook, type WebhookDeps } from "./webhook";

const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });

function webhookDeps(env: Partial<ControlEnv>): WebhookDeps {
  const repo = env.DB === undefined ? undefined : new D1RunRepo(env.DB);
  return {
    secret: env.GITHUB_WEBHOOK_SECRET,
    runsEnabled: env.RUNS_ENABLED === "true",
    operatorIds: parseList(env.OPERATOR_IDS),
    projects: parseList(env.PROJECTS),
    deliveries: {
      claim: async (id) => (repo ? repo.claimDelivery(id, Date.now()) : false),
      release: async (id) => void (await repo?.releaseDelivery(id)),
    },
    starter: {
      async start(input) {
        if (
          env.ISSUE_RUN === undefined ||
          !env.ANTHROPIC_API_KEY ||
          !env.GITHUB_APP_ID ||
          !env.GITHUB_APP_PRIVATE_KEY
        ) {
          throw new Error("not configured");
        }
        return env.ISSUE_RUN.getByName(
          `${input.repo}#${input.issueNumber}`,
        ).start(input);
      },
    },
  };
}

const EMPTY_DB: D1Like = {
  prepare() {
    const stmt = {
      bind: () => stmt,
      all: async () => ({ results: [] }),
      first: async () => null,
      run: async () => ({ meta: { changes: 0 } }),
    };
    return stmt;
  },
  batch: async () => [],
} as never;

export async function handleRequest(
  request: Request,
  env: Partial<ControlEnv> = {},
  options: { now?: () => number } = {},
): Promise<Response> {
  const { pathname } = new URL(request.url);
  // Login arrives with the next change. Until then every visitor is anonymous.
  if (pathname === "/api/session")
    return json({ role: "anonymous", login: null, loginEnabled: false });
  const read = await handleConsoleRead(request, {
    db: env.DB ?? EMPTY_DB,
    publicRepos: parseList(env.PUBLIC_REPOS),
    now: options.now ?? Date.now,
  });
  if (read) return read;
  if (pathname === "/api/github/webhook")
    return handleWebhook(request, webhookDeps(env));
  if (pathname !== "/api/health") return json({ error: "not_found" }, 404);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "method_not_allowed" }, 405, { allow: "GET, HEAD" });
  }
  return json({ status: "ok" });
}
