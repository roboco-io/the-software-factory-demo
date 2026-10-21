import { describe, expect, it } from "vitest";
import {
  addedLinesFromPatch,
  deletedLinesFromPatch,
  classifyFiles,
  loadRiskPolicy,
  parseRiskPolicy,
  tierOf,
  type ChangedFile,
} from "../src/policy/risk";

const policy = loadRiskPolicy();

describe("tierOf with factory/risk-policy.yml", () => {
  it.each([
    ["docs/guide.md", "T0"],
    ["README.md", "T0"],
    ["apps/api/README.md", "T0"],
    ["apps/web/src/copy/home.ts", "T0"],
    ["apps/api/src/routes/tags.ts", "T1"],
    ["apps/api/test/deferred.test.ts", "T1"],
    ["apps/web/src/pages/Home.tsx", "T1"],
    ["tests/forum/skip.txt", "T1"],
    ["apps/api/src/routes/feedback.ts", "T2"],
    ["apps/api/src/lib/error-events.ts", "T2"],
    ["apps/api/src/index.ts", "T2"],
    ["apps/web/e2e/feedback.spec.ts", "T1"],
    ["apps/api/migrations/0003_intake.sql", "T2"],
    ["apps/api/src/routes/intake.ts", "T2"],
    ["apps/api/src/middleware/intake.ts", "T2"],
    ["tests/smoke/readonly.hurl", "T3"],
    ["apps/web/e2e-smoke/home.spec.ts", "T3"],
    ["apps/api/migrations/0002_favorites.sql", "T2"],
    ["apps/api/src/auth/session.ts", "T2"],
    ["apps/api/src/middleware/auth.ts", "T2"],
    ["apps/api/src/lib/password.ts", "T2"],
    ["apps/api/src/lib/token.ts", "T2"],
    ["package.json", "T2"],
    ["apps/web/package.json", "T2"],
    ["pnpm-lock.yaml", "T2"],
    ["apps/api/wrangler.json", "T2"],
    ["apps/api/wrangler.toml", "T2"],
    ["apps/web/wrangler.jsonc", "T2"],
    ["apps/api/.dev.vars", "T2"],
    [".dev.vars", "T2"],
    ["apps/api/src/routes/users.ts", "T2"],
    ["eslint.config.js", "T2"],
    ["apps/api/AGENTS.md", "T3"],
    ["apps/web/src/CLAUDE.md", "T3"],
    ["packages/foo/docs/AGENTS.md", "T3"],
    [".claude/settings.json", "T3"],
    [".claude/skills/x/SKILL.md", "T3"],
    [".agents/config.yml", "T3"],
    [".agents/notes.md", "T3"],
    ["apps/web/.claude/settings.json", "T3"],
    ["packages/foo/.claude/skills/x/SKILL.md", "T3"],
    ["apps/api/.agents/config.yml", "T3"],
    [".github/workflows/ci.yml", "T3"],
    [".github/CODEOWNERS", "T3"],
    ["factory/agents.yml", "T3"],
    ["packages/factory/src/cli.ts", "T3"],
    ["AGENTS.md", "T3"],
    ["CLAUDE.md", "T3"],
    ["AGENTS.override.md", "T3"],
    ["apps/web/AGENTS.override.md", "T3"],
    ["CLAUDE.local.md", "T3"],
    ["apps/api/CLAUDE.local.md", "T3"],
    ["agents.md", "T3"],
    ["apps/api/Claude.MD", "T3"],
    ["apps/web/agents.override.md", "T3"],
    [".GitHub/workflows/x.yml", "T3"],
    ["scripts/forum-api.sh", "T3"],
    ["tests/forum/vendor/topics.hurl", "T3"],
    ["tests/forum/vendor/fixtures/book-v1/website/content-manifest.json", "T3"],
  ])("%s → %s", (file, tier) => {
    expect(tierOf(file, policy).tier).toBe(tier);
  });

  it("normalizes ./ prefixes, leading slashes and backslashes", () => {
    expect(tierOf("./AGENTS.md", policy).file).toBe("AGENTS.md");
    expect(tierOf("/apps/api/migrations/0002_x.sql", policy).tier).toBe("T2");
    expect(tierOf("apps\\api\\src\\routes\\tags.ts", policy).tier).toBe("T1");
  });

  it("reports the deciding pattern, or null for the default tier", () => {
    expect(tierOf("apps/api/migrations/0002_x.sql", policy).pattern).toBe("apps/api/migrations/**");
    expect(tierOf("eslint.config.js", policy).pattern).toBeNull();
  });
});

describe("classifyFiles", () => {
  it("uses the highest file tier as the PR tier", () => {
    const r = classifyFiles(
      ["README.md", "apps/api/src/routes/tags.ts", "apps/api/migrations/0002_x.sql"],
      policy,
    );
    expect(r.tier).toBe("T2");
    expect(r.files.map((f) => f.tier)).toEqual(["T0", "T1", "T2"]);
  });

  it("treats an empty change set as T0 and removes duplicates", () => {
    expect(classifyFiles([], policy)).toEqual({ tier: "T0", files: [] });
    expect(classifyFiles(["README.md", "./README.md"], policy).files).toHaveLength(1);
  });

  it("lists required checks including risk-tier, evidence and eval", () => {
    expect(policy.requiredChecks).toEqual([
      "typecheck",
      "lint",
      "unit",
      "forum-api",
      "e2e",
      "risk-tier",
      "evidence",
      "eval",
    ]);
  });

  it("rejects a policy without rules or with an unknown tier", () => {
    expect(() => parseRiskPolicy("default: T2\nrequiredChecks: [x]\nrules: []\n")).toThrow();
    expect(() =>
      parseRiskPolicy("default: T9\nrequiredChecks: [x]\nrules: [{tier: T0, patterns: [a]}]\n"),
    ).toThrow();
  });
});

describe("ChangedFile additions (F21)", () => {
  it("extracts added lines from a unified diff patch", () => {
    const patch = "@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+tags:favorite\n";
    expect(addedLinesFromPatch(patch)).toEqual(["new", "tags:favorite"]);
    expect(addedLinesFromPatch(undefined)).toEqual([]);
  });

  it("keeps an added line whose content starts with ++ (F22)", () => {
    expect(addedLinesFromPatch("@@ -1 +1,2 @@\n keep\n+++x\n+++ b/y\n+ok\n")).toEqual([
      "++x",
      "++ b/y",
      "ok",
    ]);
    expect(addedLinesFromPatch("--- a/f\n+++ b/f\n@@ -1 +1 @@\n+z\n")).toEqual(["z"]);
  });

  it("carries additions on a changed file", () => {
    const f: ChangedFile = { filename: "tests/forum/skip.txt", additions: ["x.hurl"] };
    expect(f.additions).toEqual(["x.hurl"]);
    expect(tierOf(f.filename, policy).tier).toBe("T1");
  });
});

describe("deletedLinesFromPatch", () => {
  it("extracts removed lines from hunks only", () => {
    expect(deletedLinesFromPatch("@@ -1,3 +1,2 @@\n keep\n-old\n---x\n+new\n")).toEqual([
      "old",
      "--x",
    ]);
    expect(deletedLinesFromPatch(undefined)).toEqual([]);
  });
});
