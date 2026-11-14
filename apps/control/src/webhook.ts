import { errorKind, logDiagnostic } from "./diagnostics";
import type { RunInput } from "./run-types";
import { isValidRepo } from "./repo";
import { verifySignature } from "./signature";
import { GUEST_LABEL } from "./triage-precheck";
import type { GuestIssue } from "./triage-service";

export const MAX_BODY_BYTES = 1024 * 1024;
export const TRIGGER_LABEL = "factory:go";
const MAX_TITLE = 500;
const MAX_BODY = 20_000;

export interface WebhookDeps {
  secret: string | undefined;
  /** Global kill switch. Only an explicit "true" in RUNS_ENABLED turns this on. */
  runsEnabled: boolean;
  /** True while an operator has stopped the factory (stage 7). Read only for a request that would start a run. */
  paused(): Promise<boolean>;
  /** Exact numeric GitHub user ids that may start a run. Empty means nobody. Logins can be renamed and reused; ids cannot. */
  operatorIds: string[];
  /** Exact `owner/name` values that may be run. Empty means nothing. */
  projects: string[];
  deliveries: {
    /** Returns false when the delivery id was already seen. */
    claim(deliveryId: string): Promise<boolean>;
    release(deliveryId: string): Promise<void>;
  };
  starter: { start(input: RunInput): Promise<unknown> };
  /** Stage 7. Guest triage. Unset when it is not configured: guest issues are then ignored. */
  guest?: GuestDeps;
}

export interface GuestDeps {
  /** Exact `owner/name` values where guests may ask. Each must also be in `projects`. */
  projects: string[];
  /** Triages one guest issue. It may take longer than GitHub waits for the response. */
  triage(issue: GuestIssue): Promise<unknown>;
  /** An operator closed the issue: a triage record that waited for them becomes a rejection. */
  adminClosed(repo: string, issueNumber: number): Promise<unknown>;
  /** Keeps the Worker alive for work that goes on after the response. */
  defer(work: Promise<void>): void;
}

const json = (
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });

const ignored = () => json({ status: "ignored" }, 202);

