import { describe, expect, it } from "vitest";
import type { ControlEnv } from "./env";
import { D1SwitchRepo } from "./factory-switch";
import { DEFAULT_MIN_AGE_DAYS, minAgeDays, runScheduled } from "./scheduled";
import { makeWorld } from "./testing/api-world";
import { testPem } from "./testing/pulls-world";

const NOW = Date.parse("2026-11-20T00:00:00Z");

function setup(over: Partial<ControlEnv> = {}) {
  const w = makeWorld();
  const paths: string[] = [];
  const fetchStub = (async (url: string, init: RequestInit) => {
    const path = url.replace("https://api.github.com", "");
    paths.push(`${init.method ?? "GET"} ${path}`);
    if (path.endsWith("/installation")) return Response.json({ id: 7 });
    if (path.endsWith("/access_tokens"))
      return Response.json(
        { token: "t", expires_at: "2030-01-01T00:00:00Z" },
        { status: 201 },
      );
    if (path.includes("/pulls?")) return Response.json([]);
    return Response.json({}, { status: 404 });
  }) as typeof fetch;
  const env = {
    DB: w.d1,
    RUNS_ENABLED: "true",
    PROJECTS: "acme/demo,acme/other",
    DEPENDABOT_PROJECTS: "acme/demo",
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: testPem(),
    ...over,
  } as unknown as ControlEnv;
  const run = () => runScheduled(env, { fetch: fetchStub, now: () => NOW });
  return { w, paths, run };
}

describe("minAgeDays", () => {
  it.each([
    [undefined, DEFAULT_MIN_AGE_DAYS],
    ["", DEFAULT_MIN_AGE_DAYS],
    ["abc", DEFAULT_MIN_AGE_DAYS],
    ["-1", DEFAULT_MIN_AGE_DAYS],
    ["1.5", DEFAULT_MIN_AGE_DAYS],
    ["31", DEFAULT_MIN_AGE_DAYS],
    ["0", DEFAULT_MIN_AGE_DAYS],
    ["00", DEFAULT_MIN_AGE_DAYS],
    ["1", 1],
    ["7", 7],
    [" 5 ", 5],
  ])("reads %j as %i", (value, days) => {
    expect(minAgeDays(value)).toBe(days);
  });
});

describe("runScheduled", () => {
  it("lists the pull requests of the configured repository", async () => {
    const s = setup();
    expect(await s.run()).toEqual([]);
    expect(s.paths).toContain(
      "GET /repos/acme/demo/pulls?state=open&per_page=100&page=1",
    );
    expect(s.paths.some((p) => p.includes("acme/other"))).toBe(false);
  });

  it.each<[string, Partial<ControlEnv>]>([
    ["DEPENDABOT_PROJECTS is unset", { DEPENDABOT_PROJECTS: undefined }],
    ["DEPENDABOT_PROJECTS is empty", { DEPENDABOT_PROJECTS: "" }],
    [
      "the repository is not a managed project",
      { DEPENDABOT_PROJECTS: "acme/unmanaged" },
    ],
    ["runs are disabled", { RUNS_ENABLED: "false" }],
    ["the App id is missing", { GITHUB_APP_ID: "" }],
    ["the App key is missing", { GITHUB_APP_PRIVATE_KEY: undefined }],
    ["the database is missing", { DB: undefined }],
  ])("does nothing when %s", async (_name, over) => {
    const s = setup(over);
    expect(await s.run()).toBeNull();
    expect(s.paths).toEqual([]);
  });

  it("does nothing while the factory is stopped", async () => {
    const s = setup();
    await new D1SwitchRepo(s.w.d1 as never).record({
      ts: 1,
      actorId: "1",
      enabled: false,
    });
    expect(await s.run()).toBeNull();
    expect(s.paths).toEqual([]);
  });
});
