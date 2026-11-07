import { handleAuth, type AuthDeps } from "./auth-api";
import { parseList } from "./config";
import { handleConsoleRead } from "./console-api";
import { D1RunRepo, type D1Like } from "./d1-repo";
import type { ControlEnv } from "./env";
import { createUserGitHub, type UserGitHub } from "./github-user";
import { handleReviewRequest, type ReviewDeps } from "./review-api";
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

/** A database with no rows, used when the DB binding is missing. */
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

const notConfigured = async (): Promise<never> => {
  throw new Error("login not configured");
};
const DISABLED_GITHUB: UserGitHub = {
  exchangeCode: notConfigured,
  getUser: notConfigured,
  getPullHead: notConfigured,
  postReview: notConfigured,
};

export interface AppOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

function consoleDeps(
  request: Request,
  env: Partial<ControlEnv>,
  options: AppOptions,
): { review: ReviewDeps; auth: AuthDeps } {
  const clientId = env.GITHUB_OAUTH_CLIENT_ID || undefined;
  const clientSecret = env.GITHUB_OAUTH_CLIENT_SECRET || undefined;
  const loginReady = clientId !== undefined && clientSecret !== undefined;
  const github = loginReady
    ? createUserGitHub({ clientId, clientSecret, fetch: options.fetch })
    : DISABLED_GITHUB;
  const review: ReviewDeps = {
    db: env.DB ?? EMPTY_DB,
    publicRepos: parseList(env.PUBLIC_REPOS),
    operatorIds: parseList(env.OPERATOR_IDS),
    sessionSecret: env.SESSION_SECRET || undefined,
    clientId: loginReady ? clientId : undefined,
    github,
    now: options.now ?? Date.now,
    origin: new URL(request.url).origin,
  };
  return {
    review,
    auth: {
      sessionSecret: review.sessionSecret,
      clientId: review.clientId,
      operatorIds: review.operatorIds,
      github,
      review,
      now: review.now,
      origin: review.origin,
    },
  };
}

export async function handleRequest(
  request: Request,
  env: Partial<ControlEnv> = {},
  options: AppOptions = {},
): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith("/api/") && pathname !== "/api/health") {
    if (pathname !== "/api/github/webhook") {
      const { review, auth } = consoleDeps(request, env, options);
      const res =
        (await handleConsoleRead(request, {
          db: review.db,
          publicRepos: review.publicRepos,
          now: review.now,
        })) ??
        (await handleAuth(request, auth)) ??
        (await handleReviewRequest(request, review));
      if (res) return res;
    }
  }
  if (pathname === "/api/github/webhook")
    return handleWebhook(request, webhookDeps(env));
  if (pathname !== "/api/health") return json({ error: "not_found" }, 404);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "method_not_allowed" }, 405, { allow: "GET, HEAD" });
  }
  return json({ status: "ok" });
}
