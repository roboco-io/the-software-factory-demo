import { describe, expect, it } from "vitest";
import { D1RunRepo } from "./d1-repo";
import { REASON_CODES, STATES, type RunState } from "./run-types";
import { createTestD1, readMigrations } from "./testing/d1";

function setup() {
  const t = createTestD1(readMigrations());
  return { ...t, repo: new D1RunRepo(t.d1 as never) };
}
type Repo = D1RunRepo;
const create = (repo: Repo, id: string, issue: number, max = 99) =>
  repo.createRun({ id, repo: "acme/demo", issueNumber: issue, ts: 1 }, max);
const move = (repo: Repo, id: string, from: RunState, to: RunState) =>
  repo.transition({ runId: id, from, to, code: null, ts: 2 });

describe("stage 3 migration", () => {
  it("is a new file and keeps the applied ones", () => {
    const files = readMigrations();
    expect(files).toHaveLength(4);
    // The earlier migrations are untouched: the original state list has no stage 3 states.
    expect(files[0]).not.toContain("awaiting_approval");
  });

  it("upgrades existing rows: data and event ids stay, finished pr_opened runs become needs_human/legacy_run", async () => {
    const migrations = readMigrations();
    const t = createTestD1(migrations.slice(0, 2));
    t.exec(`
      INSERT INTO runs VALUES ('done', 'acme/demo', 1, 'pr_opened', NULL, 12, 10, 20);
      INSERT INTO runs VALUES ('bad', 'acme/demo', 2, 'failed', 'timeout', NULL, 10, 20);
      INSERT INTO runs VALUES ('live', 'acme/demo', 3, 'implementing', NULL, NULL, 10, 20);
      INSERT INTO events (run_id, ts, kind, from_state, to_state, reason_code) VALUES
        ('done', 10, 'created', NULL, 'queued', NULL),
        ('done', 20, 'transition', 'publishing', 'pr_opened', NULL),
        ('bad', 20, 'transition', 'cloning', 'failed', 'timeout');
    `);
    const before = t.query("SELECT id FROM events ORDER BY id");
    t.exec(migrations[2]!);
    expect(
      t.query("SELECT id, state, reason_code, pr_number FROM runs ORDER BY id"),
    ).toEqual([
      { id: "bad", state: "failed", reason_code: "timeout", pr_number: null },
      {
        id: "done",
        state: "needs_human",
        reason_code: "legacy_run",
        pr_number: 12,
      },
      { id: "live", state: "implementing", reason_code: null, pr_number: null },
    ]);
    expect(t.query("SELECT id FROM events ORDER BY id")).toEqual(before);
    expect(
      t.query("SELECT reason_code FROM events WHERE run_id = 'bad'"),
    ).toEqual([{ reason_code: "timeout" }]);
    // The finished run no longer counts as active; the live one still does.
    const repo = new D1RunRepo(t.d1 as never);
    expect(await repo.findActiveRun("acme/demo", 1)).toBeNull();
    expect((await repo.findActiveRun("acme/demo", 3))?.id).toBe("live");
    // New events still get fresh ids, and the triggers are back.
    await repo.transition({
      runId: "live",
      from: "implementing",
      to: "failed",
      code: "timeout",
      ts: 30,
    });
    expect(
      Number(
        (t.query("SELECT MAX(id) AS m FROM events")[0] as { m: number }).m,
      ),
    ).toBeGreaterThan(3);
    expect(() => t.exec("DELETE FROM events")).toThrow(/append-only/);
    expect(() => t.exec("UPDATE events SET ts = 1")).toThrow(/append-only/);
  });

  it("accepts every state and reason code, and still rejects free text", () => {
    const { exec } = setup();
    exec(
      "INSERT INTO runs (id, repo, issue_number, state, reason_code, pr_number, created_at, updated_at) VALUES ('r', 'acme/demo', 1, 'queued', NULL, NULL, 1, 1)",
    );
    for (const state of STATES) exec(`UPDATE runs SET state = '${state}'`);
    for (const code of REASON_CODES)
      exec(
        `INSERT INTO events (run_id, ts, kind, reason_code) VALUES ('r', 1, 'transition', '${code}')`,
      );
    expect(() => exec("UPDATE runs SET state = 'approved'")).toThrow();
    expect(() =>
      exec(
        "INSERT INTO events (run_id, ts, kind, reason_code) VALUES ('r', 1, 'transition', 'the reviewer said ok')",
      ),
    ).toThrow();
  });
});

