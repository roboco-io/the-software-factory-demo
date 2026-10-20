import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ENGINES } from "../src/agents/types";
import { REPO_ROOT } from "../src/paths";
import { loadRiskPolicy } from "../src/policy/risk";

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  "working-directory"?: string;
}
interface Job {
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  environment?: string;
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  concurrency?: { group: string };
  "timeout-minutes"?: number;
  steps: Step[];
}
interface Workflow {
  "run-name"?: string;
  env?: Record<string, string>;
  on: Record<string, unknown>;
  concurrency?: { group: string };
  jobs: Record<string, Job>;
}

const DIR = path.join(REPO_ROOT, ".github/workflows");
const load = (file: string) => parse(readFileSync(path.join(DIR, file), "utf8")) as Workflow;
const ALL = readdirSync(DIR)
  .filter((f) => f.endsWith(".yml"))
  .sort();
const FACTORY = ALL.filter((f) => f.startsWith("factory-"));
const AGENT_WORKFLOWS = [
  "factory-triage.yml",
  "factory-implement.yml",
  "factory-review.yml",
  "factory-fix.yml",
  "factory-postmortem.yml",
  "factory-weekly.yml",
  "factory-eval-live.yml",
];
// 에이전트 두 개(구현·리뷰)를 쓰므로 엔진 키를 둘 다 받는 워크플로.
const TWO_ENGINE_WORKFLOWS = ["factory-eval-live.yml"];
const PHASED = /pnpm -s factory (triage|implement|review|fix|improve|eval-live|postmortem)\b/;
const text = (step: Step) => JSON.stringify(step);
const steps = (wf: Workflow) => Object.values(wf.jobs).flatMap((j) => j.steps);
const checkouts = (job: Job) => job.steps.filter((s) => s.uses?.startsWith("actions/checkout@"));
const workCheckout = (job: Job) => checkouts(job).find((s) => s.with?.path === "work");
const KEY: Record<(typeof ENGINES)[number], string> = {
  claude: "ANTHROPIC_API_KEY",
  codex: "CODEX_API_KEY",
  pi: "DEEPSEEK_API_KEY",
};

