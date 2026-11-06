import { describe, expect, it } from "vitest";
import { ActiveRunConflict, D1RunRepo } from "./d1-repo";
import { EVENT_KINDS, REASON_CODES, STATES } from "./run-types";
import { createTestD1, readMigrations } from "./testing/d1";

function setup() {
  const t = createTestD1(readMigrations());
  return { ...t, repo: new D1RunRepo(t.d1 as never) };
}

describe("migrations and D1RunRepo", () => {
  it("records a run and its transitions as events", async () => {
    const { repo, query } = setup();
    await repo.createRun(
      {
        id: "r1",
        repo: "acme/demo",
        issueNumber: 7,
        ts: 1000,
      },
      99,
    );
    await repo.transition({
      runId: "r1",
      from: "queued",
      to: "cloning",
      code: null,
      ts: 1001,
    });
    await repo.transition({
      runId: "r1",
      from: "cloning",
      to: "failed",
      code: "clone_failed",
      ts: 1002,
    });
    expect(query("SELECT state, reason_code FROM runs")).toEqual([
      { state: "failed", reason_code: "clone_failed" },
    ]);
    expect(
      query(
        "SELECT kind, from_state, to_state, reason_code FROM events ORDER BY id",
      ),
    ).toEqual([
      {
        kind: "created",
        from_state: null,
        to_state: "queued",
        reason_code: null,
      },
      {
        kind: "transition",
        from_state: "queued",
        to_state: "cloning",
        reason_code: null,
      },
      {
        kind: "transition",
        from_state: "cloning",
        to_state: "failed",
        reason_code: "clone_failed",
      },
    ]);
  });

  it("stores the PR number on pr_opened", async () => {
    const { repo, query } = setup();
    await repo.createRun(
      {
        id: "r1",
        repo: "acme/demo",
        issueNumber: 7,
        ts: 1,
      },
      99,
    );
    await repo.transition({
      runId: "r1",
      from: "publishing",
      to: "pr_opened",
      code: null,
      ts: 2,
      prNumber: 12,
    });
    expect(query("SELECT state, pr_number FROM runs")).toEqual([
      { state: "pr_opened", pr_number: 12 },
    ]);
  });

  it("allows only one active run per issue, but a new run after a terminal one", async () => {
    const { repo } = setup();
    await repo.createRun(
      {
        id: "r1",
        repo: "acme/demo",
        issueNumber: 7,
        ts: 1,
      },
      99,
    );
    await expect(
      repo.createRun(
        { id: "r2", repo: "acme/demo", issueNumber: 7, ts: 2 },
        99,
      ),
    ).rejects.toThrow();
    await repo.createRun(
      {
        id: "r3",
        repo: "acme/demo",
        issueNumber: 8,
        ts: 2,
      },
      99,
    );
    await repo.transition({
      runId: "r1",
      from: "queued",
      to: "failed",
      code: "timeout",
      ts: 3,
    });
    await repo.createRun(
      {
        id: "r4",
        repo: "acme/demo",
        issueNumber: 7,
        ts: 4,
      },
      99,
    );
  });

  it("keeps events append-only", async () => {
    const { repo, exec } = setup();
    await repo.createRun(
      {
        id: "r1",
        repo: "acme/demo",
        issueNumber: 7,
        ts: 1,
      },
      99,
    );
    expect(() => exec("UPDATE events SET reason_code = 'timeout'")).toThrow(
      /append-only/,
    );
    expect(() => exec("DELETE FROM events")).toThrow(/append-only/);
  });

  it("accepts every fixed code and kind, and rejects free text", async () => {
    const { repo, exec } = setup();
    await repo.createRun(
      {
        id: "r1",
        repo: "acme/demo",
        issueNumber: 7,
        ts: 1,
      },
      99,
    );
    for (const code of REASON_CODES) {
      exec(
        `INSERT INTO events (run_id, ts, kind, reason_code) VALUES ('r1', 1, 'transition', '${code}')`,
      );
    }
    for (const kind of EVENT_KINDS) {
      exec(`INSERT INTO events (run_id, ts, kind) VALUES ('r1', 1, '${kind}')`);
    }
    for (const state of STATES) {
      exec(`UPDATE runs SET state = '${state}'`);
    }
    expect(() =>
      exec(
        "INSERT INTO events (run_id, ts, kind, reason_code) VALUES ('r1', 1, 'transition', 'the agent said hello')",
      ),
    ).toThrow();
    expect(() =>
      exec(
        "INSERT INTO events (run_id, ts, kind) VALUES ('r1', 1, 'agent_output')",
      ),
    ).toThrow();
    expect(() => exec("UPDATE runs SET state = 'weird'")).toThrow();
  });

  it("claims a delivery id once and releases it", async () => {
    const { repo } = setup();
    expect(await repo.claimDelivery("d1", 1)).toBe(true);
    expect(await repo.claimDelivery("d1", 2)).toBe(false);
    await repo.releaseDelivery("d1");
    expect(await repo.claimDelivery("d1", 3)).toBe(true);
  });

  it("caps active runs globally and counts only non-terminal runs", async () => {
    const { repo } = setup();
    const mk = (id: string, issueNumber: number) =>
      repo.createRun({ id, repo: "acme/demo", issueNumber, ts: 1 }, 2);
    expect(await mk("a", 1)).toBe("created");
    expect(await mk("b", 2)).toBe("created");
    expect(await mk("c", 3)).toBe("capacity_full");
    await repo.transition({
      runId: "a",
      from: "queued",
      to: "failed",
      code: "timeout",
      ts: 2,
    });
    expect(await mk("c", 3)).toBe("created");
  });

  it("writes no event for a run refused for capacity", async () => {
    const { repo, query } = setup();
    await repo.createRun(
      { id: "a", repo: "acme/demo", issueNumber: 1, ts: 1 },
      1,
    );
    await repo.createRun(
      { id: "b", repo: "acme/demo", issueNumber: 2, ts: 1 },
      1,
    );
    expect(query("SELECT run_id FROM events")).toEqual([{ run_id: "a" }]);
  });

  it("finds the active run of an issue and throws ActiveRunConflict on a duplicate", async () => {
    const { repo } = setup();
    await repo.createRun(
      { id: "a", repo: "acme/demo", issueNumber: 1, ts: 5 },
      9,
    );
    expect(await repo.findActiveRun("acme/demo", 1)).toEqual({
      id: "a",
      createdAt: 5,
      state: "queued",
    });
    expect(await repo.findActiveRun("acme/demo", 2)).toBeNull();
    await expect(
      repo.createRun({ id: "z", repo: "acme/demo", issueNumber: 1, ts: 6 }, 9),
    ).rejects.toBeInstanceOf(ActiveRunConflict);
  });
});
