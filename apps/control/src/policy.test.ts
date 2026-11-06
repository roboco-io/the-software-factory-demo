import { describe, expect, it } from "vitest";
import {
  classifyPullRequest,
  matchesPattern,
  parsePolicy,
  tierOfPath,
  type Policy,
} from "./policy";

const GOOD = `
requiredChecks:
  - test
  - lint
autoMergeTiers: [T0, T1]
rules:
  - tier: T0
    patterns: ["docs/**", "*.md"]
  - tier: T1
    patterns: ["src/**/*.test.ts"]
  - tier: T3
    patterns: ["infra/**"]
`;
const policy = (): Policy => {
  const r = parsePolicy(GOOD);
  if (!r.ok) throw new Error("fixture policy must parse");
  return r.policy;
};

describe("parsePolicy", () => {
  it("accepts the documented schema", () => {
    expect(policy()).toEqual({
      requiredChecks: [
        { name: "test", appId: 15368 },
        { name: "lint", appId: 15368 },
      ],
      autoMergeTiers: ["T0", "T1"],
      rules: [
        { tier: "T0", patterns: ["docs/**", "*.md"] },
        { tier: "T1", patterns: ["src/**/*.test.ts"] },
        { tier: "T3", patterns: ["infra/**"] },
      ],
    });
  });

  it("accepts a per-check appId next to plain names", () => {
    const r = parsePolicy(
      "requiredChecks:\n  - lint\n  - {name: deploy, appId: 42}\nautoMergeTiers: []\nrules: []\n",
    );
    expect(r).toMatchObject({
      ok: true,
      policy: {
        requiredChecks: [
          { name: "lint", appId: 15368 },
          { name: "deploy", appId: 42 },
        ],
      },
    });
  });

  it.each<[string, string]>([
    [
      "check object without name",
      "requiredChecks: [{appId: 1}]\nautoMergeTiers: []\nrules: []\n",
    ],
    [
      "check object with unknown key",
      "requiredChecks: [{name: a, app: 1}]\nautoMergeTiers: []\nrules: []\n",
    ],
    [
      "check appId as string",
      "requiredChecks: [{name: a, appId: '1'}]\nautoMergeTiers: []\nrules: []\n",
    ],
    [
      "check appId zero",
      "requiredChecks: [{name: a, appId: 0}]\nautoMergeTiers: []\nrules: []\n",
    ],
    [
      "check appId fractional",
      "requiredChecks: [{name: a, appId: 1.5}]\nautoMergeTiers: []\nrules: []\n",
    ],
    ["empty text", ""],
    ["not YAML", "{{{"],
    ["a list at the root", "- a\n- b\n"],
    ["unknown top-level key", `${GOOD}\nextra: true\n`],
    ["missing requiredChecks", "autoMergeTiers: []\nrules: []\n"],
    [
      "empty requiredChecks",
      "requiredChecks: []\nautoMergeTiers: []\nrules: []\n",
    ],
    [
      "requiredChecks with a number",
      "requiredChecks: [1]\nautoMergeTiers: []\nrules: []\n",
    ],
    [
      "unknown tier name",
      "requiredChecks: [a]\nautoMergeTiers: [T9]\nrules: []\n",
    ],
    [
      "lowercase tier name",
      "requiredChecks: [a]\nautoMergeTiers: [t0]\nrules: []\n",
    ],
    [
      "rule without patterns",
      "requiredChecks: [a]\nautoMergeTiers: []\nrules:\n  - tier: T0\n",
    ],
    [
      "rule with empty patterns",
      "requiredChecks: [a]\nautoMergeTiers: []\nrules:\n  - tier: T0\n    patterns: []\n",
    ],
    [
      "rule with unknown key",
      "requiredChecks: [a]\nautoMergeTiers: []\nrules:\n  - tier: T0\n    patterns: ['a']\n    note: x\n",
    ],
    [
      "absolute pattern",
      "requiredChecks: [a]\nautoMergeTiers: []\nrules:\n  - tier: T0\n    patterns: ['/etc/**']\n",
    ],
    [
      "pattern with ..",
      "requiredChecks: [a]\nautoMergeTiers: []\nrules:\n  - tier: T0\n    patterns: ['a/../b']\n",
    ],
    [
      "duplicate keys",
      "requiredChecks: [a]\nrequiredChecks: [b]\nautoMergeTiers: []\nrules: []\n",
    ],
    [
      "a YAML alias",
      "requiredChecks: &a [T0]\nautoMergeTiers: *a\nrules: []\n",
    ],
    [
      "an anchor on an unknown key",
      "base: &b {tier: T0}\nrequiredChecks: [a]\nautoMergeTiers: []\nrules: []\n",
    ],
    ["two documents", `${GOOD}\n---\n${GOOD}`],
    [
      "too large",
      `requiredChecks: [a]\nautoMergeTiers: []\nrules: []\n# ${"x".repeat(70_000)}\n`,
    ],
  ])("rejects %s", (_name, text) => {
    expect(parsePolicy(text)).toEqual({ ok: false });
  });
});

