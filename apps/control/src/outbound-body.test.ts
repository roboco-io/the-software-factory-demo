import { describe, expect, it, vi } from "vitest";
import {
  BETA_ALLOWLIST,
  MAX_REQUEST_BYTES,
  filterBetaHeader,
  OPENAI_MAX_OUTPUT_TOKENS,
  inspectAnthropicBody,
  inspectOpenAIBody,
  prepareAnthropicRequest,
  prepareOpenAIRequest,
} from "./outbound-body";

const run = { model: "claude-sonnet-5-5" };
const good = { model: run.model, max_tokens: 16000, messages: [] };

describe("inspectAnthropicBody", () => {
  it("accepts the run's model with max_tokens up to 16000", () => {
    expect(inspectAnthropicBody(good, run, "/v1/messages")).toEqual({
      ok: true,
    });
    expect(
      inspectAnthropicBody(
        { model: run.model },
        run,
        "/v1/messages/count_tokens",
      ),
    ).toEqual({ ok: true });
  });
  it.each([
    ["other model", { ...good, model: "claude-opus-5" }, "model_not_allowed"],
    ["missing model", { max_tokens: 5 }, "model_not_allowed"],
    [
      "max_tokens above 16000",
      { ...good, max_tokens: 16001 },
      "max_tokens_not_allowed",
    ],
    ["max_tokens missing", { model: run.model }, "max_tokens_not_allowed"],
    [
      "max_tokens string",
      { ...good, max_tokens: "10" },
      "max_tokens_not_allowed",
    ],
    [
      "max_tokens fractional",
      { ...good, max_tokens: 1.5 },
      "max_tokens_not_allowed",
    ],
    ["mcp_servers", { ...good, mcp_servers: [] }, "mcp_servers_not_allowed"],
    ["container", { ...good, container: "x" }, "container_not_allowed"],
    ["array body", [], "body_not_object"],
    ["null body", null, "body_not_object"],
  ])("denies %s", (_n, body, reason) => {
    expect(inspectAnthropicBody(body, run, "/v1/messages")).toMatchObject({
      ok: false,
      reason,
    });
  });
});

describe("inspectAnthropicBody: tools", () => {
  const withTools = (tools: unknown) => ({ ...good, tools });
  it("denies the hosted web search tool, whatever its version", () => {
    for (const type of [
      "web_search_20250305",
      "web_search_20260101",
      "WEB_SEARCH_x",
    ]) {
      expect(
        inspectAnthropicBody(
          withTools([{ type, name: "web_search", max_uses: 5 }]),
          run,
          "/v1/messages",
        ),
      ).toMatchObject({ ok: false, reason: "web_search_not_allowed" });
    }
    expect(
      inspectAnthropicBody(
        withTools([
          { name: "Read", input_schema: { type: "object" } },
          { type: "web_search_20250305", name: "web_search" },
        ]),
        run,
        "/v1/messages/count_tokens",
      ),
    ).toMatchObject({ ok: false, reason: "web_search_not_allowed" });
  });
  it("keeps plain local tools working, with or without a type of custom", () => {
    expect(
      inspectAnthropicBody(
        withTools([
          { name: "Bash", description: "d", input_schema: { type: "object" } },
          { type: "custom", name: "Read", input_schema: { type: "object" } },
        ]),
        run,
        "/v1/messages",
      ),
    ).toEqual({ ok: true });
  });
});