describe("factory workflows", () => {
  it("exist with the expected names", () => {
    expect(FACTORY).toEqual([
      "factory-command.yml",
      "factory-contract.yml",
      "factory-eval-live.yml",
      "factory-fix.yml",
      "factory-guard.yml",
      "factory-implement.yml",
      "factory-intake.yml",
      "factory-merge.yml",
      "factory-postmortem.yml",
      "factory-review.yml",
      "factory-smoke.yml",
      "factory-triage.yml",
      "factory-weekly.yml",
    ]);
  });

  it("never persist checkout credentials and never see Cloudflare secrets", () => {
    for (const file of FACTORY) {
      const raw = readFileSync(path.join(DIR, file), "utf8");
      expect(raw, file).not.toMatch(/CLOUDFLARE|JWT_SECRET/);
      for (const job of Object.values(load(file).jobs)) {
        for (const step of checkouts(job)) {
          expect(step.with?.["persist-credentials"], `${file}: ${text(step)}`).toBe(false);
        }
      }
    }
  });

  it("lets factory-weekly start improve for a given issue and skip the report job", () => {
    const wf = load("factory-weekly.yml");
    const dispatch = wf.on.workflow_dispatch as { inputs?: Record<string, { required?: boolean }> };
    expect(dispatch.inputs?.issue).toBeDefined();
    expect(dispatch.inputs?.issue?.required).not.toBe(true);
    // 입력이 있으면 리포트를 만들지 않는다. 스케줄 실행은 입력이 비어 있으므로 기존대로 돈다.
    expect(wf.jobs.report!.if).toBe("${{ inputs.issue == '' }}");
    for (const name of ["prepare", "agent", "publish"]) {
      expect(wf.jobs[name]!.env?.ISSUE, name).toBe(
        "${{ inputs.issue || needs.report.outputs.issue }}",
      );
    }
    // report가 건너뛰어져도 이어지는 job이 건너뛰어지지 않아야 한다. 실패·취소는 이어 가지 않는다.
    expect(wf.jobs.prepare!.if).toContain("!cancelled()");
    expect(wf.jobs.prepare!.if).toContain("needs.report.result == 'skipped'");
    expect(wf.jobs.prepare!.if).toContain("inputs.issue != ''");
    expect(wf.jobs.prepare!.if).toContain("needs.report.outputs.candidates != '0'");
    expect(wf.jobs.agent!.if).toContain("!cancelled()");
    expect(wf.jobs.agent!.if).toContain("needs.prepare.result == 'success'");
    expect(wf.jobs.agent!.if).toContain("needs.prepare.outputs.has-plan == 'true'");
  });

  it("allow unprivileged user namespaces before running an agent, so the Codex sandbox works on ubuntu-24.04", () => {
    const SYSCTL = "sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0";
    for (const file of AGENT_WORKFLOWS) {
      const agentSteps = load(file).jobs.agent!.steps;
      const sysctl = agentSteps.findIndex((s) => s.run === SYSCTL);
      const run = agentSteps.findIndex((s) => s.run?.includes("--phase agent"));
      expect(sysctl, file).toBeGreaterThanOrEqual(0);
      expect(sysctl, file).toBeLessThan(run);
    }
    const contract = load("factory-contract.yml").jobs.contract!.steps;
    expect(contract.findIndex((s) => s.run === SYSCTL)).toBeLessThan(
      contract.findIndex((s) => s.run?.includes("test:contract")),
    );
    expect(contract.some((s) => s.run === SYSCTL)).toBe(true);
  });

  it("split agent workflows into prepare, agent and publish jobs, with no GitHub token in the agent job", () => {
    for (const file of AGENT_WORKFLOWS) {
      const wf = load(file);
      const weekly = file === "factory-weekly.yml";
      expect(Object.keys(wf.jobs), file).toEqual(
        weekly ? ["report", "prepare", "agent", "publish"] : ["prepare", "agent", "publish"],
      );
      const agent = wf.jobs.agent!;
      expect(
        agent.steps.some((s) => s.run?.includes("--phase agent")),
        file,
      ).toBe(true);
      for (const step of agent.steps) {
        expect(text(step), `${file} agent job`).not.toMatch(
          /FACTORY_TOKEN|GITHUB_TOKEN|FACTORY_APP_|create-github-app-token/,
        );
      }
      expect(agent.permissions, `${file} agent permissions`).toEqual({ contents: "read" });
      expect(agent.environment, file).toBeUndefined();
      for (const job of ["prepare", "publish"] as const) {
        expect(
          wf.jobs[job]!.steps.some((s) => s.run?.includes(`--phase ${job}`)),
          `${file} ${job}`,
        ).toBe(true);
        expect(
          wf.jobs[job]!.steps.some((s) => /ANTHROPIC|CODEX_API|DEEPSEEK/.test(text(s))),
          `${file} ${job} has engine keys`,
        ).toBe(false);
      }
      // 주간 실행은 이슈 번호를 report job이 정하므로 run-name에 쓸 수 없다.
      if (!weekly) expect(wf["run-name"], file).toMatch(/\[factory\/issue-\$\{\{/);
    }
  });

  it("give the agent job only the API key of the engine chosen by prepare (F16)", () => {
    for (const file of AGENT_WORKFLOWS.filter((f) => !TWO_ENGINE_WORKFLOWS.includes(f))) {
      const wf = load(file);
      expect(wf.jobs.prepare!.outputs?.engine, file).toBe("${{ steps.prepare.outputs.engine }}");
      const step = wf.jobs.agent!.steps.find((s) => s.run?.includes("--phase agent"))!;
      for (const engine of ENGINES) {
        expect(step.env?.[KEY[engine]], `${file} ${engine}`).toBe(
          `\${{ needs.prepare.outputs.engine == '${engine}' && secrets.${KEY[engine]} || '' }}`,
        );
      }
      const keys = JSON.stringify(wf.jobs.agent).match(/secrets\.[A-Z_]+/g) ?? [];
      expect([...new Set(keys)].sort(), file).toEqual(
        Object.values(KEY)
          .map((k) => `secrets.${k}`)
          .sort(),
      );
    }
  });

  it("run the factory CLI from a trusted main checkout and hand over the plan from prepare by artifact id", () => {
    for (const file of AGENT_WORKFLOWS) {
      const wf = load(file);
      expect(wf.jobs.prepare!.outputs?.["plan-artifact-id"], file).toBe(
        "${{ steps.plan.outputs.artifact-id }}",
      );
      for (const [name, job] of Object.entries(wf.jobs)) {
        const runtime = checkouts(job).find((s) => s.with?.path === "runtime");
        expect(runtime?.with?.ref, `${file} ${name}`).toBe("main");
        for (const step of job.steps.filter((s) => s.run?.includes("pnpm -s factory"))) {
          expect(step["working-directory"], `${file} ${name}`).toBe("runtime");
        }
        const uploads = job.steps.filter((s) => s.uses?.startsWith("actions/upload-artifact@"));
        const plans = uploads.filter((s) => s.with?.name === "factory-plan");
        expect(plans.length, `${file} ${name} uploads factory-plan`).toBe(
          name === "prepare" ? 1 : 0,
        );
        if (name === "prepare" || (file === "factory-weekly.yml" && name === "report")) continue;
        const download = job.steps.find(
          (s) =>
            s.uses?.startsWith("actions/download-artifact@") &&
            s.with?.path === "${{ runner.temp }}/in",
        );
        expect(download?.with?.["artifact-ids"], `${file} ${name}`).toBe(
          "${{ needs.prepare.outputs.plan-artifact-id }}",
        );
        expect(download?.with?.name, `${file} ${name}`).toBeUndefined();
      }
    }
  });

  it("factory-eval-live runs only on demand and gives the agent job the keys of both assigned engines, no token", () => {
    const wf = load("factory-eval-live.yml");
    expect(Object.keys(wf.on)).toEqual(["workflow_dispatch"]);
    expect(Object.keys((wf.on.workflow_dispatch as { inputs: object }).inputs).sort()).toEqual([
      "issue",
      "pr",
    ]);
    expect(Object.keys(wf.jobs)).toEqual(["prepare", "agent", "publish"]);
    const agent = wf.jobs.agent!;
    expect(JSON.stringify(agent)).not.toMatch(
      /FACTORY_TOKEN|GITHUB_TOKEN|GH_TOKEN|FACTORY_APP_|create-github-app-token/,
    );
    expect(agent.permissions).toEqual({ contents: "read" });
    const outputs = wf.jobs.prepare!.outputs!;
    expect(outputs["implement-engine"]).toBe("${{ steps.prepare.outputs.implement-engine }}");
    expect(outputs["review-engine"]).toBe("${{ steps.prepare.outputs.review-engine }}");
    const step = agent.steps.find((s) => s.run?.includes("--phase agent"))!;
    for (const engine of ENGINES) {
      expect(step.env?.[KEY[engine]], engine).toBe(
        `\${{ (needs.prepare.outputs.implement-engine == '${engine}' || needs.prepare.outputs.review-engine == '${engine}') && secrets.${KEY[engine]} || '' }}`,
      );
    }
    const keys = JSON.stringify(agent).match(/secrets\.[A-Z_]+/g) ?? [];
    expect([...new Set(keys)].sort()).toEqual(
      Object.values(KEY)
        .map((k) => `secrets.${k}`)
        .sort(),
    );
    // 입력은 env로만 넘긴다(run 스크립트에 보간하지 않는다).
    expect(wf.env?.PR).toBe("${{ inputs.pr }}");
    expect(wf.env?.ISSUE).toBe("${{ inputs.issue }}");
    expect(workCheckout(agent)?.with?.["fetch-depth"]).toBe(0);
  });

  it("factory-postmortem runs on dispatch and on closed issues, serialized per issue, with no token in the agent job", () => {
    const wf = load("factory-postmortem.yml");
    expect(Object.keys(wf.on).sort()).toEqual(["issues", "workflow_dispatch"]);
    expect(wf.on.issues).toEqual({ types: ["closed"] });
    const inputs = Object.keys((wf.on.workflow_dispatch as { inputs: object }).inputs).sort();
    expect(inputs).toEqual(["dry_run", "event", "excerpt", "issue", "kind"]);
    expect(wf.concurrency?.group).toBe(
      "factory-postmortem-${{ inputs.issue || github.event.issue.number }}",
    );
    expect(wf.jobs.agent!["timeout-minutes"]).toBe(20);
    expect(JSON.stringify(wf.jobs.agent)).not.toMatch(/FACTORY_TOKEN|GITHUB_TOKEN/);
    // 사용자 입력은 env로만 넘긴다.
    expect(wf.env?.EXCERPT).toBe("${{ inputs.excerpt }}");
  });

  it("factory-weekly runs on Mondays and on demand, reports before improving", () => {
    const wf = load("factory-weekly.yml");
    expect(wf.on.schedule).toEqual([{ cron: "0 0 * * 1" }]);
    expect(wf.on).toHaveProperty("workflow_dispatch");
    expect(wf.jobs.prepare!.needs).toBe("report");
    expect(wf.jobs.prepare!.if).toContain("needs.report.outputs.candidates != '0'");
    expect(JSON.stringify(wf.jobs.agent)).not.toMatch(/FACTORY_TOKEN|GITHUB_TOKEN/);
  });

  it("check out agent and publish work trees with full history (T13-a)", () => {
    for (const file of ["factory-implement.yml", "factory-fix.yml", "factory-review.yml"]) {
      const wf = load(file);
      expect(workCheckout(wf.jobs.agent!)?.with?.["fetch-depth"], `${file} agent`).toBe(0);
    }
    for (const file of ["factory-implement.yml", "factory-fix.yml"]) {
      expect(workCheckout(load(file).jobs.publish!)?.with?.["fetch-depth"], `${file} publish`).toBe(
        0,
      );
    }
  });

  it("give the implement agent job 75 minutes (F10)", () => {
    expect(load("factory-implement.yml").jobs.agent!["timeout-minutes"]).toBe(75);
  });

  it("review the head SHA that prepare judged (F17)", () => {
    const wf = load("factory-review.yml");
    expect(wf.jobs.prepare!.outputs?.["head-sha"]).toBe("${{ steps.prepare.outputs.head-sha }}");
    expect(workCheckout(wf.jobs.agent!)?.with?.ref).toBe("${{ needs.prepare.outputs.head-sha }}");
  });

  it("calls the factory CLI instead of embedding logic", () => {
    for (const file of FACTORY) {
      const runs = steps(load(file)).map((s) => s.run ?? "");
      expect(
        runs.some((r) => r.includes("pnpm -s factory") || r.includes("pnpm --filter factory")),
        file,
      ).toBe(true);
    }
  });

  it("pass an explicit --phase prepare|agent|publish on every phased CLI call, never all (F11)", () => {
    for (const file of ALL) {
      const raw = readFileSync(path.join(DIR, file), "utf8");
      expect(raw, file).not.toMatch(/--phase all/);
      for (const step of steps(load(file))) {
        for (const line of (step.run ?? "").split("\n").filter((l) => PHASED.test(l))) {
          expect(line, file).toMatch(/--phase (prepare|agent|publish)\b/);
        }
      }
    }
  });

  it("keep shell glue to at most one conditional line per run script (F11)", () => {
    for (const file of [...FACTORY, "ci.yml", "preview.yml", "deploy.yml"]) {
      for (const step of steps(load(file))) {
        if (!step.run?.includes("factory")) continue;
        const conditionals = step.run
          .split("\n")
          .filter((l) => /^\s*(if|for|while|case)\b/.test(l));
        expect(conditionals.length, `${file}: ${step.run}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it("never interpolate event data into run scripts (T12-a)", () => {
    for (const file of ALL) {
      for (const step of steps(load(file))) {
        expect(step.run ?? "", `${file}: ${step.run}`).not.toContain("${{ github.event.");
        expect(step.run ?? "", `${file}: ${step.run}`).not.toMatch(/\$\{\{\s*github\.head_ref/);
      }
    }
    for (const file of FACTORY) {
      for (const step of steps(load(file)))
        expect(step.run ?? "", `${file}: ${step.run}`).not.toContain("${{");
    }
  });

  it("trigger commands only on newly created comments and read the body from env (T12-a)", () => {
    const wf = load("factory-command.yml");
    expect(wf.on).toEqual({ issue_comment: { types: ["created"] } });
    const step = steps(wf).find((s) => s.run?.includes("factory command"))!;
    expect(step.env?.COMMENT_BODY).toBe("${{ github.event.comment.body }}");
    expect(step.env?.ACTOR).toBe("${{ github.event.comment.user.login }}");
  });

  it("serialize gate runs per PR for both workflow_run and dispatch (F7)", () => {
    expect(load("factory-merge.yml").jobs.gate!.concurrency?.group).toBe(
      "factory-gate-${{ github.event.workflow_run.pull_requests[0].number || inputs.pr }}",
    );
  });
});

describe("modified P1 workflows", () => {
  it("ci.yml judges risk-tier with the base commit's factory code", () => {
    const job = load("ci.yml").jobs["risk-tier"]!;
    const checkout = job.steps.find((s) => s.uses?.startsWith("actions/checkout@"))!;
    expect(checkouts(job)).toHaveLength(1);
    expect(checkout.with?.ref).toBe("${{ github.event.pull_request.base.sha }}");
    expect(checkout.with?.["persist-credentials"]).toBe(false);
    const run = job.steps.find((s) => s.run?.includes("factory risk --pr"))!;
    expect(run.run).toContain("--check");
    // spec 7.1.1: base에 CLI가 없으면 건너뛰던 P2 도입용 분기를 지웠다. CLI가 사라지면 체크가 실패해야 한다.
    expect(run.run).not.toContain("cli.ts");
    expect(run.run?.trim()).toBe('pnpm -s factory risk --pr "$PR" --check');
    expect(run["working-directory"]).toBe(checkout.with?.path);
    expect(checkout.with?.path).toBe("base");
  });

  it("preview.yml deploys only when the policy job allows it", () => {
    const wf = load("preview.yml");
    expect(wf.jobs.deploy!.needs).toBe("policy");
    expect(wf.jobs.deploy!.if).toContain("needs.policy.outputs.allowed == 'true'");
    const checkout = wf.jobs.policy!.steps.find((s) => s.uses?.startsWith("actions/checkout@"))!;
    expect(checkout.with?.ref).toBe("${{ github.event.pull_request.base.sha }}");
    const risk = wf.jobs.policy!.steps.find((s) => s.run?.includes("factory risk --pr"))!;
    expect(risk.run).toContain("--json");
    expect(risk.run).not.toContain("cli.ts");
    expect(risk.run).not.toMatch(/allowed=true/);
    // 이벤트의 head SHA로 판정을 묶는다. PR head가 그 사이 바뀌었으면 CLI가 previewAllowed=false를 낸다.
    expect(risk.run).toContain('--sha "$HEAD_SHA"');
    expect(risk.env?.HEAD_SHA).toBe("${{ github.event.pull_request.head.sha }}");
    expect(JSON.stringify(wf.jobs.policy)).not.toMatch(/CLOUDFLARE/);
  });

  it("preview.yml: PR-code jobs never persist credentials; e2e-preview is read-only; deploy passes the token explicitly (I-1)", () => {
    const wf = load("preview.yml");
    for (const name of ["deploy", "e2e-preview", "smoke-preview"]) {
      for (const step of checkouts(wf.jobs[name]!)) {
        expect(step.with?.["persist-credentials"], name).toBe(false);
      }
    }
    expect(wf.jobs["e2e-preview"]!.permissions).toEqual({ contents: "read" });
    expect(wf.jobs["smoke-preview"]!.permissions).toEqual({ contents: "read" });
    expect(wf.jobs.deploy!.permissions).toEqual({ contents: "write", "pull-requests": "write" });
    const action = wf.jobs.deploy!.steps.find((s) =>
      s.uses?.startsWith("rossjrw/pr-preview-action"),
    )!;
    expect(action.with?.token).toBe("${{ secrets.GITHUB_TOKEN }}");
  });

  it("preview.yml runs the production read-only smoke against the PR preview (PR #65)", () => {
    const wf = load("preview.yml");
    const job = wf.jobs["smoke-preview"]!;
    expect(job.needs).toBe("deploy");
    const runs = job.steps.map((s) => s.run ?? "").join("\n");
    expect(runs).toContain('hurl --test --variable "api=$API_URL/api" tests/smoke/readonly.hurl');
    expect(runs).toContain("playwright test -c e2e-smoke/playwright.config.ts");
    const web = job.steps.find((s) => s.run?.includes("e2e-smoke/playwright.config.ts"))!;
    expect(web.env?.E2E_BASE_URL).toBe("${{ env.WEB_PREVIEW_URL }}");
    expect(JSON.stringify(job)).not.toMatch(/secrets\./);
  });

  it("deploy and preview confirm the new build by commit SHA, not by the site name", () => {
    const preview = load("preview.yml");
    const build = preview.jobs.deploy!.steps.find((s) => s.name === "Build web")!;
    expect(build.env?.VITE_BUILD_SHA).toBe("${{ github.event.pull_request.head.sha }}");
    for (const name of ["e2e-preview", "smoke-preview"]) {
      const reach = preview.jobs[name]!.steps.find((s) => s.name?.startsWith("Confirm preview"))!;
      expect(reach.run, name).toContain('content=\\"$HEAD_SHA\\"');
      expect(reach.env?.HEAD_SHA).toBe("${{ github.event.pull_request.head.sha }}");
    }
    const deploy = load("deploy.yml");
    const steps = Object.values(deploy.jobs).flatMap((j) => j.steps ?? []);
    const web = steps.find((s) => s.run === "pnpm --filter web build")!;
    expect(web.env?.VITE_BUILD_SHA).toBe("${{ github.sha }}");
    const index = steps.find((s) => s.name?.startsWith("Web index"))!;
    expect(index.run).toContain("${{ github.sha }}");
    expect(index.run).not.toMatch(/Conduit|Conveyor/);
  });

  it("factory-merge re-runs the gate when the preview workflow completes", () => {
    const wf = load("factory-merge.yml");
    const on = wf.on as { workflow_run: { workflows: string[] } };
    expect(on.workflow_run.workflows).toEqual(["ci", "preview"]);
  });

  it("preview.yml: every checkout drops credentials; cleanup runs trusted default-branch code with an explicit token (FR-b)", () => {
    const wf = load("preview.yml");
    for (const [name, job] of Object.entries(wf.jobs)) {
      for (const step of checkouts(job)) {
        expect(step.with?.["persist-credentials"], name).toBe(false);
      }
    }
    const cleanup = wf.jobs.cleanup!;
    expect(checkouts(cleanup)[0]!.with?.ref).toBe("${{ github.event.repository.default_branch }}");
    const remove = cleanup.steps.find((s) => s.uses?.startsWith("rossjrw/pr-preview-action"))!;
    expect(remove.with?.token).toBe("${{ secrets.GITHUB_TOKEN }}");
  });

  it("factory-merge.yml runs on-closed for every closed bot PR, merged or not (I-2)", () => {
    const job = load("factory-merge.yml").jobs.closed!;
    expect(job.if).not.toContain("merged");
    expect(job.if).toContain("startsWith(github.event.pull_request.head.ref, 'factory/')");
  });

  it("deploy.yml reports deploy results back to factory issues", () => {
    const job = load("deploy.yml").jobs["factory-report"]!;
    expect(job.needs).toEqual(["api", "web", "smoke"]);
    expect(
      job.steps.some(
        (s) => s.run?.includes("factory deployed") && s.run.includes("factory deploy-failed"),
      ),
    ).toBe(true);
    expect(job.environment).toBeUndefined();
    expect(JSON.stringify(job)).not.toMatch(/CLOUDFLARE/);
  });

  it("declare an environment on every job that uses Cloudflare secrets", () => {
    for (const file of ALL) {
      for (const [name, job] of Object.entries(load(file).jobs)) {
        if (/secrets\.CLOUDFLARE/.test(JSON.stringify(job))) {
          expect(["production", "preview"], `${file} ${name}`).toContain(job.environment);
        }
      }
    }
  });
});

describe("P3 intake workflows", () => {
  it("factory-intake.yml runs main's CLI with the production INTAKE_TOKEN only in the intake step", () => {
    const wf = load("factory-intake.yml");
    expect(Object.keys(wf.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(wf.concurrency).toEqual({ group: "factory-intake", "cancel-in-progress": false });
    expect(Object.keys(wf.jobs)).toEqual(["intake"]);
    const job = wf.jobs.intake!;
    expect(job.if).toBe("github.ref == 'refs/heads/main'");
    expect(job.environment).toBe("production");
    expect(job.permissions).toEqual({ contents: "read" });
    expect(checkouts(job)).toHaveLength(1);
    expect(checkouts(job)[0]!.with).toMatchObject({ ref: "main", "persist-credentials": false });
    const run = job.steps.find((s) => s.run?.includes("pnpm -s factory intake"))!;
    expect(run.env?.INTAKE_TOKEN).toBe("${{ secrets.INTAKE_TOKEN }}");
    expect(run.env?.FACTORY_TOKEN).toBe("${{ steps.app.outputs.token }}");
    expect(run.env?.INTAKE_URL).toBe(
      "https://sfd-api.${{ vars.WORKERS_SUBDOMAIN }}.workers.dev/api",
    );
    expect(JSON.stringify(job.steps.filter((s) => s !== run))).not.toContain("INTAKE_TOKEN");
  });

  it("factory-smoke.yml checks production without secrets and reports with an App token", () => {
    const wf = load("factory-smoke.yml");
    expect(Object.keys(wf.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(wf.concurrency).toEqual({ group: "factory-smoke", "cancel-in-progress": false });
    expect(Object.keys(wf.jobs)).toEqual(["target", "checks", "report"]);
    const checks = wf.jobs.checks!;
    const report = wf.jobs.report!;
    expect(checks.permissions).toEqual({ contents: "read" });
    expect(checks.environment).toBeUndefined();
    expect(JSON.stringify(checks)).not.toMatch(
      /secrets\.|create-github-app-token|FACTORY_TOKEN|INTAKE_TOKEN/,
    );
    for (const s of checkouts(checks)) {
      expect(s.with).toMatchObject({ ref: "main", "persist-credentials": false });
    }
    expect(checks.steps.some((s) => s.run?.includes("tests/smoke/readonly.hurl"))).toBe(true);
    expect(checks.steps.some((s) => s.run?.includes("e2e-smoke/playwright.config.ts"))).toBe(true);
    expect(report.needs).toEqual(["target", "checks"]);
    expect(report.if).toContain("!cancelled()");
    expect(report.if).toContain("needs.target.result == 'success'");
    const run = report.steps.find((s) => s.run?.includes("pnpm -s factory smoke-report"))!;
    expect(run.run).toContain('--result "$RESULT"');
    // F6: 취소·시간 초과도 실패로 넘겨, 스모크 실패가 이슈 없이 사라지지 않게 한다.
    expect(run.env?.RESULT).toBe(
      "${{ needs.checks.result == 'success' && 'success' || 'failure' }}",
    );
    expect(run.env?.SMOKE_API_BASE).toBe("${{ inputs.api_base }}");
  });

  it("factory-smoke.yml hands the failing output tail from checks to report by artifact id", () => {
    const wf = load("factory-smoke.yml");
    const checks = wf.jobs.checks!;
    const report = wf.jobs.report!;
    const hurl = checks.steps.find((s) => s.run?.includes("tests/smoke/readonly.hurl"))!;
    const web = checks.steps.find((s) => s.run?.includes("e2e-smoke/playwright.config.ts"))!;
    // 출력을 파일로 남기되 tee 때문에 실패가 성공으로 바뀌지 않게 한다.
    for (const s of [hurl, web]) {
      expect(s.id).toBeTruthy();
      expect(s.run).toContain("set -o pipefail");
      expect(s.run).toMatch(/2>&1 \| tee "\$RUNNER_TEMP\/smoke\//);
    }
    const excerpt = checks.steps.find((s) => s.id === "excerpt")!;
    expect(excerpt.if).toBe("${{ !cancelled() }}");
    expect(excerpt.env).toEqual({
      HURL_OUTCOME: `\${{ steps.${hurl.id}.outcome }}`,
      WEB_OUTCOME: `\${{ steps.${web.id}.outcome }}`,
    });
    expect(excerpt.run).toContain("tail -n 40");
    expect(excerpt.run).toMatch(/head -c \d+/);
    const upload = checks.steps.find((s) => s.uses?.startsWith("actions/upload-artifact@"))!;
    expect(upload.id).toBe("excerpt-upload");
    expect(upload.if).toContain("steps.excerpt.outputs.found == 'true'");
    expect(checks.outputs?.["excerpt-artifact-id"]).toBe(
      "${{ steps.excerpt-upload.outputs.artifact-id }}",
    );
    const download = report.steps.find((s) => s.uses?.startsWith("actions/download-artifact@"))!;
    expect(download.if).toBe("${{ needs.checks.outputs.excerpt-artifact-id != '' }}");
    expect(download.with?.["artifact-ids"]).toBe("${{ needs.checks.outputs.excerpt-artifact-id }}");
    expect(report.steps.indexOf(download)).toBeLessThan(
      report.steps.findIndex((s) => s.uses?.startsWith("actions/create-github-app-token@")),
    );
    const run = report.steps.find((s) => s.run?.includes("pnpm -s factory smoke-report"))!;
    expect(run.run).toContain('--excerpt-file "$RUNNER_TEMP/smoke-in/smoke-excerpt.txt"');
    // 권한 분리는 그대로다: report도 contents: read만 받는다.
    expect(report.permissions).toEqual({ contents: "read" });
  });

  it("factory-smoke.yml accepts an api_base override only under the production API, before any check runs", () => {
    const wf = load("factory-smoke.yml");
    const target = wf.jobs.target!;
    expect(target.permissions).toEqual({});
    expect(checkouts(target)).toHaveLength(0);
    expect(JSON.stringify(target)).not.toMatch(/secrets\./);
    expect(target.env?.PROD_API).toBe(
      "https://sfd-api.${{ vars.WORKERS_SUBDOMAIN }}.workers.dev/api",
    );
    const reject = target.steps.find((s) => s.run?.trim() === "exit 1")!;
    expect(reject.if).toContain("inputs.api_base != ''");
    expect(reject.if).toContain("inputs.api_base != env.PROD_API");
    expect(reject.if).toContain("!startsWith(inputs.api_base, format('{0}/', env.PROD_API))");
    expect(wf.jobs.checks!.needs).toBe("target");
    expect(wf.jobs.checks!.env?.API_BASE).toBe(
      "${{ inputs.api_base || format('https://sfd-api.{0}.workers.dev/api', vars.WORKERS_SUBDOMAIN) }}",
    );
  });

  it("deploy.yml syncs INTAKE_TOKEN into the Worker through stdin before deploying, without printing it (F5)", () => {
    const job = load("deploy.yml").jobs.api!;
    expect(job.environment).toBe("production");
    const index = job.steps.findIndex((s) => s.run?.includes("wrangler secret put INTAKE_TOKEN"));
    const step = job.steps[index]!;
    expect(step.run).toContain(
      `printf '%s' "$INTAKE_TOKEN" | pnpm exec wrangler secret put INTAKE_TOKEN`,
    );
    expect(step.run).toContain('test -n "$INTAKE_TOKEN"');
    expect(step.run).not.toMatch(/\becho\b/);
    expect(step.env?.INTAKE_TOKEN).toBe("${{ secrets.INTAKE_TOKEN }}");
    expect(step["working-directory"]).toBe("apps/api");
    const deploy = job.steps.findIndex((s) => s.run?.trim() === "pnpm exec wrangler deploy");
    expect(deploy).toBeGreaterThan(index);
    const others = job.steps.filter((_, i) => i !== index);
    expect(JSON.stringify(others)).not.toContain("INTAKE_TOKEN");
  });

  it("never hand INTAKE_TOKEN to preview Workers or other workflows (T9-a)", () => {
    const allowed = new Set(["deploy.yml", "factory-intake.yml"]);
    for (const file of ALL) {
      if (allowed.has(file)) continue;
      expect(readFileSync(path.join(DIR, file), "utf8"), file).not.toContain("INTAKE_TOKEN");
    }
  });
});

describe("evidence gate (P3)", () => {
  const BASE_SHA = "${{ github.event.pull_request.base.sha }}";

  it("plans evidence with the base commit's CLI and a read-only token, without checking out PR code", () => {
    const job = load("ci.yml").jobs["evidence-plan"]!;
    expect(job.if).toBe("github.event_name == 'pull_request'");
    expect(job.permissions).toEqual({ contents: "read", "pull-requests": "read", issues: "read" });
    expect(job["timeout-minutes"]).toBeGreaterThan(0);
    expect(checkouts(job)).toHaveLength(1);
    expect(checkouts(job)[0]!.with).toMatchObject({
      ref: BASE_SHA,
      path: "base",
      "persist-credentials": false,
    });
    const step = job.steps.find((s) => s.run?.includes("pnpm -s factory evidence --pr"))!;
    expect(step["working-directory"]).toBe("base");
    expect(step.run).toContain('--sha "$HEAD_SHA" --base "$BASE_SHA" --json');
    expect(step.env?.HEAD_SHA).toBe("${{ github.event.pull_request.head.sha }}");
    expect(step.env?.BASE_SHA).toBe(BASE_SHA);
    expect(job.outputs?.plan).toBe("${{ steps.plan.outputs.plan }}");
  });

  it("runs PR tests in a job with no secrets or tokens, and fails instead of skipping when planning failed", () => {
    const job = load("ci.yml").jobs.evidence!;
    expect(job.needs).toBe("evidence-plan");
    expect(job.if).toContain("!cancelled()");
    expect(job.if).toContain("github.event_name == 'pull_request'");
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job.environment).toBeUndefined();
    expect(job["timeout-minutes"]).toBeGreaterThan(0);
    expect(JSON.stringify(job)).not.toMatch(
      /secrets\.|GITHUB_TOKEN|GH_TOKEN|FACTORY_TOKEN|create-github-app-token/,
    );
    for (const s of checkouts(job)) expect(s.with?.["persist-credentials"]).toBe(false);
    const base = checkouts(job).find((s) => s.with?.path === "base")!;
    const head = checkouts(job).find((s) => s.with?.path === "head")!;
    expect(base.with?.ref).toBe(BASE_SHA);
    expect(head.with?.ref).toBe("${{ github.event.pull_request.head.sha }}");
    expect(head.with?.["fetch-depth"]).toBe(0);
    const run = job.steps.find((s) => s.run?.includes("pnpm -s factory evidence-run"))!;
    expect(run["working-directory"]).toBe("base");
    expect(run.env).toEqual({
      EVIDENCE_PLAN: "${{ needs.evidence-plan.outputs.plan }}",
      FACTORY_WORKDIR: "${{ github.workspace }}/head",
    });
    // PR 코드가 있는 head/에서는 의존성을 설치하지 않는다. 설치는 evidence-run이 scrubEnv로 한다.
    for (const s of job.steps.filter((x) => x.run?.includes("pnpm install"))) {
      expect(s["working-directory"]).toBe("base");
    }
  });

  it("runs eval-run with the base commit's factory code and no secrets", () => {
    const ci = load("ci.yml");
    const plan = ci.jobs["eval-plan"]!;
    const run = ci.jobs.eval!;
    expect(checkouts(plan)[0]!.with?.ref).toBe(BASE_SHA);
    expect(run.needs).toBe("eval-plan");
    expect(run.if).toContain("!cancelled()");
    expect(run.permissions).toEqual({ contents: "read" });
    expect(JSON.stringify(run)).not.toMatch(/secrets\.|GITHUB_TOKEN/);
    const step = run.steps.find((s) => s.run?.includes("pnpm -s factory eval-run"))!;
    expect(step["working-directory"]).toBe("base");
    expect(step.env).toMatchObject({
      EVAL_PLAN: "${{ needs.eval-plan.outputs.plan }}",
      EVAL_BASE_DIR: "${{ github.workspace }}/base",
      FACTORY_WORKDIR: "${{ github.workspace }}/head",
    });
  });

  it("produces every required check of factory/risk-policy.yml as a ci.yml job that runs on pull requests", () => {
    const jobs = load("ci.yml").jobs;
    const required = loadRiskPolicy().requiredChecks;
    expect(required).toContain("evidence");
    expect(required).toContain("eval");
    for (const name of required) {
      expect(jobs[name], name).toBeDefined();
      expect(jobs[name]!.if ?? "", name).not.toMatch(/event_name == 'push'/);
    }
  });
});
