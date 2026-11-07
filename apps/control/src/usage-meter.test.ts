import { describe, expect, it } from "vitest";
import { meterResponse, parseUsage, type Usage } from "./usage-meter";

const enc = new TextEncoder();
function body(
  text: string | Uint8Array[],
  size = 0,
): ReadableStream<Uint8Array> {
  const chunks =
    typeof text !== "string"
      ? text
      : size > 0
        ? Array.from(
            { length: Math.ceil(enc.encode(text).length / size) },
            (_, i) => enc.encode(text).slice(i * size, (i + 1) * size),
          )
        : [enc.encode(text)];
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
}
const ev = (o: unknown) => `event: x\ndata: ${JSON.stringify(o)}\n\n`;
const anthropicSse =
  ev({
    type: "message_start",
    message: {
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 3,
        output_tokens: 1,
      },
    },
  }) + ev({ type: "message_delta", usage: { output_tokens: 5 } });
const openaiSse = ev({
  type: "response.completed",
  response: {
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 4 },
      output_tokens: 5,
    },
  },
});
const SSE = "text/event-stream";
const bytes = async (r: Response) => new Uint8Array(await r.arrayBuffer());

describe("parseUsage", () => {
  it("anthropic sse", async () => {
    expect(await parseUsage("anthropic", body(anthropicSse), SSE)).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 3,
    });
  });
  it("openai sse subtracts cached", async () => {
    expect(await parseUsage("openai", body(openaiSse), SSE)).toEqual({
      inputTokens: 6,
      outputTokens: 5,
      cacheReadTokens: 4,
      cacheWriteTokens: 0,
    });
  });
  it("not json -> null", async () => {
    expect(
      await parseUsage("openai", body("not json"), "application/json"),
    ).toBeNull();
  });
  it("json non-stream usage parsed", async () => {
    const j = JSON.stringify({ usage: { input_tokens: 7, output_tokens: 3 } });
    expect(await parseUsage("anthropic", body(j), "application/json")).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(
      await parseUsage("openai", body(j), "application/json; charset=utf-8"),
    ).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });
  it("chunk boundaries inside a line", async () => {
    expect(await parseUsage("anthropic", body(anthropicSse, 7), SSE)).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 3,
    });
  });
  it("multibyte split and CRLF", async () => {
    const s = ev({
      type: "message_start",
      message: { usage: { input_tokens: 4 }, note: "한글😀" },
    }).replace(/\n/g, "\r\n");
    expect((await parseUsage("anthropic", body(s, 1), SSE))?.inputTokens).toBe(
      4,
    );
  });
  it("bad numbers become 0; cached larger than input clamps", async () => {
    const s = ev({
      response: {
        usage: {
          input_tokens: 3,
          input_tokens_details: { cached_tokens: 9 },
          output_tokens: -5,
        },
      },
    });
    expect(await parseUsage("openai", body(s), SSE)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 3,
      cacheWriteTokens: 0,
    });
  });
  it("test_line_cap: oversized line dropped, later events still parsed", async () => {
    const big = "data: " + "x".repeat(1024 * 1024 + 10) + "\n";
    const s = big + anthropicSse;
    expect(
      (await parseUsage("anthropic", body(s, 65536), SSE))?.outputTokens,
    ).toBe(5);
  });
  it("malformed event lines ignored", async () => {
    const s = "data: {bad\n\n" + anthropicSse;
    expect((await parseUsage("anthropic", body(s), SSE))?.inputTokens).toBe(10);
  });
});

describe("meterResponse", () => {
  const sseResponse = (s: string | Uint8Array[], size = 0, status = 200) =>
    new Response(body(s, size), { status, headers: { "content-type": SSE } });

  it("body passes", async () => {
    const m = meterResponse(new Response("x"), "anthropic", async () => {});
    expect(await m.response.text()).toBe("x");
    await m.done;
  });
  it("test_body_bytes_identical with split multibyte stream, usage recorded", async () => {
    const text =
      ev({
        type: "message_start",
        message: { usage: { input_tokens: 1 }, t: "한글😀" },
      }) + anthropicSse;
    const raw = enc.encode(text);
    const got: Usage[] = [];
    const m = meterResponse(
      sseResponse(text, 3),
      "anthropic",
      async (u) => void got.push(u),
    );
    expect(await bytes(m.response)).toEqual(raw);
    await m.done;
    expect(got).toEqual([
      {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheWriteTokens: 3,
      },
    ]);
  });
  it("test_parser_throw_keeps_stream: onUsage rejects", async () => {
    const m = meterResponse(
      sseResponse(anthropicSse),
      "anthropic",
      async () => {
        throw new Error("boom");
      },
    );
    expect(await m.response.text()).toBe(anthropicSse);
    await expect(m.done).resolves.toBeUndefined();
  });
  it("test_parser_throw_keeps_stream: malformed JSON", async () => {
    const s = "data: {oops\n\ndata: [DONE]\n\n";
    let called = false;
    const m = meterResponse(
      sseResponse(s),
      "openai",
      async () => void (called = true),
    );
    expect(await m.response.text()).toBe(s);
    await m.done;
    expect(called).toBe(false);
  });
  it("test_upstream_error_passthrough", async () => {
    const r = new Response("slow down", { status: 429 });
    let called = false;
    const m = meterResponse(r, "anthropic", async () => void (called = true));
    expect(m.response).toBe(r);
    expect(m.response.status).toBe(429);
    await m.done;
    expect(called).toBe(false);
  });
  it("test_no_body_passthrough", async () => {
    const r = new Response(null, { status: 204 });
    const m = meterResponse(r, "anthropic", async () => {});
    expect(m.response).toBe(r);
    await m.done;
  });
  it("client cancel does not reject done", async () => {
    const m = meterResponse(
      sseResponse(anthropicSse, 5),
      "anthropic",
      async () => {},
    );
    await m.response.body!.cancel();
    await expect(m.done).resolves.toBeUndefined();
  });
  it("keeps status and headers", async () => {
    const m = meterResponse(
      sseResponse(anthropicSse),
      "anthropic",
      async () => {},
    );
    expect(m.response.status).toBe(200);
    expect(m.response.headers.get("content-type")).toBe(SSE);
    await m.response.text();
    await m.done;
  });

  it("regression: stream that errors midway still returns message_start usage", async () => {
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent) return c.error(new Error("aborted"));
        sent = true;
        c.enqueue(
          enc.encode(
            ev({
              type: "message_start",
              message: { usage: { input_tokens: 9, output_tokens: 1 } },
            }),
          ),
        );
      },
    });
    const u = await parseUsage("anthropic", stream, SSE);
    expect(u).toMatchObject({ inputTokens: 9, outputTokens: 1 });
  });

  it("regression: message_delta repeating cache and input counts overrides them", async () => {
    const sse =
      ev({
        type: "message_start",
        message: { usage: { input_tokens: 1, output_tokens: 1 } },
      }) +
      ev({
        type: "message_delta",
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 4,
          output_tokens: 8,
        },
      });
    expect(await parseUsage("anthropic", body(sse), SSE)).toMatchObject({
      inputTokens: 10,
      cacheReadTokens: 4,
      outputTokens: 8,
    });
  });
});