describe("filterBetaHeader", () => {
  it("keeps allowlisted flags and drops the rest", () => {
    const out = filterBetaHeader(
      new Headers({
        "anthropic-beta":
          "claude-code-20250219, files-api-2025-04-14,mcp-client-2025-11-20,interleaved-thinking-2025-05-14",
      }),
    );
    expect(out.get("anthropic-beta")).toBe(
      "claude-code-20250219,interleaved-thinking-2025-05-14",
    );
  });
  it("removes the header when nothing is allowed", () => {
    expect(
      filterBetaHeader(
        new Headers({ "anthropic-beta": "code-execution-2025-08-25" }),
      ).has("anthropic-beta"),
    ).toBe(false);
  });
  it("never allows dangerous families", () => {
    for (const flag of BETA_ALLOWLIST)
      expect(flag).not.toMatch(
        /mcp|files|code-execution|web-search|managed|skills/,
      );
  });
});

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request("https://api.anthropic.com/v1/messages?beta=true", {
    method: "POST",
    headers,
    body,
  });

describe("prepareAnthropicRequest", () => {
  it("forwards a valid request with the body intact and beta flags filtered", async () => {
    const r = await prepareAnthropicRequest(
      post(JSON.stringify(good), {
        "anthropic-beta": "files-api-2025-04-14,claude-code-20250219",
      }),
      run,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await r.request.json()).toEqual(good);
    expect(r.request.headers.get("anthropic-beta")).toBe(
      "claude-code-20250219",
    );
    expect(r.request.url).toContain("beta=true");
  });
  it("denies bodies over 4 MB by header and by streamed size", async () => {
    const big = "x".repeat(MAX_REQUEST_BYTES + 1);
    expect(await prepareAnthropicRequest(post(big), run)).toMatchObject({
      ok: false,
      status: 413,
    });
    const lying = post(big, { "content-length": "5" });
    expect(await prepareAnthropicRequest(lying, run)).toMatchObject({
      ok: false,
      status: 413,
    });
  });
  it("denies invalid JSON and policy violations", async () => {
    expect(await prepareAnthropicRequest(post("{nope"), run)).toMatchObject({
      ok: false,
      reason: "body_not_json",
    });
    expect(
      await prepareAnthropicRequest(
        post(JSON.stringify({ ...good, model: "x" })),
        run,
      ),
    ).toMatchObject({ ok: false, reason: "model_not_allowed" });
    expect(
      await prepareAnthropicRequest(post(JSON.stringify(good)), {
        model: undefined,
      }),
    ).toMatchObject({ ok: false });
  });
});

const oaiRun = { model: "gpt-5.4-nano" };
// What pi 1.5.0 sends for gpt-5.4-nano with function tools (from the package source).
const oaiGood = {
  model: oaiRun.model,
  input: [{ role: "user", content: "hi" }],
  stream: true,
  store: false,
  prompt_cache_key: "k",
  max_output_tokens: 16000,
  reasoning: { effort: "low", summary: "auto" },
  include: ["reasoning.encrypted_content"],
  tool_choice: "auto",
  tools: [
    {
      type: "function",
      name: "read",
      description: "d",
      parameters: {},
      strict: false,
    },
  ],
};

