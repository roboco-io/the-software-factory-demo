import { describe, expect, it } from "vitest";
import { createTriageClassifier } from "./triage-model";

const message = (over: Record<string, unknown> = {}) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-haiku-5-5",
  content: [
    { type: "thinking", thinking: "", signature: "s" },
    { type: "text", text: '{"decision":"reject"}' },
  ],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: 900,
    output_tokens: 80,
    cache_read_input_tokens: 10,
    cache_creation_input_tokens: null,
  },
  ...over,
});

function classifier(respond: () => Response) {
  const calls: { url: string; headers: Headers; body: unknown }[] = [];
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push({
      url: request.url,
      headers: request.headers,
      body: JSON.parse(await request.text()),
    });
    return respond();
  }) as typeof fetch;
  return {
    calls,
    classifier: createTriageClassifier({
      apiKey: "test-key",
      model: "claude-haiku-5-5",
      fetch: fetchStub,
    }),
  };
}

describe("triage model call", () => {
  it("sends one Messages request and returns the text and the usage", async () => {
    const { calls, classifier: c } = classifier(() => Response.json(message()));
    const result = await c.classify({ system: "POLICY", user: "ISSUE" });
    expect(result).toEqual({
      ok: true,
      text: '{"decision":"reject"}',
      usage: {
        inputTokens: 900,
        outputTokens: 80,
        cacheReadTokens: 10,
        cacheWriteTokens: 0,
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    // The SDK sends the API key as a bearer token.
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer test-key");
    expect(calls[0]!.body).toEqual({
      model: "claude-haiku-5-5",
      max_tokens: 4000,
      system: "POLICY",
      output_config: { effort: "low" },
      messages: [{ role: "user", content: "ISSUE" }],
    });
  });

  it("gives no answer, but the usage, when the model did not finish its turn", async () => {
    for (const stop of ["max_tokens", "refusal"]) {
      const { classifier: c } = classifier(() =>
        Response.json(message({ stop_reason: stop })),
      );
      const result = await c.classify({ system: "s", user: "u" });
      expect(result.ok).toBe(false);
      expect(result.usage?.inputTokens).toBe(900);
    }
  });

  it("gives no answer on an API error and does not retry", async () => {
    const { calls, classifier: c } = classifier(() =>
      Response.json(
        { type: "error", error: { type: "overloaded_error", message: "x" } },
        { status: 529 },
      ),
    );
    expect(await c.classify({ system: "s", user: "u" })).toEqual({ ok: false });
    expect(calls).toHaveLength(1);
  });
});
