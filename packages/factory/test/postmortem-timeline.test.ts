import { describe, expect, it } from "vitest";
import { incidentKey, resolveIncident } from "../src/postmortem/incident";
import { collectTimeline } from "../src/postmortem/timeline";
import { writeMarker } from "../src/report/text";
import type { RunRecord } from "../src/runs/store";
import { stepRecord } from "../src/stages/common";
import { renderErrorIssue } from "../src/stages/intake";
import { BOT, makeTestDeps, type TestHarness } from "./helpers";

const T = (s: string) => `2026-10-12T${s}:00:00.000Z`;

async function addRun(h: TestHarness, ts: string, r: Omit<RunRecord, "ts">) {
  await h.deps.runs.append({ ts, ...r });
}

function addMergedPull(
  h: TestHarness,
  o: {
    number: number;
    mergedAt: string;
    author?: string;
    body?: string;
    headSha: string;
    files: { filename: string; additions?: string[]; deletions?: string[] }[];
    checks?: Record<string, string | null>;
  },
) {
  h.gh.pulls.set(o.number, {
    number: o.number,
    title: `pr ${o.number}`,
    body: o.body ?? "",
    author: o.author ?? BOT,
    headRef: `factory/issue-${o.number}`,
    headSha: o.headSha,
    baseRef: "main",
    labels: [],
    draft: false,
    state: "closed",
    merged: true,
    mergedAt: o.mergedAt,
    files: o.files.map((f) => ({ additions: [], deletions: [], ...f })),
  });
  if (o.checks) h.gh.setChecks(o.headSha, o.checks);
}

// 2026-10-21 #66 재현: 복구 이력 없는 스모크 이슈, 장애 구간 안의 봇 PR 1개와 구간 밖 PR 1개.
function smokeFixture() {
  const h = makeTestDeps({ now: new Date(T("12")) });
  return h;
}

describe("smoke incident", () => {
  it("resolves episode 1 with the e2e-preview failure and the conduit excerpt (#66)", async () => {
    const h = smokeFixture();
    h.gh.addIssue({ title: "[스모크]", labels: ["source:smoke"] });
    await addRun(h, T("10"), {
      ...stepRecord("smoke", 1, null, false, "smoke_failed"),
      detail: "expected name: 'conduit'",
    });
    addMergedPull(h, {
      number: 10,
      mergedAt: T("08"),
      headSha: "sha-10",
      files: [
        { filename: "apps/web/src/pages/Home.tsx", deletions: ["conduit"], additions: ["x"] },
      ],
      checks: { ci: "success", "e2e-preview": "failure" },
    });
    addMergedPull(h, {
      number: 11,
      mergedAt: "2026-10-01T00:00:00.000Z",
      headSha: "sha-11",
      files: [{ filename: "README.md" }],
    });
    const incident = await resolveIncident(h.deps, 1, "smoke");
    expect(incident).toEqual({
      issue: 1,
      kind: "smoke",
      episode: 1,
      detectedAt: T("10"),
      lastGoodAt: null,
      recoveredAt: null,
    });
    expect(incidentKey(incident)).toBe("1#1");
    const tl = await collectTimeline(h.deps, incident);
    expect(tl.windowStart).toBe("2026-10-11T10:00:00.000Z");
    expect(tl.candidates.map((c) => c.number)).toEqual([10]);
    const c = tl.candidates[0]!;
    expect(c.author).toBe("bot");
    expect(c.mergeSha).toBeNull();
    expect(c.files).toEqual([
      { path: "apps/web/src/pages/Home.tsx", tier: "T1", deletions: ["conduit"], additions: ["x"] },
    ]);
    expect(c.tier).toBe("T1");
    expect(c.checks).toContainEqual({ name: "e2e-preview", state: "fail" });
    expect(c.checks).toContainEqual({ name: "ci", state: "pass" });
    expect(tl.excerpt).toContain("conduit");
  });

  it("starts episode 2 after one recovery and anchors lastGoodAt to the recovery record", async () => {
    const h = smokeFixture();
    h.gh.addIssue({ title: "[스모크]", labels: ["source:smoke"] });
    await addRun(h, T("01"), {
      ...stepRecord("smoke", 1, null, false, "smoke_failed"),
      detail: "old",
    });
    await addRun(h, T("04"), stepRecord("smoke", 1, null, true));
    await addRun(h, T("09"), {
      ...stepRecord("smoke", 1, null, false, "smoke_failed"),
      detail: "new",
    });
    addMergedPull(h, {
      number: 20,
      mergedAt: T("02"),
      headSha: "s20",
      files: [{ filename: "a.ts" }],
    });
    addMergedPull(h, {
      number: 21,
      mergedAt: T("06"),
      headSha: "s21",
      files: [{ filename: "b.ts" }],
    });
    const incident = await resolveIncident(h.deps, 1, "smoke");
    expect(incident).toMatchObject({
      episode: 2,
      lastGoodAt: T("04"),
      detectedAt: T("09"),
      recoveredAt: null,
    });
    const tl = await collectTimeline(h.deps, incident);
    expect(tl.windowStart).toBe(T("04"));
    expect(tl.candidates.map((c) => c.number)).toEqual([21]);
    expect(tl.excerpt).toBe("new");
  });

  it("describes the just-recovered episode when the latest smoke record is a recovery", async () => {
    const h = smokeFixture();
    h.gh.addIssue({ title: "[스모크]", labels: ["source:smoke"] });
    await addRun(h, T("01"), stepRecord("smoke", 1, null, false, "smoke_failed"));
    await addRun(h, T("04"), stepRecord("smoke", 1, null, true));
    expect(await resolveIncident(h.deps, 1, "smoke")).toMatchObject({
      episode: 1,
      detectedAt: T("01"),
      recoveredAt: T("04"),
    });
  });

  it("uses excerptOverride before the record detail", async () => {
    const h = smokeFixture();
    h.gh.addIssue({ title: "[스모크]", labels: ["source:smoke"] });
    await addRun(h, T("10"), {
      ...stepRecord("smoke", 1, null, false, "smoke_failed"),
      detail: "d",
    });
    const tl = await collectTimeline(h.deps, await resolveIncident(h.deps, 1, "smoke"), {
      excerptOverride: "override",
    });
    expect(tl.excerpt).toBe("override");
  });

  it("includes only runs of the incident issue and candidate request issues", async () => {
    const h = smokeFixture();
    h.gh.addIssue({ title: "[스모크]", labels: ["source:smoke"] });
    h.gh.addIssue({ title: "req" });
    await addRun(h, T("10"), stepRecord("smoke", 1, null, false, "smoke_failed"));
    await addRun(h, T("07"), stepRecord("gate", 2, 30, true));
    await addRun(h, T("07"), stepRecord("gate", 3, 31, true));
    addMergedPull(h, {
      number: 30,
      mergedAt: T("08"),
      headSha: "s30",
      body: writeMarker("factory:meta", {
        issue: 2,
        role: "implement",
        implementEngine: "codex",
        implementModel: "m",
        round: 0,
      }),
      files: [{ filename: "a.ts" }],
    });
    const tl = await collectTimeline(h.deps, await resolveIncident(h.deps, 1, "smoke"));
    expect(tl.candidates[0]?.requestIssue).toBe(2);
    expect(tl.runs.map((r) => r.issue).sort()).toEqual([1, 2]);
  });
});