describe("D1RunRepo for review and merge", () => {
  it("writes events for the new states like for any other transition, merged included", async () => {
    const { repo, query } = setup();
    await create(repo, "r1", 7);
    const path: RunState[] = [
      "cloning",
      "implementing",
      "publishing",
      "pr_opened",
      "reviewing",
      "awaiting_checks",
      "awaiting_approval",
      "merged",
    ];
    let from: RunState = "queued";
    for (const to of path) {
      await repo.transition({
        runId: "r1",
        from,
        to,
        code: null,
        ts: 5,
        ...(to === "pr_opened" ? { prNumber: 12 } : {}),
      });
      from = to;
    }
    expect(query("SELECT state, pr_number FROM runs")).toEqual([
      { state: "merged", pr_number: 12 },
    ]);
    const events = query(
      "SELECT kind, from_state, to_state, reason_code FROM events ORDER BY id",
    );
    expect(events.at(-1)).toEqual({
      kind: "transition",
      from_state: "awaiting_approval",
      to_state: "merged",
      reason_code: null,
    });
    expect(events).toHaveLength(1 + path.length);
  });

  it("records needs_human with a fixed code", async () => {
    const { repo, query } = setup();
    await create(repo, "r1", 7);
    await repo.transition({
      runId: "r1",
      from: "queued",
      to: "needs_human",
      code: "head_changed",
      ts: 5,
    });
    expect(query("SELECT state, reason_code FROM runs")).toEqual([
      { state: "needs_human", reason_code: "head_changed" },
    ]);
  });

  it("keeps one active run per issue until it is terminal", async () => {
    const { repo } = setup();
    await create(repo, "r1", 7);
    for (const state of [
      "reviewing",
      "awaiting_checks",
      "awaiting_approval",
    ] as RunState[]) {
      await move(repo, "r1", "queued", state);
      await expect(create(repo, "r2", 7)).rejects.toThrow();
      expect((await repo.findActiveRun("acme/demo", 7))?.state).toBe(state);
    }
    for (const [i, end] of (
      ["merged", "needs_human", "failed"] as RunState[]
    ).entries()) {
      await move(repo, `r${i + 1}`, "awaiting_approval", end);
      expect(await repo.findActiveRun("acme/demo", 7)).toBeNull();
      expect(await create(repo, `r${i + 2}`, 7)).toBe("created");
    }
  });

  it("capacity slot released when waiting for approval; reviewing and agent phases hold one", async () => {
    const { repo } = setup();
    const holders: RunState[] = [
      "queued",
      "cloning",
      "implementing",
      "publishing",
      "pr_opened",
      "reviewing",
      "awaiting_checks",
    ];
    for (const state of holders) {
      const t = setup();
      await create(t.repo, "a", 1, 1);
      await move(t.repo, "a", "queued", state);
      expect(await create(t.repo, "b", 2, 1), state).toBe("capacity_full");
    }
    await create(repo, "a", 1, 1);
    await move(repo, "a", "queued", "awaiting_approval");
    expect(await create(repo, "b", 2, 1)).toBe("created");
    // The waiting run is still active: its issue cannot start a second run.
    await expect(create(repo, "c", 1, 9)).rejects.toThrow();
    // Terminal runs never hold a slot.
    for (const end of ["merged", "needs_human", "failed"] as RunState[]) {
      const t = setup();
      await create(t.repo, "a", 1, 1);
      await move(t.repo, "a", "queued", end);
      expect(await create(t.repo, "b", 2, 1), end).toBe("created");
    }
  });
});
