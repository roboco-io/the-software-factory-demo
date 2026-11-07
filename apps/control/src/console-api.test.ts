import { beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Like } from "./d1-repo";

const empty = {
  runs: [],
  totals: { attention: 0, active: 0, done: 0, usd: 0 },
};
const fakes = vi.hoisted(() => ({
  listRuns: vi.fn(),
  getRun: vi.fn(),
}));

vi.mock("./run-query", () => fakes);

import { handleConsoleRead } from "./console-api";

const db = {} as D1Like;
const deps = { db, publicRepos: [] as string[], now: () => 1 };
const req = (path: string, method = "GET") =>
  new Request(`https://x.test${path}`, { method });

beforeEach(() => {
  fakes.listRuns.mockReset().mockResolvedValue(empty);
  fakes.getRun.mockReset().mockResolvedValue(null);
});

describe("handleConsoleRead", () => {
  it("GET /api/runs with no public repos -> 200 empty", async () => {
    const res = await handleConsoleRead(req("/api/runs"), deps);
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual(empty);
  });

  it("GET /api/runs/unknown -> 404 not_found", async () => {
    const res = await handleConsoleRead(req("/api/runs/unknown"), deps);
    expect(res?.status).toBe(404);
    expect(await res?.json()).toEqual({ error: "not_found" });
  });

  it("GET /api/health -> null", async () => {
    expect(await handleConsoleRead(req("/api/health"), deps)).toBeNull();
  });

  it("POST /api/runs/x/review returns null", async () => {
    expect(
      await handleConsoleRead(req("/api/runs/x/review", "POST"), deps),
    ).toBeNull();
  });

  it("responses are no-store json", async () => {
    for (const path of ["/api/runs", "/api/runs/unknown"]) {
      const res = await handleConsoleRead(req(path), deps);
      expect(res?.headers.get("cache-control")).toBe("no-store");
      expect(res?.headers.get("content-type")).toContain("application/json");
    }
  });

  it("test_post_runs_405", async () => {
    const res = await handleConsoleRead(req("/api/runs", "POST"), deps);
    expect(res?.status).toBe(405);
    expect(res?.headers.get("allow")).toBe("GET, HEAD");
  });

  it("test_bad_id_404", async () => {
    const res = await handleConsoleRead(req("/api/runs/a%2Fb"), deps);
    expect(res?.status).toBe(404);
    expect(await res?.json()).toEqual({ error: "not_found" });
  });

  it("returns the run when found", async () => {
    fakes.getRun.mockResolvedValue({ id: "r1" });
    const res = await handleConsoleRead(req("/api/runs/r1"), deps);
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ id: "r1" });
  });
});