async function readLimited(
  request: Request,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const validId = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 1;

/** The repository and issue of an `issues` event, when the repository is one of `repos`. */
function issueOf(
  payload: Record<string, unknown>,
  repos: string[],
  state: "open" | "closed",
): { repo: string; issue: Record<string, unknown>; number: number } | null {
  const { repository, issue } = payload;
  if (!isRecord(repository) || typeof repository.full_name !== "string")
    return null;
  const repo = repository.full_name;
  if (!isValidRepo(repo) || !repos.includes(repo)) return null;
  if (
    !isRecord(issue) ||
    issue.pull_request !== undefined ||
    issue.state !== state
  )
    return null;
  if (!validId(issue.number)) return null;
  return { repo, issue, number: issue.number };
}

const snapshot = (issue: Record<string, unknown>) => ({
  title: typeof issue.title === "string" ? issue.title.slice(0, MAX_TITLE) : "",
  body: typeof issue.body === "string" ? issue.body.slice(0, MAX_BODY) : "",
});

const isBot = (user: Record<string, unknown>) =>
  user.type === "Bot" ||
  (typeof user.login === "string" && user.login.endsWith("[bot]"));

/** Returns the run request for a qualifying event, or null when the event must be ignored. */
function qualify(
  payload: unknown,
  deps: Pick<WebhookDeps, "operatorIds" | "projects">,
): Omit<RunInput, "deliveryId"> | null {
  if (!isRecord(payload) || payload.action !== "labeled") return null;
  const { label, sender } = payload;
  if (!isRecord(label) || label.name !== TRIGGER_LABEL) return null;
  if (!isRecord(sender) || typeof sender.login !== "string") return null;
  if (isBot(sender)) return null;
  if (!validId(sender.id)) return null;
  if (!deps.operatorIds.includes(String(sender.id))) return null;
  const found = issueOf(payload, deps.projects, "open");
  if (found === null) return null;
  return {
    repo: found.repo,
    issueNumber: found.number,
    ...snapshot(found.issue),
  };
}

/**
 * A guest's new issue (docs/guest-demo.md 4.1, checks 1 to 3): opened by its author, who is
 * a person and not an operator, in a guest repository, with the label the guest template
 * adds. GitHub drops labels that an account without triage rights sends through the API,
 * so the label shows that the template was used.
 */
function qualifyGuest(
  payload: unknown,
  deps: Pick<WebhookDeps, "operatorIds" | "projects">,
  guestProjects: string[],
): Omit<GuestIssue, "deliveryId"> | null {
  if (!isRecord(payload) || payload.action !== "opened") return null;
  const found = issueOf(
    payload,
    guestProjects.filter((r) => deps.projects.includes(r)),
    "open",
  );
  if (found === null) return null;
  const { sender } = payload;
  const user = found.issue.user;
  if (!isRecord(user) || !isRecord(sender)) return null;
  if (!validId(user.id) || sender.id !== user.id) return null;
  if (typeof user.login !== "string" || typeof user.type !== "string")
    return null;
  if (isBot(user) || deps.operatorIds.includes(String(user.id))) return null;
  const labels = Array.isArray(found.issue.labels)
    ? found.issue.labels.flatMap((l) =>
        isRecord(l) && typeof l.name === "string" ? [l.name] : [],
      )
    : [];
  if (!labels.includes(GUEST_LABEL)) return null;
  return {
    repo: found.repo,
    issueNumber: found.number,
    ...snapshot(found.issue),
    labels,
    author: { id: user.id, login: user.login, type: user.type },
  };
}

/** An operator closed an issue of a guest repository. */
function qualifyAdminClose(
  payload: unknown,
  deps: Pick<WebhookDeps, "operatorIds" | "projects">,
  guestProjects: string[],
): { repo: string; issueNumber: number } | null {
  if (!isRecord(payload) || payload.action !== "closed") return null;
  const { sender } = payload;
  if (!isRecord(sender) || !validId(sender.id) || isBot(sender)) return null;
  if (!deps.operatorIds.includes(String(sender.id))) return null;
  const found = issueOf(
    payload,
    guestProjects.filter((r) => deps.projects.includes(r)),
    "closed",
  );
  return found === null
    ? null
    : { repo: found.repo, issueNumber: found.number };
}

const DELIVERY_ID = /^[A-Za-z0-9-]{1,64}$/;

async function handleGuestEvent(
  request: Request,
  payload: unknown,
  deps: WebhookDeps,
): Promise<Response> {
  const guest = deps.guest;
  if (guest === undefined) return ignored();

  const closed = qualifyAdminClose(payload, deps, guest.projects);
  if (closed !== null) {
    try {
      await guest.adminClosed(closed.repo, closed.issueNumber);
    } catch (error) {
      logDiagnostic("triage_close_failed", { error: errorKind(error) });
      return json({ error: "internal_error" }, 500);
    }
    return json({ status: "recorded" }, 202);
  }

  const issue = qualifyGuest(payload, deps, guest.projects);
  if (issue === null) return ignored();
  // A stopped factory spends nothing: no triage model call either. The issue stays open.
  if (!deps.runsEnabled)
    return json({ status: "ignored", code: "runs_disabled" }, 202);
  if (await deps.paused())
    return json({ status: "ignored", code: "factory_paused" }, 202);

  const deliveryId = request.headers.get("x-github-delivery");
  if (deliveryId === null || !DELIVERY_ID.test(deliveryId))
    return json({ error: "missing_delivery_id" }, 400);
  if (!(await deps.deliveries.claim(deliveryId)))
    return json({ status: "duplicate" }, 202);

  // The model call and the GitHub actions outlast GitHub's 10 second wait: answer first.
  guest.defer(
    (async () => {
      try {
        await guest.triage({ ...issue, deliveryId });
      } catch (error) {
        logDiagnostic("triage_failed", { error: errorKind(error) });
        // A manual redelivery can then try again; the issue has no record yet.
        await deps.deliveries.release(deliveryId).catch(() => {});
      }
    })(),
  );
  return json({ status: "triage" }, 202);
}

export async function handleWebhook(
  request: Request,
  deps: WebhookDeps,
): Promise<Response> {
  if (request.method !== "POST")
    return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
  if (deps.secret === undefined || deps.secret === "")
    return json({ error: "not_configured" }, 503);

  const body = await readLimited(request);
  if (body === null) return json({ error: "payload_too_large" }, 413);

  const verified = await verifySignature(
    deps.secret,
    body,
    request.headers.get("x-hub-signature-256"),
  );
  if (!verified) return json({ error: "invalid_signature" }, 401);

  if (request.headers.get("x-github-event") !== "issues") return ignored();

  let payload: unknown;
  try {
    payload = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body),
    );
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const qualified = qualify(payload, deps);
  if (qualified === null) return handleGuestEvent(request, payload, deps);
  if (!deps.runsEnabled)
    return json({ status: "ignored", code: "runs_disabled" }, 202);
  if (await deps.paused())
    return json({ status: "ignored", code: "factory_paused" }, 202);

  const deliveryId = request.headers.get("x-github-delivery");
  if (deliveryId === null || !DELIVERY_ID.test(deliveryId)) {
    return json({ error: "missing_delivery_id" }, 400);
  }
  if (!(await deps.deliveries.claim(deliveryId)))
    return json({ status: "duplicate" }, 202);

  try {
    const result = await deps.starter.start({ ...qualified, deliveryId });
    if (
      isRecord(result) &&
      (result.outcome === "capacity_full" ||
        result.outcome === "budget_exhausted" ||
        result.outcome === "budget_reserved")
    ) {
      return json({ status: "rejected", code: result.outcome }, 202);
    }
    const runId =
      isRecord(result) && typeof result.runId === "string"
        ? result.runId
        : undefined;
    return json({ status: "accepted", runId }, 202);
  } catch (error) {
    logDiagnostic("webhook_start_failed", { error: errorKind(error) });
    // Let GitHub redeliver: the delivery id is released so the retry is not dropped.
    await deps.deliveries.release(deliveryId);
    return json({ error: "internal_error" }, 500);
  }
}