describe("error incident", () => {
  it("starts the window 24 hours before the first-seen marker", async () => {
    const h = makeTestDeps({ now: new Date(T("12")) });
    const { title, body } = renderErrorIssue(
      {
        fingerprint: "0123456789abcdef",
        message: "boom",
        path: "/api/x",
        count: 1,
        firstSeen: T("06"),
        lastSeen: T("07"),
      },
      h.deps.settings,
    );
    const n = await h.gh.createIssue(title, body, ["source:error"]);
    expect(body).toContain('<!-- factory:error-first-seen {"at":"2026-10-12T06:00:00.000Z"} -->');
    const incident = await resolveIncident(h.deps, n, "error");
    expect(incident.lastGoodAt).toBeNull();
    const tl = await collectTimeline(h.deps, incident);
    expect(tl.windowStart).toBe("2026-10-11T06:00:00.000Z");
  });
});

describe("deploy and stall incidents", () => {
  it("picks only the request PR and looks back 24 hours from detection", async () => {
    const h = makeTestDeps({ now: new Date(T("12")) });
    h.gh.addIssue({ title: "req" });
    await addRun(h, T("10"), stepRecord("deploy", 1, null, false, "deploy_failed"));
    const meta = writeMarker("factory:meta", {
      issue: 1,
      role: "implement",
      implementEngine: "codex",
      implementModel: "m",
      round: 0,
    });
    addMergedPull(h, {
      number: 40,
      mergedAt: T("09"),
      headSha: "s40",
      body: meta,
      files: [{ filename: "a.ts" }],
    });
    addMergedPull(h, {
      number: 41,
      mergedAt: T("09"),
      headSha: "s41",
      files: [{ filename: "b.ts" }],
    });
    const incident = await resolveIncident(h.deps, 1, "deploy");
    expect(incident.detectedAt).toBe(T("10"));
    const tl = await collectTimeline(h.deps, incident);
    expect(tl.windowStart).toBe("2026-10-11T10:00:00.000Z");
    expect(tl.candidates.map((c) => c.number)).toEqual([40]);
  });
});
