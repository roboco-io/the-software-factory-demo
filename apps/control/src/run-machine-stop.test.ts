import { describe, expect, it } from "vitest";
import { D1RunRepo } from "./d1-repo";
import { RETRY_MS } from "./run-machine";
import { REASON_CODES } from "./run-types";
import { createTestD1, readMigrations } from "./testing/d1";
import { build, input } from "./testing/machine-harness";

const T2_FILES = [{ filename: "src/app.ts", status: "modified" }];
type H = ReturnType<typeof build>;

async function until(h: H, states: string[], max = 200): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (states.includes(h.w.states.at(-1) ?? "")) return;
    if (!(await h.tick())) return;
  }
}
const runId = (h: H) => String(h.storedRun()["id"]);
const lastTransition = (h: H) =>
  h.w.events.filter((e) => e.kind === "transition").at(-1);

describe("a stop is a request the alarm applies", () => {
  it("adds the reason code", () => {
    expect(REASON_CODES).toContain("stopped_by_operator");
  });

  it("writes no run state, no D1 event and no transition itself, and wakes the alarm", async () => {
    const h = build({ task: () => ({ state: "running", pid: 1 }) as never });
    await h.machine.start(input);
    await until(h, ["implementing"]);
    await h.tick();
    const events = h.w.events.length;
    const before = JSON.stringify(h.storedRun());
    h.w.alarm = h.w.now + 600_000;
    expect(await h.machine.stop(runId(h))).toBe("stop_requested");
    expect(h.w.events.length).toBe(events);
    expect(JSON.stringify(h.storedRun())).toBe(before);
    expect(h.w.alarm).toBe(h.w.now);
    expect(h.w.store.get("stop_requested")).toBe(runId(h));
  });

  it("applies at the next tick: failed before a pull request, with sandbox cleanup", async () => {
    const h = build({ task: () => ({ state: "running", pid: 1 }) as never });
    await h.machine.start(input);
    await until(h, ["implementing"]);
    await h.tick();
    await h.machine.stop(runId(h));
    await h.tick();
    expect(lastTransition(h)).toMatchObject({
      to: "failed",
      code: "stopped_by_operator",
    });
    expect(h.w.destroyed).toBeGreaterThan(0);
    expect(h.w.alarm).toBeNull();
  });

  it("applies at the next tick: needs_human after a pull request exists, and the merge never happens", async () => {
    const h = build({ pulls: { files: T2_FILES } });
    await h.machine.start(input);
    await until(h, ["awaiting_approval"]);
    await h.machine.stop(runId(h));
    h.pulls.reviews.push({
      user: { id: 3435720, type: "User" },
      state: "APPROVED",
      commit_id: h.pulls.pr.headSha,
    });
    await h.drain();
    expect(lastTransition(h)).toMatchObject({
      from: "awaiting_approval",
      to: "needs_human",
      code: "stopped_by_operator",
    });
    expect(h.pulls.merges).toEqual([]);
    expect(h.w.alarm).toBeNull();
  });

  it("wakes a run that is waiting on a long poll", async () => {
    const h = build({ pulls: { files: T2_FILES } });
    await h.machine.start(input);
    await until(h, ["awaiting_approval"]);
    await h.tick();
    expect(h.w.alarm! - h.w.now).toBeGreaterThanOrEqual(60_000);
    await h.machine.stop(runId(h));
    expect(h.w.alarm).toBe(h.w.now);
  });

  it("answers consistently when retried, and not_active once it took effect", async () => {
    const h = build({ pulls: { files: T2_FILES } });
    await h.machine.start(input);
    await until(h, ["awaiting_approval"]);
    const id = runId(h);
    expect(await h.machine.stop(id)).toBe("stop_requested");
    expect(await h.machine.stop(id)).toBe("stop_requested");
    await h.tick();
    expect(h.w.states.at(-1)).toBe("needs_human");
    expect(await h.machine.stop(id)).toBe("not_active");
    expect(await h.machine.stop(id)).toBe("not_active");
  });

  it("answers not_found for another run id and for no run", async () => {
    const h = build();
    expect(await h.machine.stop("x")).toBe("not_found");
    await h.machine.start(input);
    expect(await h.machine.stop("someotherrun")).toBe("not_found");
    expect(h.w.store.get("stop_requested") ?? null).toBeNull();
  });

  it("refuses when the merge was already attempted, and leaves no request behind", async () => {
    const h = build({ pulls: { files: T2_FILES } });
    await h.machine.start(input);
    await until(h, ["awaiting_approval"]);
    const run = h.storedRun();
    run["mergeAttempted"] = true;
    h.w.store.set("run", run);
    expect(await h.machine.stop(runId(h))).toBe("merge_attempted");
    expect(h.w.store.get("stop_requested") ?? null).toBeNull();
  });

  it("ignores a request that names another run", async () => {
    const h = build();
    await h.machine.start(input);
    h.w.store.set("stop_requested", "someotherrun");
    await h.drain();
    expect(h.w.states.at(-1)).toBe("merged");
  });
});

