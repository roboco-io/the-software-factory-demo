import { describe, expect, it } from "vitest";
import {
  AssignmentError,
  assignEngines,
  estimateCostUsd,
  loadAgentsConfig,
  parseAgentsConfig,
  pickReviewer,
  resolveModel,
} from "../src/config/agents";

const cfg = loadAgentsConfig();

describe("factory/agents.yml budgets (spec 5.3)", () => {
  it("matches the spec table exactly", () => {
    const a = assignEngines(cfg, []);
    expect(a.triage).toEqual({
      engine: "pi",
      budget: { maxTurns: 25, timeoutMs: 300_000, maxUsd: 0.2 },
    });
    expect(a.implement).toEqual({
      engine: "claude",
      budget: { maxTurns: 80, timeoutMs: 1_800_000, maxUsd: 5 },
    });
    expect(a.fix).toEqual({
      engine: "claude",
      budget: { maxTurns: 40, timeoutMs: 1_200_000, maxUsd: 3 },
    });
    expect(a.review).toEqual({
      engine: "codex",
      budget: { maxTurns: 30, timeoutMs: 900_000, maxUsd: 2 },
    });
    expect(cfg.roles.improve.budget).toEqual({ maxTurns: 60, timeoutMin: 30, maxUsd: 5 });
  });

  it("assigns the postmortem role to claude with a 2 USD budget", () => {
    expect(cfg.roles.postmortem.engine).toBe("claude");
    expect(cfg.roles.postmortem.budget.maxUsd).toBe(2);
    expect(cfg.roles.postmortem.budget.timeoutMin).toBe(15);
  });
});

describe("assignEngines cross-review rule", () => {
  it("switches implement and fix to the agent:<engine> label", () => {
    const a = assignEngines(cfg, ["agent:pi"]);
    expect(a.implement.engine).toBe("pi");
    expect(a.fix.engine).toBe("pi");
    expect(a.review.engine).toBe("codex");
  });

  it("picks the first different engine from fallbackOrder when review would equal implement", () => {
    const a = assignEngines(cfg, ["agent:codex"]);
    expect(a.implement.engine).toBe("codex");
    expect(a.review.engine).toBe("claude");
    expect(pickReviewer(cfg, "codex")).toBe("claude");
  });

  it("throws when no review engine differs from the implement engine", () => {
    const narrow = parseAgentsConfig(
      `
engines:
  claude: { modelEnv: CLAUDE_MODEL, defaultModel: m, pricePerMTok: null }
  codex: { modelEnv: CODEX_MODEL, defaultModel: null, pricePerMTok: null }
  pi: { modelEnv: PI_MODEL, defaultModel: p, pricePerMTok: null }
roles:
  triage: { engine: pi, budget: { maxTurns: 1, timeoutMin: 1 } }
  implement: { engine: codex, budget: { maxTurns: 1, timeoutMin: 1 } }
  fix: { engine: same-as-implement, budget: { maxTurns: 1, timeoutMin: 1 } }
  review: { engine: codex, fallbackOrder: [codex], budget: { maxTurns: 1, timeoutMin: 1 } }
  improve: { engine: claude, budget: { maxTurns: 1, timeoutMin: 1 } }
  postmortem: { engine: claude, budget: { maxTurns: 1, timeoutMin: 1 } }
`,
    );
    expect(() => assignEngines(narrow, [])).toThrow(AssignmentError);
  });

  it("rejects ambiguous agent labels and ignores unknown engines", () => {
    expect(() => assignEngines(cfg, ["agent:claude", "agent:codex"])).toThrow(AssignmentError);
    expect(assignEngines(cfg, ["agent:gemini"]).implement.engine).toBe("claude");
  });
});

describe("resolveModel", () => {
  it("prefers the environment variable, then the default", () => {
    expect(resolveModel(cfg, "claude", {})).toBe("claude-sonnet-5-5");
    expect(resolveModel(cfg, "claude", { CLAUDE_MODEL: " claude-opus-5 " })).toBe("claude-opus-5");
    expect(resolveModel(cfg, "pi", {})).toBe("deepseek/deepseek-flash");
    expect(resolveModel(cfg, "codex", { CODEX_MODEL: "gpt-6.1-sol" })).toBe("gpt-6.1-sol");
  });

  it("requires CODEX_MODEL because codex has no default model", () => {
    expect(() => resolveModel(cfg, "codex", {})).toThrow(/CODEX_MODEL/);
  });
});

describe("estimateCostUsd", () => {
  it("returns undefined without a price and computes per million tokens otherwise", () => {
    expect(estimateCostUsd(null, { inputTokens: 10, outputTokens: 10 })).toBeUndefined();
    expect(
      estimateCostUsd({ input: 2, output: 8 }, { inputTokens: 500_000, outputTokens: 250_000 }),
    ).toBe(3);
  });
});
