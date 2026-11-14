import { handleCallback, handleLogin, handleLogout } from "./auth";
import { billingPeriod, loadBudgetConfig, spendByProvider } from "./budget";
import { MODEL_PATTERN, parseList } from "./config";
import { D1BudgetRepo } from "./d1-budget";
import { D1RunRepo } from "./d1-repo";
import { D1TriageRepo } from "./d1-triage";
import type { ControlEnv } from "./env";
import {
  D1SwitchRepo,
  handleFactory,
  handleFactorySwitch,
} from "./factory-switch";
import { createTriageGitHub } from "./github-triage";
import { json, type Handler, type RouteContext } from "./http";
import { providerOf } from "./pricing";
import { createTriageClassifier } from "./triage-model";
import { runTriage } from "./triage-service";
import {
  handleMe,
  handleBudget,
  handleBudgetLimits,
  handleProjects,
  handleRun,
  handleRuns,
  handleStop,
} from "./portal-api";
import { handleReviewStart } from "./review";
import { hasRole, roleOf, type Role } from "./roles";
import { SESSION_COOKIE, readCookie, verifySession } from "./session";
import { handleWebhook, type GuestDeps, type WebhookDeps } from "./webhook";

export type Method = "GET" | "POST";

/**
 * Why a non-GET route may be open to a caller below operator. Every other non-GET route
 * requires an operator; a test fails when this list grows without a matching entry there.
 *  - own-session: the route changes only the caller's own cookie.
 *  - signed-webhook: the caller proves itself with GitHub's HMAC signature, not a session.
 */
export type Exemption = "own-session" | "signed-webhook";

