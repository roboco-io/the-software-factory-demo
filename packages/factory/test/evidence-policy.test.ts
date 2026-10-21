import { describe, expect, it } from "vitest";
import { isSafeRelativePath, isTestFile, planSuites } from "../src/policy/evidence";

describe("isTestFile", () => {
  it.each([
    ["apps/api/test/favorites.test.ts", true],
    ["apps/api/test/helpers.ts", true],
    ["apps/web/src/components/ErrorList.test.tsx", true],
    ["apps/web/src/lib/markdown.test.ts", true],
    ["apps/web/e2e/smoke.spec.ts", true],
    ["packages/factory/test/gate.test.ts", true],
    ["apps/api/src/routes/tags.ts", false],
    ["apps/web/e2e-smoke/home.spec.ts", false],
    ["tests/forum/skip.txt", false],
    ["apps/api/test/../../../etc/passwd", false],
    ["apps/api/test/./a.test.ts", false],
    ["/etc/a.test.ts", false],
    ["apps/api/test/a\nb.test.ts", false],
    ["apps\\api\\test\\a.test.ts", false],
    ["apps/api/test/--config=evil.test.ts", false],
    ["apps/api/test/-x/a.test.ts", false],
    ["", false],
  ])("%j → %s", (file, expected) => {
    expect(isTestFile(file)).toBe(expected);
  });
});

describe("isSafeRelativePath", () => {
  it("rejects any segment starting with a dash (would parse as a vitest option)", () => {
    expect(isSafeRelativePath("apps/api/test/-a.test.ts")).toBe(false);
    expect(isSafeRelativePath("-apps/api/test/a.test.ts")).toBe(false);
    expect(isSafeRelativePath("apps/api/test/a-b.test.ts")).toBe(true);
  });
});

describe("isSafeRelativePath character set", () => {
  it.each([
    ["apps/api/test/a b.test.ts", false],
    ["apps/api/test/a\u0007.test.ts", false],
    ["apps/api/test/a\u202e.test.ts", false],
    ["apps/api/test/한글.test.ts", false],
    ["apps/api/test/a\\b.test.ts", false],
    ["apps/api/test/a_b@1+x.test.ts", true],
  ])("%j → %s", (file, expected) => {
    expect(isSafeRelativePath(file)).toBe(expected);
  });
});

describe("planSuites", () => {
  it("groups runnable test files by workspace package and reports what it cannot run", () => {
    expect(
      planSuites([
        "apps/api/test/favorites.test.ts",
        "apps/api/test/helpers.ts",
        "apps/web/src/components/ArticleList.test.tsx",
        "apps/web/e2e/smoke.spec.ts",
        "packages/factory/test/gate.test.ts",
        "tools/x.test.ts",
      ]),
    ).toEqual({
      runs: [
        { suite: "api", filter: "api", targets: ["test/favorites.test.ts"] },
        { suite: "web", filter: "web", targets: ["src/components/ArticleList.test.tsx"] },
        { suite: "factory", filter: "factory", targets: ["test/gate.test.ts"] },
      ],
      unsupported: ["apps/web/e2e/smoke.spec.ts", "tools/x.test.ts"],
    });
  });

  it("returns no runs when only helpers or e2e specs changed", () => {
    expect(planSuites(["apps/api/test/helpers.ts", "apps/web/e2e/a.spec.ts"])).toEqual({
      runs: [],
      unsupported: ["apps/web/e2e/a.spec.ts"],
    });
  });
});
