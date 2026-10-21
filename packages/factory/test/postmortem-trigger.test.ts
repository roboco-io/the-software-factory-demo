import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/paths";
import { moveTo } from "../src/stages/common";
import { kindFromLabels, requestPostmortem } from "../src/stages/postmortem-trigger";
import { makeTestDeps } from "./helpers";

const stall = (issue: number) => ({
  file: "factory-postmortem.yml",
  inputs: { issue: String(issue), kind: "stall", event: "detected" },
});

describe("requestPostmortem", () => {
  it("dispatches factory-postmortem.yml with string inputs", async () => {
    const h = makeTestDeps();
    await requestPostmortem(h.deps, { issue: 7, kind: "smoke", event: "recovered" });
    expect(h.gh.dispatches).toEqual([
      {
        file: "factory-postmortem.yml",
        inputs: { issue: "7", kind: "smoke", event: "recovered" },
      },
    ]);
  });

  it("never throws when the dispatch fails", async () => {
    const h = makeTestDeps();
    h.gh.dispatchWorkflow = async () => {
      throw new Error("dispatch down");
    };
    await expect(
      requestPostmortem(h.deps, { issue: 7, kind: "error", event: "detected" }),
    ).resolves.toBeUndefined();
  });
});

describe("kindFromLabels", () => {
  it("maps each production label to its incident kind and anything else to stall", () => {
    expect(kindFromLabels(["source:smoke", "factory:needs-human"])).toBe("smoke");
    expect(kindFromLabels(["source:deploy"])).toBe("deploy");
    expect(kindFromLabels(["type:bug", "source:error"])).toBe("error");
    expect(kindFromLabels(["factory:needs-human"])).toBe("stall");
  });

  it("is what the closed-issue event uses: the workflow passes auto, not a label guess (#66)", () => {
    const wf = readFileSync(path.join(REPO_ROOT, ".github/workflows/factory-postmortem.yml"), "utf8");
    expect(wf).toMatch(/^\s+KIND: \$\{\{ inputs\.kind \|\| 'auto' \}\}$/m);
  });
});

describe("moveTo stall trigger", () => {
  it("dispatches a stall postmortem when the factory moves an issue to needs-human", async () => {
    const h = makeTestDeps();
    const i = h.gh.addIssue({ title: "a", labels: ["factory:in-review"] });
    expect(await moveTo(h.deps, i.number, "needs-human", "gate", "x")).toBe(true);
    expect(h.gh.dispatches).toEqual([stall(i.number)]);
  });

  it("does not start a postmortem for @factory stop", async () => {
    const h = makeTestDeps();
    const i = h.gh.addIssue({ title: "a", labels: ["factory:in-review"] });
    expect(await moveTo(h.deps, i.number, "needs-human", "command", "x")).toBe(true);
    expect(h.gh.dispatches).toEqual([]);
  });

  it("still moves the issue when the postmortem dispatch fails", async () => {
    const h = makeTestDeps();
    h.gh.dispatchWorkflow = async () => {
      throw new Error("dispatch down");
    };
    const i = h.gh.addIssue({ title: "a", labels: ["factory:in-review"] });
    expect(await moveTo(h.deps, i.number, "needs-human", "gate", "x")).toBe(true);
    expect((await h.gh.getIssue(i.number)).labels).toEqual(["factory:needs-human"]);
  });

  it("does not dispatch when the transition is ignored", async () => {
    const h = makeTestDeps();
    const i = h.gh.addIssue({ title: "a", labels: ["factory:deployed"] });
    expect(await moveTo(h.deps, i.number, "needs-human", "gate")).toBe(false);
    expect(h.gh.dispatches).toEqual([]);
  });
});