describe("matchesPattern", () => {
  it.each<[string, string, boolean]>([
    ["docs/**", "docs/a.md", true],
    ["docs/**", "docs/x/y/z.md", true],
    ["docs/**", "docsx/a.md", false],
    ["docs/**", "a/docs/a.md", false],
    ["*.md", "README.md", true],
    ["*.md", "docs/README.md", false],
    ["**/*.md", "docs/README.md", true],
    ["**/*.md", "README.md", true],
    ["src/*.ts", "src/a.ts", true],
    ["src/*.ts", "src/x/a.ts", false],
    ["src/?.ts", "src/a.ts", true],
    ["src/?.ts", "src/ab.ts", false],
    ["docs/**", "DOCS/A.MD", true],
    ["DOCS/**", "docs/a.md", true],
    ["a.b", "axb", false],
    ["a+b(c)", "a+b(c)", true],
  ])("%s vs %s is %s", (pattern, path, expected) => {
    expect(matchesPattern(pattern, path)).toBe(expected);
  });
});

describe("tiers", () => {
  it("uses the first matching rule and defaults to T2 when none matches", () => {
    const p = policy();
    expect(tierOfPath("docs/a.md", p)).toBe("T0");
    expect(tierOfPath("src/a.test.ts", p)).toBe("T1");
    expect(tierOfPath("src/a.ts", p)).toBe("T2");
    expect(tierOfPath("infra/main.tf", p)).toBe("T3");
    const ordered: Policy = {
      ...p,
      rules: [
        { tier: "T3", patterns: ["docs/secret/**"] },
        { tier: "T0", patterns: ["docs/**"] },
      ],
    };
    expect(tierOfPath("docs/secret/a.md", ordered)).toBe("T3");
    expect(tierOfPath("docs/open/a.md", ordered)).toBe("T0");
    const reversed: Policy = { ...p, rules: [...ordered.rules].reverse() };
    expect(tierOfPath("docs/secret/a.md", reversed)).toBe("T0");
  });

  it("gives a pull request the highest tier of its files", () => {
    const p = policy();
    expect(
      classifyPullRequest(
        [{ filename: "docs/a.md" }, { filename: "README.md" }],
        p,
      ),
    ).toBe("T0");
    expect(
      classifyPullRequest(
        [{ filename: "docs/a.md" }, { filename: "src/a.ts" }],
        p,
      ),
    ).toBe("T2");
    expect(
      classifyPullRequest(
        [{ filename: "docs/a.md" }, { filename: "infra/x" }],
        p,
      ),
    ).toBe("T3");
  });

  it("counts the old path of a renamed file", () => {
    expect(
      classifyPullRequest(
        [{ filename: "docs/a.md", previousFilename: "infra/a.md" }],
        policy(),
      ),
    ).toBe("T3");
  });

  it("treats a pull request without files as T3", () => {
    expect(classifyPullRequest([], policy())).toBe("T3");
  });

  it(".github tier floor: files under .github and .factory are at least T3 whatever the rules say", () => {
    const lax: Policy = {
      requiredChecks: [{ name: "test", appId: 15368 }],
      autoMergeTiers: ["T0"],
      rules: [{ tier: "T0", patterns: ["**"] }],
    };
    for (const path of [
      ".github/workflows/ci.yml",
      ".GitHub/Workflows/ci.yml",
      ".github/CODEOWNERS",
      ".factory/policy.yml",
      ".FACTORY/policy.yml",
      ".github./workflows/ci.yml",
      ".github /workflows/ci.yml",
    ]) {
      expect(tierOfPath(path, lax), path).toBe("T3");
    }
    expect(tierOfPath("docs/a.md", lax)).toBe("T0");
    expect(tierOfPath("github/a.md", lax)).toBe("T0");
    expect(
      classifyPullRequest(
        [{ filename: "docs/a.md" }, { filename: ".github/workflows/ci.yml" }],
        lax,
      ),
    ).toBe("T3");
    expect(
      classifyPullRequest(
        [{ filename: "docs/b.md", previousFilename: ".github/x.yml" }],
        lax,
      ),
    ).toBe("T3");
  });
});
