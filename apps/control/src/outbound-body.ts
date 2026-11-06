export const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
export const MAX_OUTPUT_TOKENS = 16000;

/**
 * Beta flags the pinned Claude Code (2.1.318) is known to use for plain messages.
 * Anything else is removed before the request leaves. Features such as file APIs,
 * MCP connectors, web search and managed agents stay unavailable.
 */
export const BETA_ALLOWLIST: ReadonlySet<string> = new Set([
  "claude-code-20250219",
  "interleaved-thinking-2025-05-14",
  "fine-grained-tool-streaming-2025-05-14",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "extended-cache-ttl-2025-04-11",
  "effort-2025-11-24",
  "structured-outputs-2025-12-15",
  "token-counting-2024-11-01",
  "advanced-tool-use-2025-11-20",
  "tool-search-tool-2025-10-19",
  "redact-thinking-2026-02-12",
]);

export type BodyDecision =
  { ok: true } | { ok: false; reason: string; status: number };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Checks a parsed `/v1/messages` or `/v1/messages/count_tokens` body against the run's limits. */
export function inspectAnthropicBody(
  body: unknown,
  run: { model: string },
  path: string,
): BodyDecision {
  const deny = (reason: string): BodyDecision => ({
    ok: false,
    reason,
    status: 403,
  });
  if (!isRecord(body)) return deny("body_not_object");
  if (body.model !== run.model) return deny("model_not_allowed");
  if ("mcp_servers" in body) return deny("mcp_servers_not_allowed");
  if ("container" in body) return deny("container_not_allowed");
  if (path === "/v1/messages") {
    const max = body.max_tokens;
    if (
      typeof max !== "number" ||
      !Number.isInteger(max) ||
      max < 1 ||
      max > MAX_OUTPUT_TOKENS
    ) {
      return deny("max_tokens_not_allowed");
    }
  }
  return { ok: true };
}

/** Keeps only allowlisted beta flags; removes the header when none remain. */
export function filterBetaHeader(headers: Headers): Headers {
  const out = new Headers(headers);
  const value = out.get("anthropic-beta");
  if (value === null) return out;
  const kept = value
    .split(",")
    .map((v) => v.trim())
    .filter((v) => BETA_ALLOWLIST.has(v));
  if (kept.length === 0) out.delete("anthropic-beta");
  else out.set("anthropic-beta", kept.join(","));
  return out;
}

/** Reads a request body with a hard byte limit. Returns null when the limit is exceeded. */
export async function readLimitedBody(
  request: Request,
  limit = MAX_REQUEST_BYTES,
): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) return null;
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Full request check for the Anthropic target. Returns the request to forward (with
 * the body re-attached and beta flags filtered) or a denial. The response is never
 * read here, so streaming responses pass through untouched.
 */
export async function prepareAnthropicRequest(
  request: Request,
  run: { model: string | undefined },
): Promise<
  { ok: true; request: Request } | { ok: false; reason: string; status: number }
> {
  if (run.model === undefined)
    return { ok: false, reason: "no_model_bound", status: 403 };
  const bytes = await readLimitedBody(request);
  if (bytes === null)
    return { ok: false, reason: "request_too_large", status: 413 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    return { ok: false, reason: "body_not_json", status: 403 };
  }
  const decision = inspectAnthropicBody(
    parsed,
    { model: run.model },
    new URL(request.url).pathname,
  );
  if (!decision.ok) return decision;
  return {
    ok: true,
    request: new Request(request.url, {
      method: request.method,
      headers: filterBetaHeader(request.headers),
      body: bytes as BodyInit,
      redirect: "manual",
    }),
  };
}
