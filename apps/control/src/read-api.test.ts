import { describe, expect, it } from "vitest";
import { handleRequest } from "./app";
import { REASON_CODES, STATES } from "./run-types";
import { D1ReadRepo } from "./read-repo";
import { makeWorld, observerCookie, req, seedRuns } from "./testing/api-world";

const get = async (
  w: ReturnType<typeof makeWorld>,
  path: string,
  cookie?: string,
) => {
  const res = await handleRequest(req(path, cookie ? { cookie } : {}), w.env);
  // Test helper: the shape is asserted by each test.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { res, body: (await res.json()) as Record<string, any> };
};

describe("GET /api/me", () => {
  it("reports anonymous, observer and operator with the exact allowlisted fields", async () => {
    const w = makeWorld();
    expect((await get(w, "/api/me")).body).toEqual({ role: "anonymous" });
    expect((await get(w, "/api/me", await observerCookie())).body).toEqual({
      role: "observer",
      login: "visitor",
    });
    w.env.OPERATOR_IDS = "555";
    expect((await get(w, "/api/me", await observerCookie())).body).toEqual({
      role: "operator",
      login: "visitor",
    });
  });
});

describe("GET /api/projects", () => {
  it("lists the PROJECTS with run counts by outcome and ignores other repositories", async () => {
    const w = makeWorld();
    seedRuns(w);
    const { res, body } = await get(w, "/api/projects");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      projects: [
        {
          repo: "acme/demo",
          counts: { active: 1, merged: 1, needs_human: 0, failed: 1 },
        },
        {
          repo: "acme/other",
          counts: { active: 0, merged: 0, needs_human: 1, failed: 0 },
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("gone/repo");
  });

  it("lists projects with zero counts when there are no runs, and nothing when PROJECTS is empty", async () => {
    const w = makeWorld();
    expect((await get(w, "/api/projects")).body.projects[0].counts).toEqual({
      active: 0,
      merged: 0,
      needs_human: 0,
      failed: 0,
    });
    w.env.PROJECTS = "";
    expect((await get(w, "/api/projects")).body).toEqual({ projects: [] });
  });
});

describe("GET /api/projects/:owner/:repo/runs", () => {
  it("returns runs newest first with an explicit field allowlist", async () => {
    const w = makeWorld();
    seedRuns(w);
    const { res, body } = await get(w, "/api/projects/acme/demo/runs");
    expect(res.status).toBe(200);
    expect(body.runs.map((r: { id: string }) => r.id)).toEqual([
      "aaaaaaaaaaa3",
      "aaaaaaaaaaa2",
      "aaaaaaaaaaa1",
    ]);
    expect(body.nextCursor).toBeNull();
    expect(body.runs[0]).toEqual({
      id: "aaaaaaaaaaa3",
      repo: "acme/demo",
      issueNumber: 9,
      state: "failed",
      reasonCode: "agent_failed",
      prNumber: null,
      createdAt: 3000,
      updatedAt: 7000,
    });
  });

  it("answers 404 for a repository that is not in PROJECTS, even if it has runs", async () => {
    const w = makeWorld();
    seedRuns(w);
    expect((await get(w, "/api/projects/gone/repo/runs")).res.status).toBe(404);
    expect((await get(w, "/api/projects/acme/unknown/runs")).res.status).toBe(
      404,
    );
  });

  it("pages with a keyset cursor, caps the limit at 50 and rejects bad parameters", async () => {
    const w = makeWorld();
    for (let i = 1; i <= 120; i++)
      w.exec(
        `INSERT INTO runs VALUES ('r${String(i).padStart(4, "0")}', 'acme/demo', ${i}, 'merged', NULL, ${i}, ${1000 + Math.floor(i / 3)}, 9999)`,
      );
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q: string = `limit=50${cursor ? `&cursor=${cursor}` : ""}`;
      const { res, body } = await get(w, `/api/projects/acme/demo/runs?${q}`);
      expect(res.status).toBe(200);
      expect(body.runs.length).toBeLessThanOrEqual(50);
      seen.push(...body.runs.map((r: { id: string }) => r.id));
      cursor = body.nextCursor;
      pages++;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(120);
    // Newest first by (createdAt, id).
    const sorted = [...seen].sort().reverse();
    expect(seen.length).toBe(sorted.length);
    const big = await get(w, "/api/projects/acme/demo/runs?limit=500");
    expect(big.body.runs).toHaveLength(50);
    const dflt = await get(w, "/api/projects/acme/demo/runs");
    expect(dflt.body.runs).toHaveLength(20);
    for (const q of [
      "limit=0",
      "limit=-1",
      "limit=abc",
      "limit=1.5",
      "cursor=bad",
      "cursor=1_2;DROP",
      "limit=1&limit=2",
      "x=1",
    ]) {
      const r = await get(w, `/api/projects/acme/demo/runs?${q}`);
      expect(r.res.status, q).toBe(400);
      expect(r.body).toEqual({ error: "bad_request" });
    }
  });
});

describe("GET /api/runs/:id", () => {
  it("returns the run and its events in order with only allowlisted fields", async () => {
    const w = makeWorld();
    seedRuns(w);
    const { res, body } = await get(w, "/api/runs/aaaaaaaaaaa1");
    expect(res.status).toBe(200);
    expect(body).toEqual({
      run: {
        id: "aaaaaaaaaaa1",
        repo: "acme/demo",
        issueNumber: 7,
        state: "awaiting_approval",
        reasonCode: null,
        prNumber: 40,
        createdAt: 1000,
        updatedAt: 5000,
      },
      events: [
        {
          id: 1,
          ts: 1000,
          kind: "created",
          fromState: null,
          toState: "queued",
          reasonCode: null,
        },
        {
          id: 2,
          ts: 1100,
          kind: "transition",
          fromState: "queued",
          toState: "cloning",
          reasonCode: null,
        },
        {
          id: 3,
          ts: 1200,
          kind: "cleanup",
          fromState: null,
          toState: null,
          reasonCode: null,
        },
      ],
    });
  });

  it("answers 404 for an unknown run and for a run whose repository left PROJECTS", async () => {
    const w = makeWorld();
    seedRuns(w);
    expect((await get(w, "/api/runs/aaaaaaaaaaa9")).res.status).toBe(404);
    expect((await get(w, "/api/runs/aaaaaaaaaaa5")).res.status).toBe(404);
    w.env.PROJECTS = "acme/other";
    expect((await get(w, "/api/runs/aaaaaaaaaaa1")).res.status).toBe(404);
    expect((await get(w, "/api/runs/aaaaaaaaaaa4")).res.status).toBe(200);
  });

  it("is readable without logging in", async () => {
    const w = makeWorld({ GITHUB_OAUTH_CLIENT_ID: "", SESSION_SECRET: "" });
    seedRuns(w);
    expect((await get(w, "/api/runs/aaaaaaaaaaa1")).res.status).toBe(200);
  });
});

describe("field allowlist", () => {
  it("drops every column and property the allowlist does not name", async () => {
    const leaky = (row: Record<string, unknown>) => ({
      ...row,
      title: "ISSUE TITLE",
      body: "ISSUE BODY",
      agent_log: "RAW AGENT LOG",
      token: "ghs_SECRET",
      delivery_id: "d-1",
    });
    const rows = {
      run: leaky({
        id: "aaaaaaaaaaa1",
        repo: "acme/demo",
        issue_number: 7,
        state: "failed",
        reason_code: "timeout",
        pr_number: null,
        created_at: 1,
        updated_at: 2,
      }),
      event: leaky({
        id: 1,
        run_id: "aaaaaaaaaaa1",
        ts: 1,
        kind: "transition",
        from_state: "queued",
        to_state: "failed",
        reason_code: "timeout",
      }),
    };
    interface Stmt {
      bind(): Stmt;
      all(): Promise<{ results: unknown[] }>;
      first(): Promise<unknown>;
    }
    const stmt = (results: unknown[]): Stmt => ({
      bind() {
        return this;
      },
      async all() {
        return { results };
      },
      async first() {
        return results[0] ?? null;
      },
    });
    const db = { prepare: (): Stmt => stmt([rows.run]) };
    const repo = new D1ReadRepo(db as never);
    const run = await repo.getRun("aaaaaaaaaaa1");
    expect(Object.keys(run!).sort()).toEqual([
      "createdAt",
      "id",
      "issueNumber",
      "prNumber",
      "reasonCode",
      "repo",
      "state",
      "updatedAt",
    ]);
    db.prepare = () => stmt([rows.event]);
    const events = await repo.listEvents("aaaaaaaaaaa1");
    expect(Object.keys(events[0]!).sort()).toEqual([
      "fromState",
      "id",
      "kind",
      "reasonCode",
      "toState",
      "ts",
    ]);
    const text = JSON.stringify([run, events]);
    for (const s of [
      "ISSUE TITLE",
      "ISSUE BODY",
      "RAW AGENT LOG",
      "ghs_SECRET",
      "d-1",
    ])
      expect(text).not.toContain(s);
  });

  it("replaces an unknown reason code with null", async () => {
    const w = makeWorld();
    w.exec(
      `INSERT INTO runs VALUES ('aaaaaaaaaaa1', 'acme/demo', 7, 'failed', 'some free text <b>', NULL, 1, 2)`,
    );
    const { body } = await get(w, "/api/runs/aaaaaaaaaaa1");
    expect(body.run.reasonCode).toBeNull();
  });

  it("only emits known states and reason codes from the seeded data", async () => {
    const w = makeWorld();
    seedRuns(w);
    for (const id of [
      "aaaaaaaaaaa1",
      "aaaaaaaaaaa2",
      "aaaaaaaaaaa3",
      "aaaaaaaaaaa4",
    ]) {
      const { body } = await get(w, `/api/runs/${id}`);
      expect(STATES).toContain(body.run.state);
      if (body.run.reasonCode !== null)
        expect(REASON_CODES).toContain(body.run.reasonCode);
    }
  });
});
