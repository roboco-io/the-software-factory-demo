import { describe, expect, it } from "vitest";
import { D1RunRepo } from "./d1-repo";
import { createTestD1, readMigrations } from "./testing/d1";

function setup(migrations = readMigrations()) {
  const t = createTestD1(migrations);
  return { ...t, repo: new D1RunRepo(t.d1 as never) };
}
const run = { id: "r1", repo: "acme/demo", issueNumber: 7, ts: 1000 };
const usage = {
  runId: "r1",
  phase: "implement",
  model: "claude-sonnet-5-5",
  inputTokens: 10,
  outputTokens: 20,
  cacheReadTokens: 30,
  cacheWriteTokens: 40,
  ts: 1500,
};

describe("console schema and repo", () => {
  it("createRun stores title", async () => {
    const { repo, query } = setup();
    await repo.createRun({ ...run, title: "Add footer" }, 99);
    expect(query("SELECT title FROM runs")).toEqual([{ title: "Add footer" }]);
  });

  it("createRun without title stores NULL", async () => {
    const { repo, query } = setup();
    await repo.createRun(run, 99);
    expect(query("SELECT title FROM runs")).toEqual([{ title: null }]);
  });

  it("recordFacts changes no updated_at and adds no event", async () => {
    const { repo, query } = setup();
    await repo.createRun(run, 99);
    await repo.recordFacts({ runId: "r1", tier: "low", headSha: "abc" });
    expect(query("SELECT tier, head_sha, updated_at FROM runs")).toEqual([
      { tier: "low", head_sha: "abc", updated_at: 1000 },
    ]);
    expect(query("SELECT COUNT(*) AS n FROM events")).toEqual([{ n: 1 }]);
  });

  it("test_facts_keep_unset: only tier leaves head_sha", async () => {
    const { repo, query } = setup();
    await repo.createRun(run, 99);
    await repo.recordFacts({ runId: "r1", headSha: "abc" });
    await repo.recordFacts({ runId: "r1", tier: "high" });
    expect(query("SELECT tier, head_sha FROM runs")).toEqual([
      { tier: "high", head_sha: "abc" },
    ]);
  });

  it("recordUsage appends rows", async () => {
    const { repo, query } = setup();
    await repo.createRun(run, 99);
    await repo.recordUsage(usage);
    await repo.recordUsage({ ...usage, phase: "review", ts: 1600 });
    expect(
      query(
        "SELECT run_id, phase, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, ts FROM run_usage ORDER BY id",
      ),
    ).toEqual([
      {
        run_id: "r1",
        phase: "implement",
        model: "claude-sonnet-5-5",
        input_tokens: 10,
        output_tokens: 20,
        cache_read_tokens: 30,
        cache_write_tokens: 40,
        ts: 1500,
      },
      expect.objectContaining({ phase: "review", ts: 1600 }),
    ]);
  });

  it("test_usage_requires_run: unknown run id throws", async () => {
    const { repo } = setup();
    await expect(
      repo.recordUsage({ ...usage, runId: "nope" }),
    ).rejects.toThrow();
  });

  it("existing rows survive 0006", () => {
    const all = readMigrations();
    const { exec, query } = setup(all.slice(0, -1));
    exec(
      "INSERT INTO runs (id, repo, issue_number, state, created_at, updated_at) VALUES ('old', 'a/b', 1, 'queued', 1, 1)",
    );
    exec(all[all.length - 1] as string);
    expect(query("SELECT id, title, tier, head_sha FROM runs")).toEqual([
      { id: "old", title: null, tier: null, head_sha: null },
    ]);
  });
});
