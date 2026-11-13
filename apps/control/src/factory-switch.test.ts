import { describe, expect, it } from "vitest";
import { handleRequest } from "./app";
import { D1SwitchRepo } from "./factory-switch";
import {
  OPERATOR_ID,
  makeWorld,
  observerCookie,
  operatorCookie,
  req,
  seedRuns,
  type World,
} from "./testing/api-world";

describe("D1SwitchRepo (migration 0009)", () => {
  it("has no row at first, then returns the latest change", async () => {
    const w = makeWorld();
    const repo = new D1SwitchRepo(w.d1 as never);
    expect(await repo.latest()).toBeNull();
    await repo.record({ ts: 1000, actorId: "1", enabled: false });
    await repo.record({ ts: 2000, actorId: "2", enabled: true });
    expect(await repo.latest()).toEqual({
      ts: 2000,
      actorId: "2",
      enabled: true,
    });
  });

  it("keeps every change: rows cannot be updated or deleted", () => {
    const w = makeWorld();
    w.exec(
      "INSERT INTO factory_switch (ts, actor_id, enabled) VALUES (1, 'a', 0)",
    );
    expect(() => w.exec("UPDATE factory_switch SET enabled = 1")).toThrow(
      /append-only/,
    );
    expect(() => w.exec("DELETE FROM factory_switch")).toThrow(/append-only/);
    expect(() =>
      w.exec(
        "INSERT INTO factory_switch (ts, actor_id, enabled) VALUES (2, 'a', 2)",
      ),
    ).toThrow();
  });

  it("lists the runs that are not in a final state", async () => {
    const w = makeWorld();
    seedRuns(w);
    // The run of a repository that left PROJECTS is still active: a stop must reach it too.
    expect(await new D1SwitchRepo(w.d1 as never).activeRuns()).toEqual([
      { id: "aaaaaaaaaaa1", repo: "acme/demo", issueNumber: 7 },
      { id: "aaaaaaaaaaa5", repo: "gone/repo", issueNumber: 1 },
    ]);
  });
});

describe("factory switch API", () => {
  const get = async (w: World) => {
    const res = await handleRequest(req("/api/factory"), w.env);
    return { res, body: (await res.json()) as Record<string, unknown> };
  };
  const post = async (w: World, body: unknown, cookie?: string) => {
    const base = req("/api/factory/switch", {
      method: "POST",
      ...(cookie === undefined ? {} : { cookie }),
      headers: { "content-type": "application/json" },
    });
    return handleRequest(
      new Request(base, { body: JSON.stringify(body) }),
      w.env,
    );
  };

  it("GET /api/factory tells anyone the factory runs until an operator stops it", async () => {
    const w = makeWorld({ RUNS_ENABLED: "true" });
    const { res, body } = await get(w);
    expect(res.status).toBe(200);
    expect(body).toEqual({ enabled: true, stoppedAt: null });
  });

  it("an operator stops the factory: new state is stored and every active run gets a stop request", async () => {
    const w = makeWorld({ RUNS_ENABLED: "true" });
    seedRuns(w);
    const res = await post(w, { enabled: false }, await operatorCookie());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      enabled: false,
      stopRequested: 2,
      stopFailed: 0,
    });
    expect(w.stopCalls).toEqual([
      { name: "acme/demo#7", runId: "aaaaaaaaaaa1" },
      { name: "gone/repo#1", runId: "aaaaaaaaaaa5" },
    ]);
    const { body } = await get(w);
    expect(body.enabled).toBe(false);
    expect(typeof body.stoppedAt).toBe("number");
    // Who stopped it stays in D1: the endpoint is public.
    expect(JSON.stringify(body)).not.toContain(OPERATOR_ID);
    expect(w.query("SELECT actor_id, enabled FROM factory_switch")).toEqual([
      { actor_id: OPERATOR_ID, enabled: 0 },
    ]);
  });

  it("stores the stop even when a run cannot be reached, and counts the failure", async () => {
    const w = makeWorld({ RUNS_ENABLED: "true" });
    seedRuns(w);
    (w.env as { ISSUE_RUN: unknown }).ISSUE_RUN = {
      getByName: () => ({
        stop: async () => {
          throw new Error("unreachable");
        },
      }),
    };
    const res = await post(w, { enabled: false }, await operatorCookie());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      enabled: false,
      stopRequested: 0,
      stopFailed: 2,
    });
    expect((await get(w)).body.enabled).toBe(false);
  });

  it("resuming stops nothing and turns the factory back on", async () => {
    const w = makeWorld({ RUNS_ENABLED: "true" });
    seedRuns(w);
    const cookie = await operatorCookie();
    await post(w, { enabled: false }, cookie);
    w.stopCalls.length = 0;
    const res = await post(w, { enabled: true }, cookie);
    expect(res.status).toBe(200);
    expect(w.stopCalls).toEqual([]);
    expect((await get(w)).body).toEqual({ enabled: true, stoppedAt: null });
  });

  it("reports stopped when RUNS_ENABLED is off, whatever the switch says", async () => {
    const w = makeWorld();
    expect((await get(w)).body.enabled).toBe(false);
  });

  it("an observer or an anonymous caller cannot use the switch", async () => {
    const w = makeWorld({ RUNS_ENABLED: "true" });
    seedRuns(w);
    expect(
      (await post(w, { enabled: false }, await observerCookie())).status,
    ).toBe(403);
    expect((await post(w, { enabled: false })).status).toBe(401);
    expect(w.query("SELECT * FROM factory_switch")).toEqual([]);
    expect(w.stopCalls).toEqual([]);
  });

  it("refuses a bad body and stores nothing", async () => {
    const w = makeWorld({ RUNS_ENABLED: "true" });
    const cookie = await operatorCookie();
    for (const bad of [{}, { enabled: "no" }, { enabled: false, x: 1 }, 5]) {
      expect((await post(w, bad, cookie)).status, JSON.stringify(bad)).toBe(
        400,
      );
    }
    expect(w.query("SELECT * FROM factory_switch")).toEqual([]);
  });
});
