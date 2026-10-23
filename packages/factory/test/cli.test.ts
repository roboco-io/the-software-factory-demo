import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeAdapter, loadFakeScript } from "../src/agents/fake";
import { main, type CliContext } from "../src/cli";
import type { Phase } from "../src/stages/phased";
import { makeTestDeps, openBotPr } from "./helpers";

function context(
  h: ReturnType<typeof makeTestDeps>,
  phases: Phase[] = [],
  out: string[] = [],
): CliContext {
  return {
    env: {},
    stdout: (s) => out.push(s),
    buildDeps: (_env, phase) => {
      phases.push(phase);
      return h.deps;
    },
  };
}

describe("cli main", () => {
  it("collect prints a CollectResult as JSON", async () => {
    const h = makeTestDeps();
    const out: string[] = [];
    expect(await main(["collect", "--json"], context(h, [], out))).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ events: 0, candidates: [], excluded: [] });
  });

  it("weekly-report prints a WeeklyResult as JSON", async () => {
    const h = makeTestDeps();
    const out: string[] = [];
    expect(await main(["weekly-report"], context(h, [], out))).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toEqual({
      issue: 1,
      created: true,
      week: "2026-W42",
      candidates: 0,
    });
  });

  it("smoke-report maps non-success results to failure and requires a result", async () => {
    const h = makeTestDeps();
    const out: string[] = [];
    expect(await main(["smoke-report"], context(h, [], out))).toBe(2);
    expect(await main(["smoke-report", "--result", ""], context(h, [], out))).toBe(2);
    expect(await main(["smoke-report", "--result", "cancelled"], context(h, [], out))).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toEqual({ action: "created", issue: 1 });
    expect(await main(["smoke-report", "--result", "skipped"], context(h, [], out))).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toEqual({ action: "commented", issue: 1 });
    expect(await main(["smoke-report", "--result", "success"], context(h, [], out))).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toEqual({ action: "recovered", issue: 1 });
  });

  it("smoke-report parses --last-success and ignores garbage", async () => {
    const h = makeTestDeps();
    const out: string[] = [];
    let since: Date | null = null;
    h.gh.listMergedPulls = async (d: Date) => {
      since = d;
      return [];
    };
    const args = ["smoke-report", "--result", "failure", "--last-success"];
    expect(await main([...args, "2026-10-12T00:00:00Z"], context(h, [], out))).toBe(0);
    expect(since).toEqual(new Date("2026-10-12T00:00:00Z"));
    expect((await h.gh.getIssue(1)).body).toContain("병합된 PR이 없다");
    const g = makeTestDeps();
    let asked = 0;
    g.gh.listMergedPulls = async () => (asked++, []);
    expect(await main([...args, "garbage"], context(g, [], out))).toBe(0);
    expect(await main([...args, ""], context(makeTestDeps(), [], out))).toBe(0);
    expect(asked).toBe(0);
    expect((await g.gh.getIssue(1)).body).toContain("알 수 없어");
  });

  it("smoke-report reads --excerpt-file and still reports when the file is missing", async () => {
    const h = makeTestDeps();
    const out: string[] = [];
    const dir = mkdtempSync(path.join(tmpdir(), "smoke-"));
    const file = path.join(dir, "excerpt.txt");
    writeFileSync(file, "== Hurl ==\nerror: Assert failure\n");
    const args = ["smoke-report", "--result", "failure", "--excerpt-file"];
    expect(await main([...args, file], context(h, [], out))).toBe(0);
    expect((await h.gh.getIssue(1)).body).toContain("```text\n== Hurl ==\nerror: Assert failure");
    expect(await main([...args, path.join(dir, "none.txt")], context(h, [], out))).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toEqual({ action: "commented", issue: 1 });
    expect((await h.gh.listComments(1)).at(-1)!.body).not.toContain("```");
  });

  it("intake requires INTAKE_URL and INTAKE_TOKEN and calls nothing without them", async () => {
    const h = makeTestDeps();
    const phases: Phase[] = [];
    let fetched = 0;
    const fetchImpl = (async () => {
      fetched++;
      return new Response("{}");
    }) as typeof fetch;
    for (const env of [
      {},
      { INTAKE_URL: "https://x/api" },
      { INTAKE_TOKEN: "t" },
      { INTAKE_URL: "ftp://x", INTAKE_TOKEN: "t" },
      { INTAKE_URL: "http://api.example.com/api", INTAKE_TOKEN: "t" },
      { INTAKE_URL: "http://localhost.evil.com/api", INTAKE_TOKEN: "t" },
    ]) {
      const out: string[] = [];
      expect(await main(["intake"], { ...context(h, phases, out), env, fetch: fetchImpl })).toBe(2);
      expect(out[0]).toContain("INTAKE_URL");
    }
    expect(fetched).toBe(0);
    expect(phases).toEqual([]);
  });

  it("intake acks only successes, exits 1 on a partial failure and never prints the token", async () => {
    const h = makeTestDeps();
    const create = h.gh.createIssue.bind(h.gh);
    let calls = 0;
    h.gh.createIssue = async (title, body, labels) => {
      if (++calls === 1) throw new Error("GitHub 502");
      return create(title, body, labels);
    };
    const acks: unknown[] = [];
    const auth: (string | null)[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      auth.push(new Headers(init?.headers).get("authorization"));
      if (String(input).endsWith("/ack")) {
        acks.push(JSON.parse(String(init?.body)));
        return new Response("{}");
      }
      return Response.json({
        errors: [
          {
            fingerprint: "0123456789abcdef",
            message: "m",
            path: "/p",
            count: 1,
            firstSeen: "t",
            lastSeen: "t",
          },
        ],
        feedback: [{ id: 7, body: "b", path: "/#/", createdAt: "t" }],
      });
    }) as typeof fetch;
    const out: string[] = [];
    const env = { INTAKE_URL: "https://api.test/api", INTAKE_TOKEN: "s3cret-token" };
    expect(await main(["intake"], { ...context(h, [], out), env, fetch: fetchImpl })).toBe(1);
    expect(JSON.parse(out[0] ?? "")).toEqual({
      created: [1],
      updated: [],
      acked: { errors: 0, feedback: 1 },
      failed: 1,
    });
    expect(out.join("\n")).not.toContain("s3cret-token");
    expect(auth).toEqual(["Bearer s3cret-token", "Bearer s3cret-token"]);
    expect(acks).toEqual([{ errors: [], feedback: [7] }]);
  });

  it("intake prints the summary and exits 1 when ack throws", async () => {
    const h = makeTestDeps();
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).endsWith("/ack")) return new Response("no", { status: 500 });
      return Response.json({
        errors: [],
        feedback: [{ id: 7, body: "b", path: "/#/", createdAt: "t" }],
      });
    }) as typeof fetch;
    const out: string[] = [];
    const env = { INTAKE_URL: "http://127.0.0.1:8787/api", INTAKE_TOKEN: "t" };
    expect(await main(["intake"], { ...context(h, [], out), env, fetch: fetchImpl })).toBe(1);
    expect(JSON.parse(out[0] ?? "")).toMatchObject({ created: [1], failed: 1 });
  });

  it("runs the command stage with COMMENT_BODY from env", async () => {
    const h = makeTestDeps();
    const issue = h.gh.addIssue({ title: "t", labels: ["factory:triaged"] });
    const out: string[] = [];
    const ctx = { ...context(h, [], out), env: { COMMENT_BODY: "@factory go" } };
    expect(
      await main(["command", "--issue", String(issue.number), "--actor", "serithemage"], ctx),
    ).toBe(0);
    expect(out).toEqual(["approved"]);
  });

  it("prints usage and returns 2 for an unknown command", async () => {
    const out: string[] = [];
    expect(await main(["nope"], context(makeTestDeps(), [], out))).toBe(2);
    expect(out[0]).toMatch(/usage: pnpm factory <triage/);
  });

  it("returns 2 when a required option is missing or malformed", async () => {
    const out: string[] = [];
    expect(await main(["triage"], context(makeTestDeps(), [], out))).toBe(2);
    expect(await main(["triage", "--issue", "x"], context(makeTestDeps(), [], out))).toBe(2);
    expect(out.join("\n")).toContain("--issue");
  });

  it("validates risk --sha as a 40-hex SHA when provided", async () => {
    const h = makeTestDeps();
    const out: string[] = [];
    for (const sha of ["", "abc", "G".repeat(40), "A".repeat(40)]) {
      out.length = 0;
      expect(await main(["risk", "--pr", "1", "--sha", sha], context(h, [], out))).toBe(2);
      expect(out.join("\n")).toContain("--sha");
    }
  });

  it("runs triage in the requested phase", async () => {
    const h = makeTestDeps({
      adapters: { pi: createFakeAdapter(loadFakeScript("triage-feature"), "pi") },
    });
    const issue = h.gh.addIssue({ title: "t" });
    const phases: Phase[] = [];
    expect(
      await main(["triage", "--issue", String(issue.number), "--phase", "all"], context(h, phases)),
    ).toBe(0);
    expect(phases).toEqual(["all"]);
    expect((await h.gh.getIssue(issue.number)).labels).toContain("factory:triaged");
  });

  it("runs improve in the requested phase and requires --issue", async () => {
    const h = makeTestDeps();
    const issue = h.gh.addIssue({ title: "사람 이슈" });
    const phases: Phase[] = [];
    const out: string[] = [];
    expect(
      await main(
        ["improve", "--issue", String(issue.number), "--phase", "all"],
        context(h, phases),
      ),
    ).toBe(0);
    expect(phases).toEqual(["all"]);
    expect(h.logs).toContain(`improve: #${issue.number} is not an open factory report; skipping`);
    expect(await main(["improve", "--phase", "all"], context(h, [], out))).toBe(2);
  });

  it("runs eval-live in the requested phase and requires --pr and --issue", async () => {
    const h = makeTestDeps();
    const { pr, issue } = await openBotPr(h);
    const phases: Phase[] = [];
    const out: string[] = [];
    expect(
      await main(
        ["eval-live", "--pr", String(pr), "--issue", String(issue), "--phase", "all"],
        context(h, phases),
      ),
    ).toBe(0);
    expect(phases).toEqual(["all"]);
    expect((await h.gh.listComments(pr)).at(-1)?.body).toContain("개선 PR이 아니다");
    expect(
      await main(["eval-live", "--pr", String(pr), "--phase", "all"], context(h, [], out)),
    ).toBe(2);
  });

  it("requires an explicit --phase", async () => {
    const out: string[] = [];
    expect(await main(["triage", "--issue", "1"], context(makeTestDeps(), [], out))).toBe(2);
    expect(out.join("\n")).toContain("--phase");
    expect(
      await main(["triage", "--issue", "1", "--phase", "bogus"], context(makeTestDeps(), [], out)),
    ).toBe(2);
  });

  it("evidence prints the plan as JSON and rejects malformed sha options", async () => {
    const h = makeTestDeps();
    const { pr } = await openBotPr(h);
    const out: string[] = [];
    const head = "a".repeat(40);
    const base = "b".repeat(40);
    expect(
      await main(
        ["evidence", "--pr", String(pr), "--sha", head, "--base", base, "--json"],
        context(h, [], out),
      ),
    ).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({
      pr,
      required: false,
      baseSha: base,
      headSha: head,
      testFiles: [],
    });
    expect(
      await main(["evidence", "--pr", String(pr), "--sha", "HEAD", "--base", base], context(h)),
    ).toBe(2);
  });

  const evidencePlan = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({
      pr: 3,
      required: false,
      reason: "사람 PR",
      reasonCode: "not_bug",
      baseSha: "b".repeat(40),
      headSha: "a".repeat(40),
      testFiles: [],
      ...over,
    });

  it("evidence-run fails closed when the plan is missing or malformed, without building deps", async () => {
    const h = makeTestDeps();
    const phases: Phase[] = [];
    for (const raw of [
      undefined,
      "",
      "{}",
      '{"pr":1,"required":false}',
      evidencePlan({ testFiles: ["apps/web/src/-x.test.ts"] }),
      evidencePlan({ headSha: "HEAD" }),
    ]) {
      const out: string[] = [];
      const ctx = {
        ...context(h, phases, out),
        env: raw === undefined ? {} : { EVIDENCE_PLAN: raw },
      };
      expect(await main(["evidence-run"], ctx)).toBe(1);
      expect(out[0]).toContain("EVIDENCE_PLAN");
    }
    expect(phases).toEqual([]);
  });

  it("evidence-run builds agent-phase deps and passes a plan that does not require evidence", async () => {
    const h = makeTestDeps();
    const phases: Phase[] = [];
    const out: string[] = [];
    const ctx = { ...context(h, phases, out), env: { EVIDENCE_PLAN: evidencePlan() } };
    expect(await main(["evidence-run"], ctx)).toBe(0);
    expect(phases).toEqual(["agent"]);
    expect(out[0]).toContain("evidence 통과");
    expect(out[0]).toContain("reasonCode=not_bug");
  });

  it("evidence-run fails a required plan without test files and prints JSON with reasonCode", async () => {
    const h = makeTestDeps();
    const out: string[] = [];
    const raw = evidencePlan({ required: true, reasonCode: "unknown_state" });
    const ctx = { ...context(h, [], out), env: { EVIDENCE_PLAN: raw } };
    expect(await main(["evidence-run", "--json"], ctx)).toBe(1);
    expect(JSON.parse(out[0]!)).toMatchObject({
      pr: 3,
      ok: false,
      required: true,
      reasonCode: "unknown_state",
    });
  });
  const evalPlan = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({
      pr: 3,
      baseSha: "b".repeat(40),
      headSha: "a".repeat(40),
      requireNewCase: false,
      allowDeletion: true,
      reason: "사람 PR",
      ...over,
    });

  it("eval prints the plan as JSON and rejects malformed sha options", async () => {
    const h = makeTestDeps();
    const { pr, branch } = await openBotPr(h);
    const head = "a".repeat(40);
    const base = "b".repeat(40);
    h.gh.setBranch(branch, head, []);
    const out: string[] = [];
    expect(
      await main(
        ["eval", "--pr", String(pr), "--sha", head, "--base", base, "--json"],
        context(h, [], out),
      ),
    ).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({
      pr,
      baseSha: base,
      headSha: head,
      requireNewCase: false,
      allowDeletion: false,
    });
    expect(
      await main(["eval", "--pr", String(pr), "--sha", "HEAD", "--base", base], context(h)),
    ).toBe(2);
  });

  it("eval-run fails closed when the plan or base dir is missing or malformed, without building deps", async () => {
    const h = makeTestDeps();
    const phases: Phase[] = [];
    for (const env of [
      {},
      { EVAL_PLAN: "{}", EVAL_BASE_DIR: "/x" },
      { EVAL_PLAN: evalPlan({ headSha: "HEAD" }), EVAL_BASE_DIR: "/x" },
      { EVAL_PLAN: evalPlan() },
    ]) {
      const out: string[] = [];
      const ctx = { ...context(h, phases, out), env };
      expect(await main(["eval-run"], ctx)).toBe(1);
      expect(out[0]).toMatch(/EVAL_PLAN|EVAL_BASE_DIR/);
    }
    expect(phases).toEqual([]);
  });

  it("eval-run builds agent-phase deps and fails when the work tree head differs from the plan", async () => {
    const h = makeTestDeps();
    const phases: Phase[] = [];
    const out: string[] = [];
    const ctx = {
      ...context(h, phases, out),
      env: { EVAL_PLAN: evalPlan(), EVAL_BASE_DIR: "/nonexistent" },
    };
    expect(await main(["eval-run"], ctx)).toBe(1);
    expect(phases).toEqual(["agent"]);
    expect(out[0]).toContain("eval 실패(PR #3)");
  });
});
