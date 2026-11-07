import { describe, expect, it, vi } from "vitest";
import { costUsd } from "./pricing";
import { bucketOf, getRun, listRuns } from "./run-query";
import { createTestD1, readMigrations } from "./testing/d1";

// Fake pricing with one known model.
vi.mock("./pricing", () => {
  return {
    costUsd: (
      model: string,
      u: { inputTokens: number; outputTokens: number },
    ) =>
      model === "gpt-5.4-nano"
        ? (u.inputTokens + 2 * u.outputTokens) / 1_000_000
        : null,
  };
});

const DAY = 86_400_000;
let n = 0;

function setup() {
  const t = createTestD1(readMigrations());
  const run = (
    id: string,
    repo: string,
    state: string,
    updatedAt: number,
    extra: { title?: string | null } = {},
  ) => {
    n += 1;
    t.exec(
      `INSERT INTO runs (id, repo, issue_number, state, created_at, updated_at, title)
       VALUES ('${id}', '${repo}', ${n}, '${state}', ${updatedAt}, ${updatedAt}, ${
         extra.title ? `'${extra.title}'` : "NULL"
       })`,
    );
  };
  const usage = (
    runId: string,
    phase: string,
    model: string,
    input: number,
    output = 0,
  ) =>
    t.exec(
      `INSERT INTO run_usage (run_id, phase, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, ts)
       VALUES ('${runId}', '${phase}', '${model}', ${input}, ${output}, 0, 0, 1)`,
    );
  return { ...t, db: t.d1 as never, run, usage };
}

describe("bucketOf", () => {
  it("awaiting_approval is attention", () => {
    expect(bucketOf("awaiting_approval", 0, 1000)).toBe("attention");
  });
  it("failed older than 7 days is done", () => {
    expect(bucketOf("failed", 0, 8 * DAY)).toBe("done");
  });
  it("reviewing is active", () => {
    expect(bucketOf("reviewing", 0, 1000)).toBe("active");
  });
  it("awaiting_approval and needs_human and failed attention within 7 days", () => {
    for (const s of ["awaiting_approval", "needs_human", "failed"]) {
      expect(bucketOf(s, 0, 7 * DAY)).toBe("attention");
      expect(bucketOf(s, 0, 7 * DAY + 1)).toBe("done");
    }
    expect(bucketOf("merged", 0, 1000)).toBe("done");
  });
});

