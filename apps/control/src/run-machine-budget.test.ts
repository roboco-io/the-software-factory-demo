import { describe, expect, it } from "vitest";
import {
  ENGINE_POLL_MS,
  ENGINE_WAIT_TIMEOUT_MS,
  REVIEW_TIMEOUT_MS,
} from "./run-machine";
import { build, fakeBudget, input } from "./testing/machine-harness";

const T2_FILES = [{ filename: "src/app.ts", status: "modified" }];

describe("stage 5: engine switching by budget (fake usage)", () => {
  it("implements with Claude and reviews with OpenAI while both accounts have room", async () => {
    const budget = fakeBudget();
    const { w, machine, drain, pulls } = build({ budget });
    await machine.start(input);
    await drain();
    expect(w.createdModels).toEqual(["claude-sonnet-5-5"]);
    expect(w.agentModels).toEqual(["claude-sonnet-5-5"]);
    expect(w.reviewModels).toEqual(["gpt-5.4-nano"]);
    expect(w.facts).toContainEqual(
      expect.objectContaining({
        reviewModel: "gpt-5.4-nano",
        singleEngine: false,
      }),
    );
    expect(pulls.posted[0]!.body).not.toContain("Single-engine");
    expect(w.states.at(-1)).toBe("merged");
  });

  it("switches the implementer to Codex when Anthropic reached its limit", async () => {
    const budget = fakeBudget();
    budget.spent.anthropic = 45.01;
    const { w, machine, drain } = build({ budget });
    await machine.start(input);
    await drain();
    expect(w.createdModels).toEqual(["gpt-6.1-terra"]);
    expect(w.agentModels).toEqual(["gpt-6.1-terra"]);
  });

  it("with only OpenAI left, a fresh gpt-5.4-nano session reviews T0 and says so", async () => {
    const budget = fakeBudget();
    budget.spent.anthropic = 50;
    const { w, machine, drain, pulls } = build({ budget });
    await machine.start(input);
    await drain();
    expect(w.reviewModels).toEqual(["gpt-5.4-nano"]);
    expect(w.facts).toContainEqual(
      expect.objectContaining({
        reviewModel: "gpt-5.4-nano",
        singleEngine: true,
      }),
    );
    expect(pulls.posted[0]!.body).toContain("Single-engine review");
    expect(w.states.at(-1)).toBe("merged");
  });

  it("with only Anthropic left, Claude implements and claude-haiku-5-5 reviews T0", async () => {
    const budget = fakeBudget();
    budget.spent.openai = 50;
    const { w, machine, drain } = build({ budget });
    await machine.start(input);
    await drain();
    expect(w.agentModels).toEqual(["claude-sonnet-5-5"]);
    expect(w.reviewModels).toEqual(["claude-haiku-5-5"]);
    expect(w.states.at(-1)).toBe("merged");
  });

  it("a review that starts after the other engine came back is a normal cross review", async () => {
    const budget = fakeBudget();
    budget.spent.anthropic = 50;
    const { w, machine, drain, tick } = build({ budget });
    await machine.start(input);
    // queued -> cloning -> implementing -> publishing -> pr_opened
    for (let i = 0; i < 4; i++) await tick();
    budget.spent.anthropic = 0;
    await drain();
    expect(w.agentModels).toEqual(["gpt-6.1-terra"]);
    expect(w.reviewModels).toEqual(["claude-haiku-5-5"]);
  });
});

describe("stage 5: both accounts at their limit", () => {
  it("starts no run, registers the period's issue and returns budget_exhausted", async () => {
    const budget = fakeBudget();
    budget.spent = { anthropic: 50, openai: 46 };
    const { w, machine } = build({ budget });
    expect(await machine.start(input)).toEqual({ outcome: "budget_exhausted" });
    expect(budget.notices).toEqual(["2026-11"]);
    expect(w.createdModels).toEqual([]);
    expect(w.alarm).toBeNull();
  });

  it("returns budget_reserved, without the issue, when only active runs hold the budget", async () => {
    const budget = fakeBudget();
    budget.spent = { anthropic: 50, openai: 40 };
    budget.reserved = { anthropic: 0, openai: 10 };
    const { machine } = build({ budget });
    expect(await machine.start(input)).toEqual({ outcome: "budget_reserved" });
    expect(budget.notices).toEqual([]);
  });
});

