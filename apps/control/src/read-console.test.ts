import { describe, expect, it } from "vitest";
import { handleRequest } from "./app";
import { D1ReadRepo } from "./read-repo";
import { makeWorld, req, type World } from "./testing/api-world";

const NOW = Date.parse("2026-11-07T00:00:00Z");
const DAY = 86_400_000;

const run = (
  w: World,
  id: string,
  state = "merged",
  extra: { repo?: string; updated?: number; created?: number; n?: number } = {},
) =>
  w.exec(
    `INSERT INTO runs (id, repo, issue_number, state, reason_code, pr_number, created_at, updated_at) VALUES ('${id}', '${extra.repo ?? "acme/demo"}', ${extra.n ?? Math.floor(Math.random() * 1e6)}, '${state}', NULL, NULL, ${extra.created ?? 1}, ${extra.updated ?? NOW})`,
  );
const usage = (
  w: World,
  id: string,
  phase: string,
  model: string,
  input: number,
  output = 0,
) =>
  w.exec(
    `INSERT INTO run_usage (run_id, phase, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, ts) VALUES ('${id}', '${phase}', '${model}', ${input}, ${output}, 0, 0, 1)`,
  );
const getJson = async (w: World, path: string) => {
  const res = await handleRequest(req(path), w.env);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await res.json()) as Record<string, any>;
};
const MILLION = 1_000_000;

describe("console read fields", () => {
  it("run view has title tier headSha cost", async () => {
    const w = makeWorld();
    run(w, "r1");
    w.exec(
      "UPDATE runs SET title='Fix <b>x</b>', tier='T3', head_sha='abc' WHERE id='r1'",
    );
    const body = await getJson(w, "/api/runs/r1");
    expect(body["run"]).toMatchObject({
      id: "r1",
      title: "Fix <b>x</b>",
      tier: "T3",
      headSha: "abc",
      cost: {
        status: "not_measured",
        totalUsd: null,
        implementUsd: null,
        reviewUsd: null,
      },
    });
  });

  it("implement and review split by phase", async () => {
    const w = makeWorld();
    run(w, "r1");
    usage(w, "r1", "implement", "claude-sonnet-5-5", MILLION); // 2
    usage(w, "r1", "clone", "claude-sonnet-5-5", MILLION); // 2, counts as implement
    usage(w, "r1", "review", "gpt-5.4-nano", MILLION, MILLION); // 1.45
    const cost = (await getJson(w, "/api/runs/r1"))["run"].cost;
    expect(cost.status).toBe("measured");
    expect(cost.implementUsd).toBeCloseTo(4);
    expect(cost.reviewUsd).toBeCloseTo(1.45);
    expect(cost.totalUsd).toBeCloseTo(5.45);
  });

  it("test_unknown_model_not_zero: an unpriced model gives unknown and null", async () => {
    const w = makeWorld();
    run(w, "r1");
    usage(w, "r1", "implement", "claude-sonnet-5-5", MILLION);
    usage(w, "r1", "review", "mystery-model", 5);
    const cost = (await getJson(w, "/api/runs/r1"))["run"].cost;
    expect(cost).toEqual({
      status: "unknown",
      totalUsd: null,
      implementUsd: null,
      reviewUsd: null,
    });
    const p = (await getJson(w, "/api/projects"))["projects"][0];
    expect(p.costUsd).toBeNull();
  });

  it("project has attention and costUsd", async () => {
    const w = makeWorld();
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      run(w, "a1", "awaiting_approval", { updated: NOW - 30 * DAY, n: 1 });
      run(w, "a2", "needs_human", { updated: NOW - 6 * DAY, n: 2 });
      run(w, "a3", "failed", { updated: NOW - 1 * DAY, n: 3 });
      run(w, "a4", "merged", { n: 4 });
      usage(w, "a4", "implement", "claude-sonnet-5-5", MILLION);
      usage(w, "a3", "review", "claude-sonnet-5-5", MILLION);
      const p = (await getJson(w, "/api/projects"))["projects"][0];
      expect(p.attention).toBe(3);
      expect(p.costUsd).toBeCloseTo(4);
    } finally {
      Date.now = realNow;
    }
  });

  it("test_attention_window: needs_human older than 7 days is not attention", async () => {
    const w = makeWorld();
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      run(w, "a1", "needs_human", { updated: NOW - 8 * DAY, n: 1 });
      run(w, "a2", "failed", { updated: NOW - 8 * DAY, n: 2 });
      const p = (await getJson(w, "/api/projects"))["projects"][0];
      expect(p.attention).toBe(0);
      expect(p.counts.needs_human).toBe(1);
    } finally {
      Date.now = realNow;
    }
  });

  it("existing count fields unchanged", async () => {
    const w = makeWorld();
    run(w, "a1", "failed", { n: 1 });
    run(w, "a2", "queued", { n: 2 });
    const p = (await getJson(w, "/api/projects"))["projects"][0];
    expect(p.counts).toEqual({
      active: 1,
      merged: 0,
      needs_human: 0,
      failed: 1,
    });
  });

  it("test_repo_outside_projects_absent", async () => {
    const w = makeWorld();
    run(w, "x1", "awaiting_approval", { repo: "gone/repo", n: 1 });
    usage(w, "x1", "implement", "mystery-model", 1);
    const body = await getJson(w, "/api/projects");
    expect(JSON.stringify(body)).not.toContain("gone/repo");
    expect(
      body["projects"].every((p: { attention: number }) => p.attention === 0),
    ).toBe(true);
    expect(
      (await handleRequest(req("/api/projects/gone/repo/runs"), w.env)).status,
    ).toBe(404);
  });

  it("a page of 51 runs costs without one query per run and within the bind limit", async () => {
    const w = makeWorld();
    for (let i = 1; i <= 51; i++) {
      run(w, `p${String(i).padStart(3, "0")}`, "merged", { created: i, n: i });
      usage(
        w,
        `p${String(i).padStart(3, "0")}`,
        "implement",
        "claude-sonnet-5-5",
        MILLION,
      );
    }
    let queries = 0;
    let maxBinds = 0;
    const db = {
      prepare: (sql: string) => {
        queries++;
        const stmt = w.env.DB!.prepare(sql);
        return {
          bind: (...v: unknown[]) => {
            maxBinds = Math.max(maxBinds, v.length);
            return stmt.bind(...v);
          },
        };
      },
    };
    const rows = await new D1ReadRepo(db as never).listRuns(
      "acme/demo",
      50,
      null,
    );
    expect(rows).toHaveLength(51);
    expect(rows[0]!.cost.totalUsd).toBeCloseTo(2);
    expect(queries).toBeLessThanOrEqual(3);
    expect(maxBinds).toBeLessThanOrEqual(100);
  });
});
