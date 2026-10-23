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
  "working-directory"?: string;
}
interface Job {
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

const wf = parse(
  readFileSync(path.join(REPO_ROOT, ".github/workflows/deploy.yml"), "utf8"),
) as Workflow;
const needs = (job: Job) => [job.needs ?? []].flat();

describe("deploy.yml provenance (T4)", () => {
  it("provenance needs api and web", () => {
    expect(needs(wf.jobs.provenance!).sort()).toEqual(["api", "web"]);
  });

  it("provenance has id-token: write, attestations: write, contents: read", () => {
    expect(wf.jobs.provenance!.permissions).toEqual({
      "id-token": "write",
      attestations: "write",
      contents: "read",
    });
  });

  it("factory-report does not need provenance", () => {
    expect(needs(wf.jobs["factory-report"]!)).not.toContain("provenance");
    expect(needs(wf.jobs.smoke!)).not.toContain("provenance");
  });

  it("api deploy uses --outdir dist-worker and uploads worker-bundle", () => {
    const job = wf.jobs.api!;
    const deploy = job.steps.findIndex((s) =>
      /^pnpm exec wrangler deploy --outdir dist-worker$/.test(s.run?.trim() ?? ""),
    );
    expect(deploy).toBeGreaterThanOrEqual(0);
    const up = job.steps.findIndex(
      (s) => s.uses?.startsWith("actions/upload-artifact@") && s.with?.name === "worker-bundle",
    );
    expect(up).toBeGreaterThan(deploy);
    expect(job.steps[up]!.with?.path).toBe("apps/api/dist-worker");
  });

  it("web uploads web-dist before gh-pages publish", () => {
    const job = wf.jobs.web!;
    const up = job.steps.findIndex(
      (s) => s.uses?.startsWith("actions/upload-artifact@") && s.with?.name === "web-dist",
    );
    const publish = job.steps.findIndex((s) => s.uses?.startsWith("peaceiris/actions-gh-pages@"));
    expect(up).toBeGreaterThanOrEqual(0);
    expect(publish).toBeGreaterThan(up);
    expect(job.steps[up]!.with?.path).toBe("apps/web/dist");
  });

  it("top-level permissions unchanged", () => {
    expect(wf.permissions).toEqual({ contents: "write" });
  });

  it("artifact attested is the artifact built: provenance downloads the uploads and attests them", () => {
    const job = wf.jobs.provenance!;
    const names = job.steps
      .filter((s) => s.uses?.startsWith("actions/download-artifact@"))
      .map((s) => s.with?.name)
      .sort();
    expect(names).toEqual(["web-dist", "worker-bundle"]);
    expect(
      job.steps.some(
        (s) => s.uses?.startsWith("actions/upload-artifact@") && s.with?.name === "sbom",
      ),
    ).toBe(true);
    const prov = job.steps.filter((s) => s.uses?.startsWith("actions/attest-build-provenance@"));
    const withs = JSON.stringify(prov.map((s) => s.with));
    expect(withs).toContain("web-dist.tgz");
    expect(withs).toContain("worker-bundle");
    expect(job.steps.filter((s) => s.uses?.startsWith("actions/attest-sbom@")).length).toBe(2);
    const gen = job.steps.find((s) => s.uses?.startsWith("anchore/sbom-action@"))!;
    expect(gen.with?.format).toBe("spdx-json");
  });

  it("only provenance holds id-token or attestations permissions", () => {
    for (const [name, job] of Object.entries(wf.jobs)) {
      if (name === "provenance") continue;
      expect(job.permissions?.["id-token"], name).toBeUndefined();
      expect(job.permissions?.attestations, name).toBeUndefined();
    }
  });
});
