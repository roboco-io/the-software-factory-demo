import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { REPO_ROOT } from "../src/paths";

interface Step {
  id?: string;
  run?: string;
  env?: Record<string, string>;
}
interface Wf {
  jobs: Record<string, { permissions?: Record<string, string>; steps: Step[] }>;
}

describe("factory-smoke.yml last-success lookup", () => {
  const wf = parse(
    readFileSync(path.join(REPO_ROOT, ".github/workflows/factory-smoke.yml"), "utf8"),
  ) as Wf;
  const report = wf.jobs.report!;

  it("lets report read workflow runs and pass the time through env, never inline", () => {
    expect(report.permissions).toEqual({ contents: "read", actions: "read" });
    const lookup = report.steps.find((s) => s.id === "last-success")!;
    expect(lookup.run).toContain("gh run list --workflow factory-smoke.yml");
    expect(lookup.run).toContain("--event schedule");
    expect(lookup.run).toContain("--status success");
    expect(lookup.run).not.toContain("${{");
    expect(lookup.run).toContain('|| ts=""');
    expect(lookup.env?.GH_TOKEN).toBe("${{ github.token }}");
    const run = report.steps.find((s) => s.run?.includes("pnpm -s factory smoke-report"))!;
    expect(run.run).toContain('--last-success "$LAST_SUCCESS"');
    expect(run.run).not.toContain("${{");
    expect(run.env?.LAST_SUCCESS).toBe("${{ steps.last-success.outputs.value }}");
  });
});
