import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/paths";
import { loadRiskPolicy, tierOf } from "../src/policy/risk";

const rules = readFileSync(path.join(REPO_ROOT, ".github/CODEOWNERS"), "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"))
  .map((l) => {
    const [pattern = "", ...owners] = l.split(/\s+/);
    return { pattern, owners };
  });

// CODEOWNERS(gitignore 규칙)의 부분집합을 지원한다. 앞이나 중간에 "/"가 있으면 루트 기준이고,
// 끝의 "/"는 디렉토리 아래 전부, 그 밖에는 어느 깊이의 이름과도 일치한다. "*"는 "/"를 넘지 않는다.
function matches(pattern: string, file: string): boolean {
  const dir = pattern.endsWith("/");
  const body = pattern.replace(/^\//, "").replace(/\/$/, "");
  const anchored = pattern.startsWith("/") || body.includes("/");
  const glob = `${anchored ? "" : "**/"}${body}`;
  return picomatch.isMatch(file, dir ? `${glob}/**` : [glob, `${glob}/**`], { dot: true });
}

function ownersOf(file: string): string[] {
  let owners: string[] = [];
  for (const r of rules) if (matches(r.pattern, file)) owners = r.owners;
  return owners;
}

// 정책 패턴마다 그 패턴에 걸리는 대표 경로를 만든다(루트와 하위 디렉토리 모두).
function samplesOf(pattern: string): string[] {
  const fill = (p: string) => p.replace(/\/\*\*$/, "/a/b.ts").replace(/\*/g, "zz");
  return pattern.startsWith("**/")
    ? [fill(pattern.slice(3)), fill(`x/y/${pattern.slice(3)}`)]
    : [fill(pattern)];
}

describe(".github/CODEOWNERS", () => {
  const policy = loadRiskPolicy();

  it.each([
    ".github/workflows/ci.yml",
    ".github/CODEOWNERS",
    "factory/risk-policy.yml",
    "packages/factory/src/cli.ts",
    "AGENTS.md",
    "CLAUDE.md",
    "apps/web/AGENTS.md",
    "apps/api/src/CLAUDE.md",
    "AGENTS.override.md",
    "apps/web/AGENTS.override.md",
    "CLAUDE.local.md",
    "apps/api/CLAUDE.local.md",
    "agents.md",
    "apps/web/agents.override.md",
    ".claude/settings.json",
    "apps/web/.claude/settings.json",
    "apps/api/.agents/config.yml",
    ".agents/skills/x.md",
    "scripts/realworld-api.sh",
    "tests/realworld/vendor/tags.hurl",
    "tests/realworld/UPSTREAM.txt",
    "tests/forum/vendor/topics.hurl",
    "tests/smoke/readonly.hurl",
    "apps/web/e2e-smoke/home.spec.ts",
    "apps/web/e2e-smoke/playwright.config.ts",
    "apps/api/migrations/0002_favorites.sql",
    "apps/api/src/auth/session.ts",
    "apps/api/src/middleware/auth.ts",
    "apps/api/src/lib/password.ts",
    "apps/api/src/lib/token.ts",
    "apps/api/src/routes/users.ts",
    "apps/api/wrangler.json",
    "apps/api/wrangler.preview.json",
    "apps/web/wrangler.toml",
    "apps/api/.dev.vars",
    "package.json",
    "apps/web/package.json",
    "packages/factory/package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "eslint.config.js",
    "tsconfig.base.json",
    ".nvmrc",
    ".prettierrc.json",
    ".prettierignore",
    ".gitignore",
    "tests/smoke/readonly.hurl",
    "apps/web/e2e-smoke/home.spec.ts",
    "apps/web/e2e-smoke/playwright.config.ts",
    "apps/api/src/middleware/intake.ts",
    "apps/api/src/routes/intake.ts",
    "apps/api/src/routes/feedback.ts",
    "apps/api/src/lib/error-events.ts",
    "apps/api/src/index.ts",
    "apps/api/migrations/0003_intake.sql",
  ])("requires @serithemage for T2/T3 path %s", (file) => {
    expect(["T2", "T3"]).toContain(tierOf(file, policy).tier);
    expect(ownersOf(file)).toEqual(["@serithemage"]);
  });

  it("covers every T2/T3 pattern in factory/risk-policy.yml", () => {
    const patterns = policy.rules
      .filter((r) => r.tier === "T2" || r.tier === "T3")
      .flatMap((r) => r.patterns);
    expect(patterns.length).toBeGreaterThan(10);
    for (const pattern of patterns) {
      for (const file of samplesOf(pattern)) {
        expect(["T2", "T3"], `${pattern} -> ${file}`).toContain(tierOf(file, policy).tier);
        expect(ownersOf(file), `${pattern} -> ${file}`).toEqual(["@serithemage"]);
      }
    }
  });

  it("covers every tracked file that the policy rates T2 or T3, including default-T2 root files", () => {
    const files = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    const uncovered = files.filter(
      (f) => ["T2", "T3"].includes(tierOf(f, policy).tier) && ownersOf(f).length === 0,
    );
    expect(uncovered).toEqual([]);
  });

  it("does not require a human for T1 application code", () => {
    expect(ownersOf("apps/api/src/routes/tags.ts")).toEqual([]);
    expect(ownersOf("tests/realworld/skip.txt")).toEqual([]);
    expect(ownersOf("tests/forum/skip.txt")).toEqual([]);
    expect(ownersOf("docs/notes.md")).toEqual([]);
  });
});