describe("listRuns", () => {
  it("empty publicRepos gives zero totals", async () => {
    const { db } = setup();
    expect(await listRuns(db, { publicRepos: [], now: 1 })).toEqual({
      runs: [],
      totals: { attention: 0, active: 0, done: 0, usd: 0 },
    });
  });

  it("test_private_repo_absent", async () => {
    const { db, run, usage } = setup();
    run("pub", "a/b", "merged", 10);
    run("priv", "c/d", "awaiting_approval", 20);
    usage("priv", "implement", "gpt-5.4-nano", 1000);
    const r = await listRuns(db, { publicRepos: ["a/b"], now: 30 });
    expect(r.runs.map((x) => x.id)).toEqual(["pub"]);
    expect(r.totals).toEqual({ attention: 0, active: 0, done: 1, usd: 0 });
    expect(
      await getRun(db, "priv", { publicRepos: ["a/b"], now: 30 }),
    ).toBeNull();
    expect(
      await getRun(db, "run-in-private-repo", { publicRepos: ["a/b"], now: 1 }),
    ).toBeNull();
  });

  it("test_like_chars_not_matched", async () => {
    const { db, run } = setup();
    run("r1", "a/b", "merged", 10);
    run("r2", "a/%", "merged", 10);
    const r = await listRuns(db, { publicRepos: ["a/%"], now: 30 });
    expect(r.runs.map((x) => x.id)).toEqual(["r2"]);
    const r2 = await listRuns(db, { publicRepos: ["a/_"], now: 30 });
    expect(r2.runs).toEqual([]);
    expect(
      await getRun(db, "r1", { publicRepos: ["a/%"], now: 30 }),
    ).toBeNull();
  });

  it("test_unknown_model_not_zero", async () => {
    const { db, run, usage } = setup();
    run("r1", "a/b", "reviewing", 10);
    usage("r1", "implement", "mystery", 1000);
    const r = await listRuns(db, { publicRepos: ["a/b"], now: 30 });
    expect(r.runs[0]?.cost).toEqual({
      status: "unknown",
      totalUsd: null,
      implementUsd: null,
      reviewUsd: null,
    });
    expect(r.totals.usd).toBeNull();
  });

  it("attention sorted first then newest", async () => {
    const { db, run } = setup();
    run("old-active", "a/b", "implementing", 5);
    run("new-active", "a/b", "implementing", 50);
    run("old-attn", "a/b", "failed", 1);
    run("merged", "a/b", "merged", 100);
    const r = await listRuns(db, { publicRepos: ["a/b"], now: 200 });
    expect(r.runs.map((x) => x.id)).toEqual([
      "old-attn",
      "merged",
      "new-active",
      "old-active",
    ]);
    expect(r.totals).toMatchObject({ attention: 1, active: 2, done: 1 });
  });

  it("limit 100 newest", async () => {
    const { db, run } = setup();
    for (let i = 0; i < 105; i++) run(`r${i}`, "a/b", "merged", i);
    const r = await listRuns(db, { publicRepos: ["a/b"], now: 1000 });
    expect(r.runs).toHaveLength(100);
    expect(r.runs[0]?.id).toBe("r104");
    expect(r.runs.at(-1)?.id).toBe("r5");
  });

  it("no usage rows gives status not_measured", async () => {
    const { db, run } = setup();
    run("r1", "a/b", "merged", 1);
    const r = await listRuns(db, { publicRepos: ["a/b"], now: 2 });
    expect(r.runs[0]?.cost).toEqual({
      status: "not_measured",
      totalUsd: null,
      implementUsd: null,
      reviewUsd: null,
    });
    expect(r.totals.usd).toBe(0);
  });

  it("implement and review costs split by phase", async () => {
    const { db, run, usage } = setup();
    run("r1", "a/b", "merged", 1, { title: "Add footer" });
    usage("r1", "implement", "gpt-5.4-nano", 1_000_000);
    usage("r1", "repair", "gpt-5.4-nano", 1_000_000);
    usage("r1", "review", "gpt-5.4-nano", 0, 500_000);
    const r = await listRuns(db, { publicRepos: ["a/b"], now: 2 });
    expect(r.runs[0]?.title).toBe("Add footer");
    const u = (inputTokens: number, outputTokens: number) =>
      costUsd("gpt-5.4-nano", {
        inputTokens,
        outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }) as number;
    const impl = u(1_000_000, 0) * 2;
    const rev = u(0, 500_000);
    expect(r.runs[0]?.cost.status).toBe("measured");
    expect(r.runs[0]?.cost.implementUsd).toBeCloseTo(impl);
    expect(r.runs[0]?.cost.reviewUsd).toBeCloseTo(rev);
    expect(r.runs[0]?.cost.totalUsd).toBeCloseTo(impl + rev);
    expect(r.totals.usd).toBeCloseTo(impl + rev);
  });
});

describe("getRun", () => {
  it("events oldest first", async () => {
    const { db, run, exec } = setup();
    run("r1", "a/b", "failed", 3);
    exec(
      `INSERT INTO events (run_id, ts, kind, from_state, to_state, reason_code) VALUES
       ('r1', 1, 'created', NULL, 'queued', NULL),
       ('r1', 2, 'transition', 'queued', 'cloning', NULL),
       ('r1', 3, 'transition', 'cloning', 'failed', 'clone_failed')`,
    );
    const d = await getRun(db, "r1", { publicRepos: ["a/b"], now: 4 });
    expect(d?.events.map((e) => e.ts)).toEqual([1, 2, 3]);
    expect(d?.events[2]).toEqual({
      ts: 3,
      kind: "transition",
      fromState: "cloning",
      toState: "failed",
      reasonCode: "clone_failed",
    });
    expect(d?.bucket).toBe("attention");
  });
});
