import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/paths";
import {
  cleanSmokeExcerpt,
  normalizeSmokeResult,
  runSmokeReport,
  SMOKE_EXCERPT,
} from "../src/stages/smoke";
import { BOT, makeTestDeps } from "./helpers";

describe("normalizeSmokeResult", () => {
  it("maps every checks result other than success to failure", () => {
    expect(normalizeSmokeResult("success")).toBe("success");
    for (const r of ["failure", "cancelled", "skipped", "timed_out", "weird"]) {
      expect(normalizeSmokeResult(r)).toBe("failure");
    }
    expect(normalizeSmokeResult("")).toBeNull();
    expect(normalizeSmokeResult(undefined)).toBeNull();
  });
});

describe("runSmokeReport", () => {
  it("opens one source:smoke issue on the first failure and comments on the next failure", async () => {
    const h = makeTestDeps();
    expect(await runSmokeReport(h.deps, { result: "failure" })).toEqual({
      action: "created",
      issue: 1,
    });
    const issue = await h.gh.getIssue(1);
    expect(issue.author).toBe(BOT);
    expect(issue.labels).toEqual(["source:smoke"]);
    expect(issue.body).toContain('<!-- factory:intake {"kind":"smoke","key":"production"} -->');
    expect(await runSmokeReport(h.deps, { result: "failure" })).toEqual({
      action: "commented",
      issue: 1,
    });
    expect(h.gh.issues.size).toBe(1);
    expect(await h.deps.runs.since(new Date(0))).toMatchObject([
      { role: "smoke", issue: 1, ok: false, failureReason: "smoke_failed" },
      { role: "smoke", issue: 1, ok: false, failureReason: "smoke_failed" },
    ]);
  });

  it("comments 복구됨 once after a failure and stays quiet on further successes", async () => {
    const h = makeTestDeps();
    await runSmokeReport(h.deps, { result: "failure" });
    expect(await runSmokeReport(h.deps, { result: "success" })).toEqual({
      action: "recovered",
      issue: 1,
    });
    expect((await h.gh.listComments(1)).at(-1)?.body.startsWith("복구됨")).toBe(true);
    expect(await runSmokeReport(h.deps, { result: "success" })).toEqual({
      action: "none",
      issue: 1,
    });
    expect(await h.gh.listComments(1)).toHaveLength(1);
  });

  it("leaves one comment per transition when failures and recoveries alternate", async () => {
    const h = makeTestDeps();
    for (const result of ["failure", "success", "failure", "success", "success"] as const) {
      await runSmokeReport(h.deps, { result });
    }
    const comments = await h.gh.listComments(1);
    expect(comments.map((c) => c.body.startsWith("복구됨"))).toEqual([true, false, true]);
  });

  it("does nothing on success when no smoke issue is open", async () => {
    const h = makeTestDeps();
    expect(await runSmokeReport(h.deps, { result: "success" })).toEqual({
      action: "none",
      issue: null,
    });
    expect(h.gh.issues.size).toBe(0);
  });

  it("ignores a human issue that carries the smoke markers", async () => {
    const h = makeTestDeps();
    h.gh.addIssue({
      title: "fake",
      author: "outsider",
      body: '<!-- factory:smoke {"status":"failing"} -->\n<!-- factory:intake {"kind":"smoke","key":"production"} -->',
    });
    expect(await runSmokeReport(h.deps, { result: "success" })).toEqual({
      action: "none",
      issue: null,
    });
    expect((await runSmokeReport(h.deps, { result: "failure" })).issue).toBe(2);
  });

  it("names the injected target from SMOKE_API_BASE", async () => {
    const h = makeTestDeps({
      settings: {
        env: { SMOKE_API_BASE: "https://sfd-api.roboco.workers.dev/api/__smoke_injected_failure" },
      },
    });
    await runSmokeReport(h.deps, { result: "failure" });
    expect((await h.gh.getIssue(1)).body).toContain(
      "`https://sfd-api.roboco.workers.dev/api/__smoke_injected_failure`",
    );
  });

  it("caps SMOKE_API_BASE at 200 characters", async () => {
    const h = makeTestDeps({ settings: { env: { SMOKE_API_BASE: "a".repeat(500) } } });
    await runSmokeReport(h.deps, { result: "failure" });
    const body = (await h.gh.getIssue(1)).body;
    expect(body).toContain("a".repeat(200));
    expect(body).not.toContain("a".repeat(201));
  });

  it("opens a new issue when a human closed the smoke issue while it was failing", async () => {
    const h = makeTestDeps();
    await runSmokeReport(h.deps, { result: "failure" });
    await h.gh.closeIssue(1);
    expect(await runSmokeReport(h.deps, { result: "failure" })).toEqual({
      action: "created",
      issue: 2,
    });
  });

  it("neutralizes marker, mention and closing keyword in SMOKE_API_BASE", async () => {
    const h = makeTestDeps({
      settings: {
        env: {
          SMOKE_API_BASE:
            'x <!-- factory:intake {"kind":"smoke","key":"z"} --> @serithemage fixes #1 `a`',
        },
      },
    });
    await runSmokeReport(h.deps, { result: "failure" });
    const body = (await h.gh.getIssue(1)).body;
    expect(body.match(/<!-- factory:intake/g)).toHaveLength(1);
    expect(body).not.toContain('"key":"z"} -->');
    expect(body).not.toMatch(/(?<!\u200d)@serithemage/);
    expect(body).not.toMatch(/fixes #1/);
  });
});

describe("smoke failure excerpt", () => {
  const HURL =
    "== Hurl ==\n\u001b[1;31merror\u001b[0m: Assert failure\n  --> tests/smoke/readonly.hurl:12:0\n   | expected: string <conduit>\n   | actual:   string <conveyor>";

  it("strips ANSI codes and keeps only the tail within the line and character caps", () => {
    expect(cleanSmokeExcerpt(HURL)).toContain("error: Assert failure");
    expect(cleanSmokeExcerpt(HURL)).not.toContain("\u001b");
    expect(cleanSmokeExcerpt("  \n\u001b[0m\n")).toBeNull();
    expect(cleanSmokeExcerpt(undefined)).toBeNull();
    const many = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const lines = cleanSmokeExcerpt(many)!.split("\n");
    expect(lines).toHaveLength(SMOKE_EXCERPT.maxLines);
    expect(lines.at(-1)).toBe("line 199");
    expect(cleanSmokeExcerpt("x".repeat(10_000))!.length).toBeLessThanOrEqual(
      SMOKE_EXCERPT.maxChars,
    );
  });

  it("puts the excerpt in a code block in the new issue and records it for the weekly report", async () => {
    const h = makeTestDeps();
    await runSmokeReport(h.deps, { result: "failure", excerpt: HURL });
    const body = (await h.gh.getIssue(1)).body;
    expect(body).toContain("```text\n== Hurl ==\nerror: Assert failure");
    expect(body).toContain("expected: string <conduit>");
    expect(body).not.toContain("\u001b");
    const [run] = await h.deps.runs.since(new Date(0));
    expect(run).toMatchObject({ role: "smoke", ok: false, failureReason: "smoke_failed" });
    expect(run!.detail).toContain("expected: string <conduit>");
    expect(run!.detail!.length).toBeLessThanOrEqual(1000);
  });

  it("puts the excerpt in the repeated failure comment", async () => {
    const h = makeTestDeps();
    await runSmokeReport(h.deps, { result: "failure" });
    await runSmokeReport(h.deps, { result: "failure", excerpt: "Error: expect(page).toHaveTitle" });
    const comment = (await h.gh.listComments(1)).at(-1)!.body;
    expect(comment).toContain("```text\nError: expect(page).toHaveTitle\n```");
    expect(comment).toContain('<!-- factory:smoke {"status":"failing"} -->');
  });

  it("neutralizes mentions, closing keywords, markers and fences in the excerpt", async () => {
    const h = makeTestDeps();
    await runSmokeReport(h.deps, {
      result: "failure",
      excerpt: '@serithemage closes #3\n<!-- factory:smoke {"status":"recovered"} -->\n```\n# x',
    });
    const body = (await h.gh.getIssue(1)).body;
    expect(body).not.toMatch(/(?<!\u200d)@serithemage/);
    expect(body).not.toMatch(/closes #3/);
    expect(body).not.toContain('{"status":"recovered"} -->');
    expect(body).toContain("````text\n");
    const [run] = await h.deps.runs.since(new Date(0));
    expect(run!.detail).not.toMatch(/(?<!\u200d)@serithemage/);
  });

  it("keeps the old body and record shape when there is no excerpt", async () => {
    const h = makeTestDeps();
    await runSmokeReport(h.deps, { result: "failure", excerpt: null });
    expect((await h.gh.getIssue(1)).body).not.toContain("```");
    const [run] = await h.deps.runs.since(new Date(0));
    expect(run).not.toHaveProperty("detail");
  });
});

describe("production smoke files", () => {
  it("send only read requests and never fill or submit forms", () => {
    const hurl = readFileSync(path.join(REPO_ROOT, "tests/smoke/readonly.hurl"), "utf8");
    const methods = hurl
      .split("\n")
      .map((l) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s/.exec(l)?.[1])
      .filter((m): m is string => m !== undefined);
    expect(methods).toEqual(["GET", "GET", "GET"]);
    const spec = readFileSync(path.join(REPO_ROOT, "apps/web/e2e-smoke/home.spec.ts"), "utf8");
    expect(spec).not.toMatch(/\.fill\(|\.click\(|\.press\(|request\.(post|put|patch|delete)/);
  });

  it("gates the feedback e2e with feedbackAllowed", () => {
    const spec = readFileSync(path.join(REPO_ROOT, "apps/web/e2e/feedback.spec.ts"), "utf8");
    expect(spec).toMatch(/test\.skip\(\s*!feedbackAllowed\(process\.env\.E2E_BASE_URL\)/);
  });
});