export interface Route {
  /** `:name` segments are path parameters, validated by PARAM_RULES. */
  path: string;
  methods: readonly Method[];
  /** The least role the dispatcher lets in. */
  minRole: Role;
  exemption?: Exemption;
  /** A GET route whose handler has effects must not answer HEAD. */
  noHead?: boolean;
  handler: Handler;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PARAM_RULES: Readonly<Record<string, RegExp>> = {
  owner: OWNER,
  repo: NAME,
  id: RUN_ID,
};

type Starter = WebhookDeps["starter"];

/**
 * Guest triage (stage 7). Undefined, so guest issues are ignored, unless GUEST_PROJECTS
 * names a repository and the model, the database and both keys are there. Opening a
 * repository to guests is therefore one reviewed change of GUEST_PROJECTS.
 */
function guestDeps(ctx: RouteContext, starter: Starter): GuestDeps | undefined {
  const { env } = ctx;
  const projects = parseList(env.GUEST_PROJECTS);
  const model = env.TRIAGE_MODEL?.trim() ?? "";
  const db = env.DB;
  const apiKey = env.ANTHROPIC_API_KEY;
  const appId = env.GITHUB_APP_ID;
  const privateKeyPem = env.GITHUB_APP_PRIVATE_KEY;
  if (
    projects.length === 0 ||
    !MODEL_PATTERN.test(model) ||
    db === undefined ||
    !apiKey ||
    !appId ||
    !privateKeyPem
  )
    return undefined;
  const triage = new D1TriageRepo(db);
  const budget = new D1BudgetRepo(db);
  return {
    projects,
    triage: (issue) =>
      runTriage(issue, {
        now: ctx.now,
        model,
        portalOrigin: ctx.url.origin,
        triage,
        github: createTriageGitHub({ appId, privateKeyPem, fetch: ctx.fetch }),
        classifier: createTriageClassifier({ apiKey, model, fetch: ctx.fetch }),
        modelBudgetOk: async () => {
          const provider = providerOf(model);
          if (provider === null) return false;
          const period = billingPeriod(ctx.now());
          const [rows, config] = await Promise.all([
            budget.periodUsage(period.start, period.end),
            loadBudgetConfig(env, budget),
          ]);
          const spent = spendByProvider(rows)[provider];
          return spent !== null && spent < config.monthlyUsd[provider];
        },
        starter,
      }),
    adminClosed: (repo, issueNumber) =>
      triage.markAdminRejected(repo, issueNumber),
    defer: (work) => ctx.waitUntil(work),
  };
}

function webhookDeps(ctx: RouteContext): WebhookDeps {
  const { env } = ctx;
  const repo = env.DB === undefined ? undefined : new D1RunRepo(env.DB);
  const starter: Starter = {
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
  };
  const guest = guestDeps(ctx, starter);
  return {
    secret: env.GITHUB_WEBHOOK_SECRET,
    runsEnabled: env.RUNS_ENABLED === "true",
    paused: async () =>
      env.DB === undefined ? false : new D1SwitchRepo(env.DB).paused(),
    operatorIds: parseList(env.OPERATOR_IDS),
    projects: parseList(env.PROJECTS),
    deliveries: {
      claim: async (id) => (repo ? repo.claimDelivery(id, Date.now()) : false),
      release: async (id) => void (await repo?.releaseDelivery(id)),
    },
    starter,
    ...(guest === undefined ? {} : { guest }),
  };
}

/** The one table of API routes. The dispatcher enforces methods, role and origin from it. */
export const ROUTES: readonly Route[] = [
  {
    path: "/api/health",
    methods: ["GET"],
    minRole: "anonymous",
    handler: () => json({ status: "ok" }),
  },
  {
    path: "/api/github/webhook",
    methods: ["POST"],
    minRole: "anonymous",
    exemption: "signed-webhook",
    handler: (ctx) => handleWebhook(ctx.request, webhookDeps(ctx)),
  },
  {
    path: "/api/auth/login",
    methods: ["GET"],
    minRole: "anonymous",
    handler: handleLogin,
  },
  {
    path: "/api/auth/callback",
    methods: ["GET"],
    minRole: "anonymous",
    // The callback spends a one-time code. HEAD would spend it for a request that shows nothing.
    noHead: true,
    handler: handleCallback,
  },
  {
    path: "/api/auth/logout",
    methods: ["POST"],
    minRole: "anonymous",
    exemption: "own-session",
    handler: () => handleLogout(),
  },
  {
    path: "/api/me",
    methods: ["GET"],
    minRole: "anonymous",
    handler: handleMe,
  },
  {
    path: "/api/projects",
    methods: ["GET"],
    minRole: "anonymous",
    handler: handleProjects,
  },
  {
    path: "/api/budget",
    methods: ["GET"],
    minRole: "anonymous",
    handler: handleBudget,
  },
  {
    path: "/api/budget/limits",
    methods: ["POST"],
    minRole: "operator",
    handler: handleBudgetLimits,
  },
  {
    path: "/api/factory",
    methods: ["GET"],
    minRole: "anonymous",
    handler: handleFactory,
  },
  {
    path: "/api/factory/switch",
    methods: ["POST"],
    minRole: "operator",
    handler: handleFactorySwitch,
  },
  {
    path: "/api/projects/:owner/:repo/runs",
    methods: ["GET"],
    minRole: "anonymous",
    handler: handleRuns,
  },
  {
    path: "/api/runs/:id",
    methods: ["GET"],
    minRole: "anonymous",
    handler: handleRun,
  },
  {
    path: "/api/runs/:id/stop",
    methods: ["POST"],
    minRole: "operator",
    handler: handleStop,
  },
  {
    path: "/api/runs/:id/review",
    methods: ["POST"],
    minRole: "operator",
    handler: handleReviewStart,
  },
];

/** The path parameters if `pathname` fits the route and every parameter passes its rule. */
function match(route: Route, pathname: string): Record<string, string> | null {
  const want = route.path.split("/");
  const got = pathname.split("/");
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (const [i, part] of want.entries()) {
    const actual = got[i]!;
    if (part.startsWith(":")) {
      const name = part.slice(1);
      const rule = PARAM_RULES[name];
      if (rule === undefined) throw new Error(`no rule for :${name}`);
      // The raw segment is checked: an encoded slash or dot never matches.
      if (!rule.test(actual)) return null;
      params[name] = actual;
    } else if (part !== actual) return null;
  }
  return params;
}

const isRead = (method: string) => method === "GET" || method === "HEAD";

export async function dispatch(
  request: Request,
  env: Partial<ControlEnv>,
  deps: {
    fetch: typeof fetch;
    now: () => number;
    waitUntil: (work: Promise<unknown>) => void;
  },
): Promise<Response> {
  const url = new URL(request.url);
  let route: Route | undefined;
  let params: Record<string, string> = {};
  for (const candidate of ROUTES) {
    const found = match(candidate, url.pathname);
    if (found !== null) {
      route = candidate;
      params = found;
      break;
    }
  }
  if (route === undefined) return json({ error: "not_found" }, 404);

  const method = request.method;
  const allowed =
    route.methods.includes("GET") && route.noHead !== true
      ? [...route.methods, "HEAD"]
      : [...route.methods];
  if (!allowed.includes(method))
    return json({ error: "method_not_allowed" }, 405, {
      allow: allowed.join(", "),
    });

  const now = Math.floor(deps.now() / 1000);
  const session = await verifySession(
    env.SESSION_SECRET,
    readCookie(request.headers.get("cookie"), SESSION_COOKIE),
    now,
  );
  const role = roleOf(session, parseList(env.OPERATOR_IDS));

  if (!hasRole(role, route.minRole))
    return role === "anonymous"
      ? json({ error: "unauthenticated" }, 401)
      : json({ error: "forbidden" }, 403);

  // Besides SameSite=Lax: a change made with a cookie must come from this site's own pages.
  if (!isRead(method) && route.exemption !== "signed-webhook") {
    if (request.headers.get("origin") !== url.origin)
      return json({ error: "bad_origin" }, 403);
  }

  const response = await route.handler({
    request,
    url,
    params,
    env,
    fetch: deps.fetch,
    now: deps.now,
    waitUntil: deps.waitUntil,
    role,
    session,
  } satisfies RouteContext);
  return method === "HEAD"
    ? new Response(null, {
        status: response.status,
        headers: response.headers,
      })
    : response;
}
