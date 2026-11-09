import { afterEach, describe, expect, it, vi } from "vitest";
import { build, input } from "./testing/machine-harness";

/** The JSON diagnostic lines the machine printed with this event name. */
function logged(spy: { mock: { calls: unknown[][] } }, event: string) {
  return spy.mock.calls
    .map((c: unknown[]) => String(c[0]))
    .filter((l: string) => l.startsWith("{"))
    .map((l: string) => JSON.parse(l) as Record<string, unknown>)
    .filter((l: Record<string, unknown>) => l.event === event);
}

describe("agent failure diagnostics", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs the failure kind of an implementer that exits non-zero, never its output", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { w, machine, drain } = build({
      task: () => ({ state: "finished", exitCode: 1 }),
      failureOutput: () => ({
        stderr: "prompt text sk-secret\n400 DENIED: tool_type_not_allowed\n",
        stdout: "",
      }),
    });
    await machine.start(input);
    await drain();
    expect(w.events.some((e) => e.code === "agent_failed")).toBe(true);
    const lines = logged(log, "agent_exit_failed");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      phase: "implement",
      exitCode: 1,
      kind: "egress_denied",
      detail: "tool_type_not_allowed",
    });
    const all = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(all).not.toContain("sk-secret");
    expect(all).not.toContain("prompt text");
  });

  it("logs the reviewer's failure kind too", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { machine, drain } = build({
      reviewTask: () => ({ state: "finished", exitCode: 127 }),
      reviewFailureOutput: () => ({ stderr: "pi: not found", stdout: "" }),
    });
    await machine.start(input);
    await drain();
    expect(logged(log, "agent_exit_failed")).toEqual([
      expect.objectContaining({
        phase: "review",
        exitCode: 127,
        kind: "command_not_found",
      }),
    ]);
  });

  it("still fails with agent_failed when the output cannot be read", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { w, machine, drain } = build({
      task: () => ({ state: "finished", exitCode: 1 }),
      failureOutput: () => {
        throw new Error("container gone");
      },
    });
    await machine.start(input);
    await drain();
    expect(w.events.some((e) => e.code === "agent_failed")).toBe(true);
    expect(logged(log, "agent_exit_failed")[0]).toMatchObject({
      kind: "output_unreadable",
    });
  });
});
