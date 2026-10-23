import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { REPO_ROOT } from "../src/paths";

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  "continue-on-error"?: boolean;
}
interface Job {
  needs?: string | string[];
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  "timeout-minutes"?: number;
  steps: Step[];
}

const wf = parse(readFileSync(path.join(REPO_ROOT, ".github/workflows/deploy.yml"), "utf8")) as {
  jobs: Record<string, Job>;
};
const smoke = wf.jobs.smoke!;
const PLAYWRIGHT = "playwright test -c e2e-smoke/playwright.config.ts";
const idx = (pred: (s: Step) => boolean) => smoke.steps.findIndex(pred);

describe("deploy.yml smoke job (Playwright 스모크)", () => {
  const wait = idx((s) => /seq 1 30/.test(s.run ?? ""));
  const pw = idx((s) => (s.run ?? "").includes(PLAYWRIGHT));

  it("SHA 반영 대기 뒤에 Playwright 스모크를 실행한다", () => {
    expect(wait).toBeGreaterThanOrEqual(0);
    expect(pw).toBeGreaterThan(wait);
    expect(
      idx((s) => (s.run ?? "").includes("playwright install --with-deps chromium")),
    ).toBeGreaterThan(wait);
    expect(idx((s) => (s.run ?? "").includes("pnpm install --frozen-lockfile"))).toBeGreaterThan(
      wait,
    );
  });

  it("E2E_BASE_URL을 vars.WEB_URL로 준다", () => {
    const env = { ...smoke.env, ...smoke.steps[pw]!.env };
    expect(env.E2E_BASE_URL).toBe("${{ vars.WEB_URL }}");
  });

  it("권한은 contents: read뿐이고 체크아웃은 토큰을 남기지 않는다", () => {
    expect(smoke.permissions).toEqual({ contents: "read" });
    const co = smoke.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
    expect(co?.with?.["persist-credentials"]).toBe(false);
    expect(smoke["timeout-minutes"]).toBeGreaterThan(0);
  });

  it("스모크 단계는 실패를 숨기지 않는다", () => {
    for (const s of smoke.steps) {
      expect(s["continue-on-error"]).toBeUndefined();
      expect(s.run ?? "").not.toMatch(/\|\|\s*true/);
    }
  });

  it("factory-report는 smoke에 의존하고 실패하면 deploy-failed를 실행한다", () => {
    const report = wf.jobs["factory-report"]!;
    expect(report.needs).toContain("smoke");
    const run = report.steps.map((s) => s.run ?? "").join("\n");
    expect(run).toContain('factory deploy-failed --sha "$GITHUB_SHA"');
    expect(run).toContain('"$SMOKE" = "success"');
  });
});
