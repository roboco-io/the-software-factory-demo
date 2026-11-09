import { describe, expect, it } from "vitest";
import { classifyAgentFailure } from "./agent-failure";

const out = (stderr: string, stdout = "") => ({ stderr, stdout });

describe("classifyAgentFailure", () => {
  it.each<[string, number, { stderr: string; stdout: string }, string]>([
    ["missing binary", 127, out("sh: 1: pi: not found"), "command_not_found"],
    ["not executable", 126, out(""), "not_executable"],
    [
      "missing agent home",
      1,
      out(
        'Error finding codex home: CODEX_HOME points to "/x", but that path does not exist',
      ),
      "agent_home_missing",
    ],
    [
      "egress refusal",
      1,
      out("400 DENIED: tool_type_not_allowed"),
      "egress_denied",
    ],
    ["budget refusal", 1, out("402 Payment Required"), "budget_denied"],
    [
      "bad key",
      1,
      out(
        "",
        '{"type":"error","message":"401 Unauthorized: Incorrect API key"}',
      ),
      "auth_rejected",
    ],
    ["rate limit", 1, out("429 Too Many Requests"), "rate_limited"],
    [
      "unknown model",
      1,
      out("The model `x` does not exist"),
      "model_not_found",
    ],
    [
      "permission",
      1,
      out("EACCES: permission denied, mkdir '/x'"),
      "permission_denied",
    ],
    ["tls", 1, out("unable to get local issuer certificate"), "network_error"],
    ["dns", 1, out("getaddrinfo ENOTFOUND api.openai.com"), "network_error"],
    ["nothing printed", 1, out("", ""), "no_output"],
    ["anything else", 1, out("something odd"), "unknown"],
  ])("labels %s", (_name, exitCode, output, kind) => {
    expect(classifyAgentFailure(exitCode, output).kind).toBe(kind);
  });

  it("keeps the egress reason only when it is one of our own reason tokens", () => {
    expect(
      classifyAgentFailure(1, out("DENIED: tool_type_not_allowed\n")),
    ).toEqual({ kind: "egress_denied", detail: "tool_type_not_allowed" });
    const hostile = classifyAgentFailure(
      1,
      out("DENIED: sk-live-SECRET/https://evil.test?q=token"),
    );
    expect(hostile.kind).toBe("egress_denied");
    expect(JSON.stringify(hostile)).not.toMatch(/SECRET|evil|token/);
  });

  it("returns only fixed labels, never the agent's text", () => {
    const text = "sk-ant-secret-value prompt text 401";
    const result = classifyAgentFailure(1, out(text, text));
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("prompt");
  });
});
