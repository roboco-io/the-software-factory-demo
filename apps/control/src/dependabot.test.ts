import { describe, expect, it } from "vitest";
import {
  DEPENDABOT_USER_ID,
  judgeDependabotPr,
  parseBump,
  type DependabotPr,
  type JudgeInput,
} from "./dependabot";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-20T00:00:00Z");

const pr = (over: Partial<DependabotPr> = {}): DependabotPr => ({
  number: 143,
  title: "chore(deps): bump hono from 4.13.13 to 4.13.16",
  author: { id: DEPENDABOT_USER_ID, login: "dependabot[bot]", type: "Bot" },
  draft: false,
  headSha: "a".repeat(40),
  sameRepo: true,
  baseRef: "main",
  defaultBranch: "main",
  labels: [],
  ...over,
});

const input = (over: Partial<JudgeInput> = {}): JudgeInput => ({
  pr: pr(),
  commits: [{ authorId: DEPENDABOT_USER_ID, committedAt: NOW - 4 * DAY }],
  files: ["apps/api/package.json", "pnpm-lock.yaml"],
  filesTruncated: false,
  alerts: [{ package: "hono", patched: "4.13.16" }],
  checks: "success",
  now: NOW,
  minAgeMs: 3 * DAY,
  ...over,
});

describe("parseBump", () => {
  it.each([
    ["chore(deps): bump hono from 4.13.13 to 4.13.16", "hono"],
    ["Bump hono from 4.13.13 to 4.13.16", "hono"],
    [
      "chore(deps-dev): bump @vitest/mocker from 4.1.10 to 4.1.12 in /apps/api",
      "@vitest/mocker",
    ],
  ])("reads %s", (title, name) => {
    expect(parseBump(title)?.package).toBe(name);
  });

  it.each([
    "chore(deps): bump the npm group with 3 updates",
    "bump hono and zod",
    "bump hono from 4.13.13 to 4.13.16\nbump zod from 1.0.0 to 9.0.0",
    "fix: something else",
    "",
  ])("does not read %j", (title) => {
    expect(parseBump(title)).toBeNull();
  });
});

describe("judgeDependabotPr", () => {
  it("merges a patch security update with passing checks after the waiting period", () => {
    expect(judgeDependabotPr(input())).toEqual({ action: "merge" });
  });

  it("merges a minor update of a 1.x or later package", () => {
    expect(
      judgeDependabotPr(
        input({
          pr: pr({ title: "bump hono from 4.13.13 to 4.14.0" }),
          alerts: [{ package: "hono", patched: "4.13.16" }],
        }),
      ),
    ).toEqual({ action: "merge" });
  });

  it.each<[string, Partial<DependabotPr>]>([
    ["another account", { author: { id: 1, login: "x", type: "User" } }],
    [
      "a look-alike login",
      { author: { id: 5, login: "dependabot[bot]", type: "Bot" } },
    ],
    ["a fork", { sameRepo: false }],
    ["another base branch", { baseRef: "release" }],
    ["a draft", { draft: true }],
  ])("skips %s", (_name, over) => {
    expect(judgeDependabotPr(input({ pr: pr(over) })).action).toBe("skip");
  });

  it.each<[string, Partial<JudgeInput>, string]>([
    [
      "a grouped update",
      { pr: pr({ title: "bump the npm group with 3 updates" }) },
      "not_single_update",
    ],
    [
      "a commit by someone else",
      {
        commits: [
          { authorId: DEPENDABOT_USER_ID, committedAt: NOW - 4 * DAY },
          { authorId: 3435720, committedAt: NOW - 4 * DAY },
        ],
      },
      "foreign_commit",
    ],
    ["no commits", { commits: [] }, "foreign_commit"],
    [
      "a major update",
      {
        pr: pr({ title: "bump hono from 4.13.13 to 5.0.0" }),
        alerts: [{ package: "hono", patched: "5.0.0" }],
      },
      "major_update",
    ],
    [
      "a 0.x minor update",
      {
        pr: pr({ title: "bump tiny from 0.3.1 to 0.4.0" }),
        alerts: [{ package: "tiny", patched: "0.4.0" }],
      },
      "major_update",
    ],
    [
      "a prerelease version",
      { pr: pr({ title: "bump hono from 4.13.13 to 4.13.16-rc.1" }) },
      "version_unreadable",
    ],
    [
      "a downgrade",
      { pr: pr({ title: "bump hono from 4.13.16 to 4.13.13" }) },
      "version_unreadable",
    ],
    ["no alert for the package", { alerts: [] }, "not_security_update"],
    [
      "an alert for another package",
      { alerts: [{ package: "zod", patched: "4.13.16" }] },
      "not_security_update",
    ],
    [
      "a target below the patched version",
      { alerts: [{ package: "hono", patched: "4.13.17" }] },
      "not_security_update",
    ],
    [
      "an alert without a patched version",
      { alerts: [{ package: "hono", patched: null }] },
      "not_security_update",
    ],
    [
      "a file outside the manifests",
      { files: ["pnpm-lock.yaml", "apps/api/src/index.ts"] },
      "unexpected_files",
    ],
    [
      "a workflow file",
      { files: ["pnpm-lock.yaml", ".github/workflows/ci.yml"] },
      "unexpected_files",
    ],
    [
      "a file only named like a manifest",
      { files: ["apps/api/not-package.json"] },
      "unexpected_files",
    ],
    ["no files", { files: [] }, "unexpected_files"],
    ["a cut-off file list", { filesTruncated: true }, "unexpected_files"],
    ["a failed check", { checks: "failed" }, "check_failed"],
  ])("hands %s to a person", (_name, over, code) => {
    expect(judgeDependabotPr(input(over))).toEqual({
      action: "needs_human",
      code,
    });
  });

  it("waits while checks run", () => {
    expect(judgeDependabotPr(input({ checks: "pending" }))).toEqual({
      action: "wait",
      code: "checks_pending",
    });
  });

  it("waits until the newest commit is older than the waiting period", () => {
    expect(
      judgeDependabotPr(
        input({
          commits: [
            { authorId: DEPENDABOT_USER_ID, committedAt: NOW - 9 * DAY },
            { authorId: DEPENDABOT_USER_ID, committedAt: NOW - 2 * DAY },
          ],
        }),
      ),
    ).toEqual({ action: "wait", code: "too_new" });
  });

  it("treats a commit time in the future as too new", () => {
    expect(
      judgeDependabotPr(
        input({
          commits: [{ authorId: DEPENDABOT_USER_ID, committedAt: NOW + DAY }],
        }),
      ),
    ).toEqual({ action: "wait", code: "too_new" });
  });

  it("reports a problem that needs a person before it waits", () => {
    expect(
      judgeDependabotPr(input({ alerts: [], checks: "pending" })).action,
    ).toBe("needs_human");
  });
});
