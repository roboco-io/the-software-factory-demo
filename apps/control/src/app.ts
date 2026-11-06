import { parseList } from "./config";
import { D1RunRepo } from "./d1-repo";
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

export async function handleRequest(
  request: Request,
  env: Partial<ControlEnv> = {},
): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/api/github/webhook")
    return handleWebhook(request, webhookDeps(env));
  if (pathname !== "/api/health") return json({ error: "not_found" }, 404);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "method_not_allowed" }, 405, { allow: "GET, HEAD" });
  }
  return json({ status: "ok" });
}