// The harness runs one await at a time. These tests fix the order of the steps that matter by
// hooks; they cannot show how a real Durable Object interleaves events or its input gates.
describe("ordering of a stop against steps already in flight (sequential harness)", () => {
  it("a stop during publish: the PR is recorded, the run ends needs_human, and no second PR is opened later", async () => {
    let stopped: string | undefined;
    const h: H = build({
      publish: async () => {
        stopped = await h.machine.stop(runId(h));
        return {
          prNumber: 40,
          prUrl: "https://github.com/acme/demo/pull/40",
        };
      },
    });
    await h.machine.start(input);
    await h.drain();
    expect(stopped).toBe("stop_requested");
    expect(h.w.prNumbers).toEqual([40]);
    expect(lastTransition(h)).toMatchObject({
      to: "needs_human",
      code: "stopped_by_operator",
    });
    expect(h.storedRun()["prNumber"]).toBe(40);
    const again = await h.machine.start({ ...input, deliveryId: "delivery-2" });
    expect(again.outcome).toBe("already_done");
    expect(h.publish).toHaveBeenCalledTimes(1);
  });

  it("a stop while the alarm waits in listChecks: no merge request is ever sent", async () => {
    let result: string | undefined;
    const h: H = build({
      beforeListChecks: async () => {
        result = await h.machine.stop(runId(h));
      },
    });
    await h.machine.start(input);
    await until(h, ["awaiting_checks"]);
    await h.drain();
    expect(result).toBe("stop_requested");
    expect(h.pulls.merges).toEqual([]);
    expect(lastTransition(h)).toMatchObject({
      to: "needs_human",
      code: "stopped_by_operator",
    });
  });

  it("a stop that arrives after mergeAttempted was written is refused and the run ends merged", async () => {
    let result: string | undefined;
    const h: H = build({
      duringMerge: async () => {
        result = await h.machine.stop(runId(h));
      },
    });
    await h.machine.start(input);
    await h.drain();
    expect(result).toBe("merge_attempted");
    expect(h.pulls.merges).toHaveLength(1);
    expect(h.w.states.at(-1)).toBe("merged");
    expect(h.pulls.pr.merged).toBe(true);
    expect(h.w.events.filter((e) => e.code === "stopped_by_operator")).toEqual(
      [],
    );
    expect(h.w.store.get("stop_requested") ?? null).toBeNull();
  });

  it("a stop during a slow D1 transition loses no flag and the final state matches GitHub", async () => {
    let stopped = false;
    const h: H = build({
      duringTransition: async (to) => {
        if (to === "awaiting_checks" && !stopped) {
          stopped = true;
          await h.machine.stop(runId(h));
        }
      },
    });
    await h.machine.start(input);
    await h.drain();
    expect(stopped).toBe(true);
    expect(h.pulls.merges).toEqual([]);
    expect(h.pulls.pr.merged).toBe(false);
    expect(h.w.states.at(-1)).toBe("needs_human");
    expect(lastTransition(h)).toMatchObject({ code: "stopped_by_operator" });
  });

  it("a stop during sandbox start or clone: the sandbox is destroyed", async () => {
    const h: H = build({
      task: () => ({ state: "running", pid: 1 }) as never,
      beforeSandboxStart: async () => {
        await h.machine.stop(runId(h));
      },
    });
    await h.machine.start(input);
    await h.drain();
    expect(h.w.sandboxCalls).toContain("clone");
    expect(h.w.destroyed).toBeGreaterThan(0);
    expect(lastTransition(h)).toMatchObject({
      to: "failed",
      code: "stopped_by_operator",
    });
  });

  it("an alarm that retries after an error still honors the stop", async () => {
    let calls = 0;
    const h = build({
      task: () => ({ state: "running", pid: 1 }) as never,
      clone: () => {
        if (calls++ === 0) throw new Error("transient");
        return { ok: true, baseSha: "a".repeat(40) };
      },
    });
    await h.machine.start(input);
    await until(h, ["cloning"]);
    await h.tick();
    await h.machine.stop(runId(h));
    expect(h.w.alarm).toBe(h.w.now);
    await h.tick();
    expect(lastTransition(h)).toMatchObject({ code: "stopped_by_operator" });
  });
});

