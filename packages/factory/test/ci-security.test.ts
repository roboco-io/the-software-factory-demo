import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { REPO_ROOT } from "../src/paths";
import { loadRiskPolicy } from "../src/policy/risk";

interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
interface Job {
  if?: string;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  steps: Step[];
}
const ci = parse(readFileSync(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as {
  on: Record<string, unknown>;
  jobs: Record<string, Job>;
};
const NEW = ["codeql", "deps-audit", "secrets"] as const;
const runs = (job: Job) => job.steps.map((s) => s.run ?? "").join("\n");
const checkouts = (job: Job) => job.steps.filter((s) => s.uses?.startsWith("actions/checkout@"));

describe("ci security jobs", () => {
  it("run on pull_request and push", () => {
    expect(ci.on).toHaveProperty("pull_request");
    expect(ci.on).toHaveProperty("push");
    for (const name of NEW) {
      expect(ci.jobs[name], name).toBeDefined();
      expect(ci.jobs[name]!.if ?? "", name).not.toMatch(/event_name/);
    }
  });

  it("requiredChecks lists codeql, deps-audit, secrets", () => {
    expect(loadRiskPolicy().requiredChecks).toEqual(
      expect.arrayContaining(["codeql", "deps-audit", "secrets"]),
    );
  });

  it("codeql job has security-events: write, actions: read, contents: read and runs sarif-gate", () => {
    const job = ci.jobs.codeql!;
    expect(job.permissions).toEqual({
      "security-events": "write",
      actions: "read",
      contents: "read",
    });
    const init = job.steps.find((s) => s.uses?.startsWith("github/codeql-action/init@"))!;
    expect(init.with).toMatchObject({
      languages: "javascript-typescript",
      "build-mode": "none",
      queries: "security-extended",
    });
    const analyze = job.steps.find((s) => s.uses?.startsWith("github/codeql-action/analyze@"))!;
    expect(analyze.with).toMatchObject({ output: "sarif-results" });
    expect(runs(job)).toContain("node scripts/sarif-gate.mjs sarif-results");
  });

  it("secrets job checks out with fetch-depth 0 and persist-credentials false and uses factory/security/gitleaks.toml", () => {
    const job = ci.jobs.secrets!;
    expect(job.permissions).toEqual({ contents: "read" });
    expect(checkouts(job)[0]!.with).toMatchObject({
      "fetch-depth": 0,
      "persist-credentials": false,
    });
    expect(runs(job)).toContain("factory/security/gitleaks.toml");
    expect(runs(job)).toMatch(/--redact/);
    expect(runs(job)).toMatch(/--exit-code 1/);
    expect(JSON.stringify(job.env)).toMatch(/ghcr\.io\/gitleaks\/gitleaks:v\d+\.\d+\.\d+/);
  });

  it("no job uses gitleaks/gitleaks-action", () => {
    expect(JSON.stringify(ci)).not.toContain("gitleaks/gitleaks-action");
  });

  it("deps-audit runs pnpm audit --audit-level=high", () => {
    const job = ci.jobs["deps-audit"]!;
    expect(runs(job)).toContain("pnpm audit --audit-level=high");
    expect(job.permissions).toEqual({ contents: "read" });
  });

  it("fail closed: persist-credentials false, no continue-on-error, no || true", () => {
    for (const name of NEW) {
      const job = ci.jobs[name]!;
      expect(JSON.stringify(job), name).not.toMatch(/\|\| true|continue-on-error/);
      for (const s of checkouts(job)) {
        expect(s.with?.["persist-credentials"], name).toBe(false);
      }
    }
  });

  it("pins actions to a version tag", () => {
    for (const name of NEW) {
      for (const s of ci.jobs[name]!.steps.filter((x) => x.uses)) {
        expect(s.uses, name).toMatch(/@v\d+(\.\d+)*$/);
      }
    }
  });
});