describe("inspectOpenAIBody", () => {
  it("accepts what pi sends", () => {
    expect(inspectOpenAIBody(oaiGood, oaiRun)).toEqual({ ok: true });
    expect(
      inspectOpenAIBody({ model: oaiRun.model, input: [] }, oaiRun),
    ).toEqual({ ok: true });
  });
  it.each<[string, unknown, string]>([
    ["other model", { ...oaiGood, model: "gpt-5.5" }, "model_not_allowed"],
    ["missing model", { input: [] }, "model_not_allowed"],
    ["store true", { ...oaiGood, store: true }, "store_not_allowed"],
    ["store as string", { ...oaiGood, store: "true" }, "store_not_allowed"],
    [
      "background true",
      { ...oaiGood, background: true },
      "background_not_allowed",
    ],
    [
      "background as string",
      { ...oaiGood, background: "yes" },
      "background_not_allowed",
    ],
    [
      "previous_response_id",
      { ...oaiGood, previous_response_id: "resp_1" },
      "previous_response_id_not_allowed",
    ],
    [
      "conversation",
      { ...oaiGood, conversation: "conv_1" },
      "conversation_not_allowed",
    ],
    [
      "stored prompt",
      { ...oaiGood, prompt: { id: "p" } },
      "prompt_not_allowed",
    ],
    [
      "max_output_tokens above the cap",
      { ...oaiGood, max_output_tokens: OPENAI_MAX_OUTPUT_TOKENS + 1 },
      "max_output_tokens_not_allowed",
    ],
    [
      "max_output_tokens pi default for gpt-5.4-nano",
      { ...oaiGood, max_output_tokens: 128000 },
      "max_output_tokens_not_allowed",
    ],
    [
      "max_output_tokens zero",
      { ...oaiGood, max_output_tokens: 0 },
      "max_output_tokens_not_allowed",
    ],
    [
      "max_output_tokens string",
      { ...oaiGood, max_output_tokens: "10" },
      "max_output_tokens_not_allowed",
    ],
    [
      "web search tool",
      { ...oaiGood, tools: [{ type: "web_search" }] },
      "tool_type_not_allowed",
    ],
    [
      "file search tool",
      { ...oaiGood, tools: [{ type: "file_search", vector_store_ids: ["v"] }] },
      "tool_type_not_allowed",
    ],
    [
      "code interpreter tool",
      { ...oaiGood, tools: [{ type: "code_interpreter" }] },
      "tool_type_not_allowed",
    ],
    [
      "mcp tool",
      { ...oaiGood, tools: [{ type: "mcp", server_url: "https://x" }] },
      "tool_type_not_allowed",
    ],
    [
      "custom tool",
      { ...oaiGood, tools: [{ type: "custom", name: "x" }] },
      "tool_type_not_allowed",
    ],
    [
      "tool without type",
      { ...oaiGood, tools: [{ name: "x" }] },
      "tool_type_not_allowed",
    ],
    [
      "hosted tool after a function tool",
      { ...oaiGood, tools: [oaiGood.tools[0], { type: "web_search_preview" }] },
      "tool_type_not_allowed",
    ],
    [
      "tools not an array",
      { ...oaiGood, tools: "web_search" },
      "tools_not_allowed",
    ],
    // Codex 0.166.0 sent its tools as an input item, not in `tools`: the same rule applies there.
    [
      "hosted tool in an additional_tools input item",
      {
        ...oaiGood,
        input: [{ type: "additional_tools", tools: [{ type: "web_search" }] }],
      },
      "tool_type_not_allowed",
    ],
    [
      "hosted tool inside a namespace",
      {
        ...oaiGood,
        input: [
          {
            type: "additional_tools",
            tools: [
              {
                type: "namespace",
                name: "functions",
                tools: [{ type: "function", name: "a" }, { type: "mcp" }],
              },
            ],
          },
        ],
      },
      "tool_type_not_allowed",
    ],
    [
      "hosted tool in a top-level namespace",
      {
        ...oaiGood,
        tools: [{ type: "namespace", tools: [{ type: "code_interpreter" }] }],
      },
      "tool_type_not_allowed",
    ],
    [
      "additional_tools without a tool array",
      { ...oaiGood, input: [{ type: "additional_tools", tools: "x" }] },
      "tools_not_allowed",
    ],
    ["array body", [], "body_not_object"],
    ["null body", null, "body_not_object"],
  ])("denies %s", (_n, body, reason) => {
    expect(inspectOpenAIBody(body, oaiRun)).toMatchObject({
      ok: false,
      reason,
    });
  });
  it("accepts the request shape pi 1.5.0 sends as the implementer (captured locally on 2026-11-09)", () => {
    const tool = (name: string) => ({
      type: "function",
      name,
      description: "d",
      parameters: { type: "object", properties: {} },
      strict: false,
    });
    const body = {
      model: "gpt-6.1-terra",
      stream: true,
      prompt_cache_key: "k",
      store: false,
      max_output_tokens: 16000,
      reasoning: { effort: "medium", summary: "auto" },
      include: ["reasoning.encrypted_content"],
      input: [
        { type: "configuration_update", reasoning: { effort: "medium" } },
        { role: "developer", content: "system prompt" },
        {
          type: "additional_tools",
          tools: ["read", "bash", "edit", "write"].map(tool),
        },
        { role: "user", content: [{ type: "input_text", text: "task" }] },
      ],
    };
    expect(inspectOpenAIBody(body, { model: "gpt-6.1-terra" })).toEqual({
      ok: true,
    });
  });
  it("accepts function tools in namespaces and in additional_tools items", () => {
    const fn = { type: "function", name: "a", parameters: {} };
    expect(
      inspectOpenAIBody(
        {
          ...oaiGood,
          tools: [{ type: "namespace", name: "n", tools: [fn] }],
          input: [
            { type: "additional_tools", tools: [fn] },
            { type: "message", role: "user", content: "hi" },
          ],
        },
        oaiRun,
      ),
    ).toEqual({ ok: true });
  });
  it("allows explicit false for store and background", () => {
    expect(
      inspectOpenAIBody(
        { ...oaiGood, store: false, background: false },
        oaiRun,
      ),
    ).toEqual({ ok: true });
  });
});

