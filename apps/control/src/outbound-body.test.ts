import { describe, expect, it } from "vitest";
import {
  BETA_ALLOWLIST,
  MAX_REQUEST_BYTES,
  filterBetaHeader,
  inspectAnthropicBody,
  prepareAnthropicRequest,
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