describe("stage 5: T2 and T3 wait for the other engine", () => {
  it("parks a T2 pull request in awaiting_engine with no sandbox and resumes when budget returns", async () => {
    const budget = fakeBudget();
    budget.spent.anthropic = 50;
    const { w, machine, drain, tick, storedRun } = build({
      budget,
      pulls: { files: T2_FILES },
    });
    await machine.start(input);
    for (let i = 0; i < 8 && storedRun().state !== "awaiting_engine"; i++)
      await tick();
    expect(storedRun().state).toBe("awaiting_engine");
    expect(w.reviewCalls).toEqual([]);
    expect(storedRun().live).toEqual([]);
    expect(w.alarm! - w.now).toBe(ENGINE_POLL_MS);
    // Still one engine an hour later: keep waiting, past the usual review time limit.
    w.now += REVIEW_TIMEOUT_MS;
    await tick();
    expect(storedRun().state).toBe("awaiting_engine");
    // The next billing period starts.
    budget.spent.anthropic = 0;
    await drain();
    expect(w.states).toEqual(
      expect.arrayContaining([
        "awaiting_engine",
        "reviewing",
        "awaiting_checks",
      ]),
    );
    expect(w.reviewModels).toEqual(["claude-haiku-5-5"]);
    expect(w.events.some((e) => e.code === "timeout")).toBe(false);
  });

  it("waits for any tier when no engine has room, and registers the issue", async () => {
    const budget = fakeBudget();
    const { machine, tick, storedRun } = build({ budget });
    await machine.start(input);
    for (let i = 0; i < 4; i++) await tick();
    budget.spent = { anthropic: 50, openai: 50 };
    await tick();
    await tick();
    expect(storedRun().state).toBe("awaiting_engine");
    expect(budget.notices).toEqual(["2026-11"]);
  });

  it("hands the pull request to a person after the longest wait", async () => {
    const budget = fakeBudget();
    budget.spent.anthropic = 50;
    const { w, machine, tick, storedRun } = build({
      budget,
      pulls: { files: T2_FILES },
    });
    await machine.start(input);
    for (let i = 0; i < 8 && storedRun().state !== "awaiting_engine"; i++)
      await tick();
    w.now += ENGINE_WAIT_TIMEOUT_MS + 1;
    await tick();
    expect(w.states.at(-1)).toBe("needs_human");
    expect(w.events.at(-1)?.code).toBe("engine_wait_timeout");
  });

  it("an operator can stop a waiting run", async () => {
    const budget = fakeBudget();
    budget.spent.anthropic = 50;
    const { w, machine, tick, drain, storedRun } = build({
      budget,
      pulls: { files: T2_FILES },
    });
    await machine.start(input);
    for (let i = 0; i < 8 && storedRun().state !== "awaiting_engine"; i++)
      await tick();
    expect(await machine.stop(storedRun().id as string)).toBe("stop_requested");
    await drain();
    expect(w.states.at(-1)).toBe("needs_human");
    expect(w.events.some((e) => e.code === "stopped_by_operator")).toBe(true);
  });
});

describe("stage 5: a run that hit its spending limit", () => {
  it("fails with budget_exceeded when the implementer stopped at the cap", async () => {
    const budget = fakeBudget();
    budget.overrunRuns.add("run1");
    const { w, machine, drain } = build({
      budget,
      task: () => ({ state: "finished", exitCode: 1 }),
    });
    await machine.start(input);
    await drain();
    expect(w.states.at(-1)).toBe("failed");
    expect(w.events.some((e) => e.code === "budget_exceeded")).toBe(true);
  });

  it("keeps agent_failed when the budget was not the cause", async () => {
    const { w, machine, drain } = build({
      task: () => ({ state: "finished", exitCode: 1 }),
    });
    await machine.start(input);
    await drain();
    expect(w.events.some((e) => e.code === "agent_failed")).toBe(true);
  });

  it("hands the pull request to a person with budget_exceeded when the reviewer stopped at the cap", async () => {
    const budget = fakeBudget();
    budget.overrunRuns.add("run1");
    const { w, machine, drain } = build({
      budget,
      reviewTask: () => ({ state: "finished", exitCode: 1 }),
    });
    await machine.start(input);
    await drain();
    expect(w.states.at(-1)).toBe("needs_human");
    expect(w.events.some((e) => e.code === "budget_exceeded")).toBe(true);
  });
});