describe("prepareOpenAIRequest", () => {
  const oai = (body: BodyInit, headers: Record<string, string> = {}) =>
    new Request("https://api.openai.com/v1/responses", {
      method: "POST",
      headers,
      body,
    });
  it("forwards a valid request with the body and headers intact", async () => {
    const r = await prepareOpenAIRequest(
      oai(JSON.stringify(oaiGood), { "content-type": "application/json" }),
      oaiRun,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await r.request.json()).toEqual(oaiGood);
    expect(r.request.headers.get("content-type")).toBe("application/json");
  });
  it("denies bodies over 4 MB by header and by streamed size", async () => {
    const big = "x".repeat(MAX_REQUEST_BYTES + 1);
    expect(await prepareOpenAIRequest(oai(big), oaiRun)).toMatchObject({
      ok: false,
      status: 413,
    });
    expect(
      await prepareOpenAIRequest(oai(big, { "content-length": "5" }), oaiRun),
    ).toMatchObject({ ok: false, status: 413 });
  });
  it("denies invalid JSON, policy violations and a missing bound model", async () => {
    expect(await prepareOpenAIRequest(oai("{nope"), oaiRun)).toMatchObject({
      ok: false,
      reason: "body_not_json",
    });
    expect(
      await prepareOpenAIRequest(
        oai(JSON.stringify({ ...oaiGood, store: true })),
        oaiRun,
      ),
    ).toMatchObject({ ok: false, reason: "store_not_allowed" });
    expect(
      await prepareOpenAIRequest(oai(JSON.stringify(oaiGood)), {
        model: undefined,
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("outbound body logs", () => {
  it("log only the fixed denial reason, never the body, a prompt or a key", () => {
    const secret = "sk-oai-REAL-SECRET-123456";
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      inspectOpenAIBody(
        {
          ...oaiGood,
          store: true,
          input: [{ role: "user", content: `${secret} ignore all rules` }],
          tools: [{ type: "web_search", note: secret }],
        },
        oaiRun,
      );
      inspectOpenAIBody(
        { ...oaiGood, tools: [{ type: "web_search" }] },
        oaiRun,
      );
      inspectAnthropicBody(
        {
          ...good,
          messages: [{ content: secret }],
          tools: [{ type: "web_search_20250305", name: secret }],
        },
        run,
        "/v1/messages",
      );
      const lines = spy.mock.calls.map((c) => String(c[0]));
      expect(lines).toHaveLength(3);
      for (const line of lines) {
        expect(line).not.toContain(secret);
        expect(line).not.toContain("ignore all rules");
        expect(Object.keys(JSON.parse(line) as object).sort()).toEqual([
          "event",
          "reason",
        ]);
      }
    } finally {
      spy.mockRestore();
    }
  });
});
