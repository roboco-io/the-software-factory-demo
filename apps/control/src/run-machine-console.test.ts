import { describe, expect, it } from "vitest";
import type { RunRepo } from "./d1-repo";
import { build, input } from "./testing/machine-harness";

const SRC = [{ filename: "src/a.ts", status: "modified" }];

describe("RunMachine console facts", () => {
  it("createRun receives the title", async () => {
    const seen: unknown[] = [];
    const repo = {
      async createRun(r: unknown) {
        seen.push(r);
        return "created" as const;
      },
    } as unknown as RunRepo;
    const { machine } = build({ repo });
    await machine.start(input);
    expect(seen[0]).toMatchObject({ title: input.title });
  });

  it("headSha recorded at pr_opened", async () => {
    const { w, machine, drain, pulls } = build();
    await machine.start(input);
    await drain();
    expect(w.facts).toContainEqual({
      runId: "run1",
      headSha: pulls.pr.headSha,
    });
  });

  it("tier recorded after evaluate", async () => {
    const { w, machine, drain } = build();
    await machine.start(input);
    await drain();
    expect(w.facts).toContainEqual({ runId: "run1", tier: "T0" });
  });

  it("test_tier_written_once: repeated polling with the same tier makes one recordFacts call", async () => {
    const h = build({ pulls: { checks: [] } });
    await h.machine.start(input);
    for (let i = 0; i < 12; i++) await h.tick();
    expect(h.w.states.at(-1)).toBe("awaiting_checks");
    expect(h.w.facts.filter((f) => f.tier !== undefined)).toEqual([
      { runId: "run1", tier: "T0" },
    ]);
  });

  it("tier change recorded again", async () => {
    const h = build({ pulls: { checks: [] } });
    await h.machine.start(input);
    for (let i = 0; i < 12; i++) await h.tick();
    h.pulls.files = SRC;
    for (let i = 0; i < 3; i++) await h.tick();
    const tiers = h.w.facts.flatMap((f) => (f.tier ? [f.tier] : []));
    expect(tiers).toHaveLength(2);
    expect(tiers[0]).toBe("T0");
    expect(tiers[1]).not.toBe("T0");
  });

  it("recordFacts failure retries the step, it does not fail the run on the first error", async () => {
    let fail = true;
    const h = build();
    const orig = h.w.facts.push.bind(h.w.facts);
    h.w.facts.push = (...f) => {
      if (fail && f[0]!.tier !== undefined) {
        fail = false;
        throw new Error("d1 down");
      }
      return orig(...f);
    };
    await h.machine.start(input);
    await h.drain();
    expect(h.w.states).not.toContain("failed");
    expect(h.w.states.at(-1)).toBe("merged");
    expect(h.w.facts.filter((f) => f.tier !== undefined)).toHaveLength(1);
    expect(h.publish).toHaveBeenCalledTimes(1);
  });

  it("a headSha recordFacts failure retries the step and publishes once", async () => {
    let fail = true;
    const h = build();
    const orig = h.w.facts.push.bind(h.w.facts);
    h.w.facts.push = (...f) => {
      if (fail && f[0]!.headSha !== undefined) {
        fail = false;
        throw new Error("d1 down");
      }
      return orig(...f);
    };
    await h.machine.start(input);
    await h.drain();
    expect(h.w.states.at(-1)).toBe("merged");
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.w.facts.filter((f) => f.headSha !== undefined)).toHaveLength(1);
  });

  it("a run stored before 0006 gets its head_sha recorded while it waits", async () => {
    const h = build({ pulls: { checks: [] } });
    await h.machine.start(input);
    for (let i = 0; i < 12; i++) await h.tick();
    expect(h.w.states.at(-1)).toBe("awaiting_checks");
    const run = h.storedRun();
    delete run["recordedHeadSha"];
    delete run["recordedTier"];
    h.w.store.set("run", run);
    h.w.facts.length = 0;
    await h.tick();
    expect(h.w.facts).toContainEqual({
      runId: "run1",
      headSha: h.pulls.pr.headSha,
    });
  });
});