describe("start() and the request key", () => {
  it("start() of a second run clears a key left by the first", async () => {
    const h = build({ task: () => ({ state: "running", pid: 1 }) as never });
    await h.machine.start(input);
    await until(h, ["implementing"]);
    await h.machine.stop(runId(h));
    await h.tick();
    expect(h.w.states.at(-1)).toBe("failed");
    expect(h.w.store.get("stop_requested")).toBe("run1");
    h.w.store.set("stop_requested", "run1");
    const second = await h.machine.start({
      ...input,
      deliveryId: "delivery-2",
    });
    expect(second.outcome).toBe("started");
    expect(h.w.store.get("stop_requested") ?? null).toBeNull();
  });
});

describe("a stop that loses to a merge, and a failing D1", () => {
  it("a flag that appears while the request is stored gives 409, clears the key, and a merge retry ends merged", async () => {
    let armed = false;
    let merges = 0;
    const h: H = build({
      afterPut: (key) => {
        if (armed && key === "stop_requested") {
          armed = false;
          // The alarm wrote mergeAttempted between stop()'s two reads.
          const run = h.w.store.get("run") as Record<string, unknown>;
          run["mergeAttempted"] = true;
        }
      },
      duringMerge: async () => {
        if (merges++ === 0) throw new Error("github unavailable");
      },
    });
    await h.machine.start(input);
    await until(h, ["awaiting_checks"]);
    armed = true;
    expect(await h.machine.stop(runId(h))).toBe("merge_attempted");
    expect(h.w.store.get("stop_requested") ?? null).toBeNull();
    await h.drain();
    expect(merges).toBe(2);
    expect(h.w.states.at(-1)).toBe("merged");
    expect(h.w.events.filter((e) => e.code === "stopped_by_operator")).toEqual(
      [],
    );
  });

  it("a key left behind does not stop a merge retry", async () => {
    let merges = 0;
    const h: H = build({
      duringMerge: async () => {
        if (merges++ === 0) throw new Error("github unavailable");
      },
    });
    await h.machine.start(input);
    await until(h, ["awaiting_checks"]);
    await h.tick();
    expect(h.storedRun()["mergeAttempted"]).toBe(true);
    h.w.store.set("stop_requested", runId(h));
    await h.drain();
    expect(h.w.states.at(-1)).toBe("merged");
  });

  it("never spins on now while fail() keeps throwing, and ends correctly once D1 recovers", async () => {
    let down = true;
    const h: H = build({
      task: () => ({ state: "running", pid: 1 }) as never,
      duringTransition: async (to) => {
        if (down && to === "failed") throw new Error("d1 outage");
      },
    });
    await h.machine.start(input);
    await until(h, ["implementing"]);
    await h.tick();
    await h.machine.stop(runId(h));
    h.w.alarmSets.length = 0;
    for (let i = 0; i < 4; i++) {
      await expect(h.tick()).rejects.toThrow("d1 outage");
      expect(h.w.alarm).toBe(h.w.now + RETRY_MS);
    }
    expect(h.w.alarmSets.length).toBeGreaterThan(0);
    expect(h.w.alarmSets.some((delay) => delay <= 0)).toBe(false);
    down = false;
    await h.tick();
    expect(lastTransition(h)).toMatchObject({
      to: "failed",
      code: "stopped_by_operator",
    });
    expect(h.w.alarm).toBeNull();
  });
});

describe("after a stop before any pull request", () => {
  it("a new start() runs, and the old request does not touch the new run", async () => {
    const h = build({ task: () => ({ state: "running", pid: 1 }) as never });
    await h.machine.start(input);
    await until(h, ["implementing"]);
    const oldId = runId(h);
    await h.machine.stop(oldId);
    await h.tick();
    expect(h.w.states.at(-1)).toBe("failed");
    const again = await h.machine.start({ ...input, deliveryId: "delivery-2" });
    expect(again.outcome).toBe("started");
    expect(runId(h)).not.toBe(oldId);
    expect(h.w.store.get("stop_requested") ?? null).toBeNull();
    await h.tick();
    await h.tick();
    expect(h.w.states.at(-1)).toBe("implementing");
  });

  it("is recorded in D1 with the real SQL and the migration's CHECK constraint", async () => {
    const t = createTestD1(readMigrations());
    const h = build({
      repo: new D1RunRepo(t.d1 as never),
      pulls: { files: T2_FILES },
    });
    await h.machine.start(input);
    await until(h, ["awaiting_approval"]);
    const id = runId(h);
    expect(await h.machine.stop(id)).toBe("stop_requested");
    await h.tick();
    expect(
      t.query("SELECT state, reason_code FROM runs WHERE id = ?", id),
    ).toEqual([{ state: "needs_human", reason_code: "stopped_by_operator" }]);
  });
});
