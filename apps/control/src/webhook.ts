import { errorKind, logDiagnostic } from "./diagnostics";
import type { RunInput } from "./run-types";
import { isValidRepo } from "./repo";
import { verifySignature } from "./signature";

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

/** Returns the run request for a qualifying event, or null when the event must be ignored. */
function qualify(
  payload: unknown,
  deps: Pick<WebhookDeps, "operatorIds" | "projects">,
): Omit<RunInput, "deliveryId"> | null {
  if (!isRecord(payload) || payload.action !== "labeled") return null;
  const { label, sender, repository, issue } = payload;
  if (!isRecord(label) || label.name !== TRIGGER_LABEL) return null;
  if (!isRecord(sender) || typeof sender.login !== "string") return null;
  if (sender.type === "Bot" || sender.login.endsWith("[bot]")) return null;
  const senderId = sender.id;
  if (
    typeof senderId !== "number" ||
    !Number.isSafeInteger(senderId) ||
    senderId < 1
  )
    return null;
  if (!deps.operatorIds.includes(String(senderId))) return null;
  if (!isRecord(repository) || typeof repository.full_name !== "string")
    return null;
  const repo = repository.full_name;
  if (!isValidRepo(repo) || !deps.projects.includes(repo)) return null;
  if (
    !isRecord(issue) ||
    issue.pull_request !== undefined ||
    issue.state !== "open"
  )
    return null;
  const number = issue.number;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1)
    return null;
  const title =
    typeof issue.title === "string" ? issue.title.slice(0, MAX_TITLE) : "";
  const body =
    typeof issue.body === "string" ? issue.body.slice(0, MAX_BODY) : "";
  return { repo, issueNumber: number, title, body };
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
  if (qualified === null) return ignored();
  if (!deps.runsEnabled)
    return json({ status: "ignored", code: "runs_disabled" }, 202);
  if (await deps.paused())
    return json({ status: "ignored", code: "factory_paused" }, 202);

  const deliveryId = request.headers.get("x-github-delivery");
  if (deliveryId === null || !/^[A-Za-z0-9-]{1,64}$/.test(deliveryId)) {
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
