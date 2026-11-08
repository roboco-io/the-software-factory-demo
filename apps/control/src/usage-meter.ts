export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

type Target = "anthropic" | "openai";
type Json = Record<string, unknown>;

const LINE_CAP = 1024 * 1024;
const JSON_CAP = 8 * 1024 * 1024;

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0
    ? Math.floor(v)
    : 0;
}

function obj(v: unknown): Json | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Json)
    : null;
}

function openaiUsage(raw: unknown): Usage | null {
  const u = obj(raw);
  if (!u) return null;
  const details = obj(u.input_tokens_details) ?? obj(u.prompt_tokens_details);
  const input = num(u.input_tokens ?? u.prompt_tokens);
  const cached = Math.min(num(details?.cached_tokens), input);
  return {
    inputTokens: input - cached,
    outputTokens: num(u.output_tokens ?? u.completion_tokens),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

function anthropicUsage(raw: unknown): Usage | null {
  const u = obj(raw);
  if (!u) return null;
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheWriteTokens: num(u.cache_creation_input_tokens),
  };
}

/** Folds one decoded JSON event/body into the running state. Only counters are kept. */
function fold(
  target: Target,
  state: { usage: Usage | null },
  data: unknown,
): void {
  const d = obj(data);
  if (!d) return;
  if (target === "anthropic") {
    if (d.type === "message_start") {
      const u = anthropicUsage(obj(d.message)?.usage);
      if (u) state.usage = u;
    } else if (d.type === "message_delta") {
      const du = obj(d.usage);
      const out = du?.output_tokens;
      // Newer API versions repeat the final input and cache counts here.
      if (du && state.usage) {
        if (du.input_tokens !== undefined)
          state.usage.inputTokens = num(du.input_tokens);
        if (du.cache_read_input_tokens !== undefined)
          state.usage.cacheReadTokens = num(du.cache_read_input_tokens);
        if (du.cache_creation_input_tokens !== undefined)
          state.usage.cacheWriteTokens = num(du.cache_creation_input_tokens);
      }
      if (out !== undefined && state.usage) state.usage.outputTokens = num(out);
      else if (out !== undefined) {
        state.usage = {
          inputTokens: 0,
          outputTokens: num(out),
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        };
      }
    } else if (d.usage) {
      // non-stream message body
      const u = anthropicUsage(d.usage);
      if (u) state.usage = u;
    }
    return;
  }
  const u = openaiUsage(obj(d.response)?.usage ?? d.usage);
  if (u) state.usage = u;
}

function foldLine(
  target: Target,
  state: { usage: Usage | null },
  line: string,
): void {
  if (!line.startsWith("data:")) return;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return;
  try {
    fold(target, state, JSON.parse(payload));
  } catch {
    // malformed event: ignore, keep what we have
  }
}

export async function parseUsage(
  target: Target,
  stream: ReadableStream<Uint8Array>,
  contentType: string,
): Promise<Usage | null> {
  const reader = stream.getReader();
  const state: { usage: Usage | null } = { usage: null };
  const decoder = new TextDecoder();
  const sse = contentType.toLowerCase().includes("text/event-stream");
  try {
    let buf = "";
    let overflow = false;
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (!sse) {
        total += text.length;
        if (total > JSON_CAP) return null;
        buf += text;
        continue;
      }
      let start = 0;
      for (;;) {
        const nl = text.indexOf("\n", start);
        if (nl === -1) {
          if (!overflow) {
            buf += text.slice(start);
            if (buf.length > LINE_CAP) {
              buf = "";
              overflow = true;
            }
          }
          break;
        }
        if (!overflow) {
          buf += text.slice(start, nl);
          if (buf.length <= LINE_CAP)
            foldLine(target, state, buf.replace(/\r$/, ""));
        }
        buf = "";
        overflow = false;
        start = nl + 1;
      }
    }
    buf += decoder.decode();
    if (sse) {
      if (!overflow && buf) foldLine(target, state, buf.replace(/\r$/, ""));
    } else {
      try {
        fold(target, state, JSON.parse(buf));
      } catch {
        return null;
      }
    }
    return state.usage;
  } catch {
    // A stream that broke midway still billed what was seen so far (message_start).
    return sse ? state.usage : null;
  } finally {
    reader.cancel().catch(() => {});
  }
}

export function meterResponse(
  response: Response,
  target: Target,
  onUsage: (u: Usage) => Promise<void>,
  /** Called instead of onUsage when a successful response has no readable usage. */
  onMissing?: () => Promise<void>,
): { response: Response; done: Promise<void> } {
  if (!response.ok || !response.body)
    return { response, done: Promise.resolve() };
  try {
    const [client, meter] = response.body.tee();
    const out = new Response(client, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    const done = (async () => {
      try {
        const usage = await parseUsage(
          target,
          meter,
          response.headers.get("content-type") ?? "",
        );
        if (usage) await onUsage(usage);
        else await onMissing?.();
      } catch {
        // metering must never surface an error
        await onMissing?.().catch(() => undefined);
      }
    })();
    return { response: out, done };
  } catch {
    return { response, done: Promise.resolve() };
  }
}
