import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runProcess, type SpawnFn } from "../src/exec/process";
import { renderEvidenceText, runEvidence, type EvidencePlan } from "../src/stages/evidence";
import { makeTestDeps, type TestHarness } from "./helpers";

const SRC = "apps/web/src/pages.ts";
const TEST = "apps/web/src/pages.test.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
}

function put(dir: string, file: string, content: string): void {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), content);
}

// base: 버그가 있는 코드와 예전 테스트. head: 고친 코드와 새 재현 테스트.
// head 테스트 내용은 아래 가짜 vitest의 규칙을 따른다(기본: SRC가 Math.ceil이면 통과).
function setup(opts: { headTest?: string; headExtra?: (dir: string) => void } = {}): {
  h: TestHarness;
  base: string;
  head: string;
} {
  const h = makeTestDeps({
    settings: { env: { PATH: process.env.PATH, HOME: process.env.HOME } },
  });
  git(h.dir, "init", "-q", "-b", "main");
  put(h.dir, SRC, "export const pages = (n: number) => Math.floor(n / 10);\n");
  put(h.dir, TEST, "// base test\n");
  git(h.dir, "add", "-A");
  git(h.dir, "commit", "-qm", "base");
  const base = git(h.dir, "rev-parse", "HEAD");
  put(h.dir, SRC, "export const pages = (n: number) => Math.ceil(n / 10);\n");
  put(h.dir, TEST, opts.headTest ?? HEAD_TEST);
  opts.headExtra?.(h.dir);
  git(h.dir, "add", "-A");
  git(h.dir, "commit", "-qm", "head");
  return { h, base, head: git(h.dir, "rev-parse", "HEAD") };
}

const HEAD_TEST = "// head reproduction test\n";

interface Seen {
  where: "base" | "head";
  args: string[];
  src: string;
  test: string;
}

// vitest 4.1.11의 `--reporter=json` 출력과 같은 모양(실제 실행으로 확인한 필드만 쓴다).
// 파일을 수집하지 못하면 assertionResults가 비고 message에 오류가 들어간다.
// 규칙: 파일이 없거나 "EXCLUDED"를 담으면 보고서에 없다(수집되지 않음).
// `from "./x"`가 가리키는 파일이 없으면 수집 오류. "always-pass"/"always-fail"은 그대로, 그 밖에는 SRC가 Math.ceil이면 통과.
function simulateVitest(cwd: string, pkgDir: string, targets: string[]) {
  const testResults = [];
  for (const t of targets) {
    const abs = path.join(cwd, pkgDir, t);
    if (!existsSync(abs)) continue;
    const content = readFileSync(abs, "utf8");
    if (content.includes("EXCLUDED")) continue;
    const missing = [...content.matchAll(/from "\.\/([\w-]+)"/g)].find(
      (m) => !existsSync(path.join(path.dirname(abs), `${m[1]}.ts`)),
    );
    if (missing) {
      testResults.push({
        assertionResults: [],
        status: "failed",
        name: abs,
        message: `Cannot find module './${missing[1]}' imported from ${abs}`,
      });
      continue;
    }
    const pass = content.includes("always-pass")
      ? true
      : content.includes("always-fail")
        ? false
        : readFileSync(path.join(cwd, SRC), "utf8").includes("Math.ceil");
    testResults.push({
      assertionResults: [
        {
          ancestorTitles: [],
          fullName: "pages",
          status: pass ? "passed" : "failed",
          title: "pages",
          failureMessages: pass ? [] : ["expected 2 to be 1"],
        },
      ],
      status: pass ? "passed" : "failed",
      name: abs,
      message: "",
    });
  }
  return { numTotalTests: testResults.length, success: true, testResults };
}

const readIf = (f: string): string => (existsSync(f) ? readFileSync(f, "utf8") : "");

type ReportMode = "sim" | "none" | "garbage";

// git은 실제로 실행하고, pnpm install은 성공한다. vitest는 가짜로 JSON 보고서를 쓴다.
function fakeSpawn(
  h: TestHarness,
  seen: Seen[],
  opts: {
    codes?: { base?: number | null; head?: number | null };
    report?: { base?: ReportMode; head?: ReportMode };
  } = {},
): SpawnFn {
  return async (cmd, args, spawnOpts) => {
    if (cmd === "git") return runProcess(cmd, args, spawnOpts);
    if (args[0] === "install") return { code: 0, stdout: "", stderr: "" };
    const where = spawnOpts.cwd === h.dir ? "head" : "base";
    seen.push({
      where,
      args: [...args],
      src: readIf(path.join(spawnOpts.cwd, SRC)),
      test: readIf(path.join(spawnOpts.cwd, TEST)),
    });
    const out = args.find((a) => a.startsWith("--outputFile.json="))?.slice(18);
    const targets = args.slice(args.indexOf("run") + 1).filter((a) => !a.startsWith("-"));
    const report = simulateVitest(spawnOpts.cwd, "apps/web/", targets);
    const mode = opts.report?.[where] ?? "sim";
    if (out !== undefined && mode === "sim") writeFileSync(out, JSON.stringify(report));
    if (out !== undefined && mode === "garbage") writeFileSync(out, '{"testResults": 3}');
    const failed = report.testResults.some((r) => r.status !== "passed");
    const code = opts.codes?.[where] !== undefined ? opts.codes[where]! : failed ? 1 : 0;
    return { code, stdout: `${where} vitest`, stderr: "" };
  };
}

const plan = (base: string, head: string, over: Partial<EvidencePlan> = {}): EvidencePlan => ({
  pr: 7,
  required: true,
  reason: "연결 이슈 #6가 type:bug다.",
  reasonCode: "evaluated",
  baseSha: base,
  headSha: head,
  testFiles: [TEST],
  ...over,
});

describe("runEvidence", () => {
  it("runs the head test on the base tree (must fail) and on the head tree (must pass)", async () => {
    const { h, base, head } = setup();
    const seen: Seen[] = [];
    h.deps.spawn = fakeSpawn(h, seen);
    const r = await runEvidence(h.deps, plan(base, head));
    expect(r.reason).toContain("수정 전(base) 코드에서 실패하고");
    expect(r.ok).toBe(true);
    expect(r.reasonCode).toBe("evaluated");
    expect(seen.map((s) => s.where)).toEqual(["base", "head"]);
    // base 트리에는 버그 코드가 그대로 있고, 테스트만 head 버전으로 덮였다.
    expect(seen[0]!.src).toContain("Math.floor");
    expect(seen[0]!.test).toBe(HEAD_TEST);
    expect(seen[1]!.src).toContain("Math.ceil");
    const args = seen[0]!.args;
    expect(args.slice(0, 5)).toEqual(["--filter", "web", "exec", "vitest", "run"]);
    expect(args).toContain("--reporter=default");
    expect(args).toContain("--reporter=json");
    expect(args.at(-1)).toBe("src/pages.test.ts");
    // 보고서는 두 트리 밖에 쓴다.
    const out = args.find((a) => a.startsWith("--outputFile.json="))!.slice(18);
    expect(path.isAbsolute(out)).toBe(true);
    expect(out.startsWith(`${h.dir}${path.sep}`)).toBe(false);
    expect(r.suites).toMatchObject([{ suite: "web", baseCode: 1, headCode: 0 }]);
    // 임시 worktree는 정리된다.
    expect(git(h.dir, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("fails when the reproduction test also passes on the base tree", async () => {
    const { h, base, head } = setup({ headTest: "// always-pass\n" });
    h.deps.spawn = fakeSpawn(h, []);
    const r = await runEvidence(h.deps, plan(base, head));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("수정 전(base) 코드에서도 통과");
  });

  it("fails when the test does not pass on the head tree", async () => {
    const { h, base, head } = setup({ headTest: "// always-fail\n" });
    h.deps.spawn = fakeSpawn(h, []);
    const r = await runEvidence(h.deps, plan(base, head));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("수정 후(head) 코드에서 실패");
  });

  // 판정 T3-b: base의 0이 아닌 종료 코드가 아니라 단언 실패여야 한다.
  it("fails when the base run cannot collect the test because it imports a module the PR adds", async () => {
    const { h, base, head } = setup({
      headTest: 'import { x } from "./newmod";\n// always-pass\n',
      headExtra: (dir) => put(dir, "apps/web/src/newmod.ts", "export const x = 1;\n"),
    });
    h.deps.spawn = fakeSpawn(h, []);
    const r = await runEvidence(h.deps, plan(base, head));
    expect(r.suites).toMatchObject([{ baseCode: 1, headCode: 0 }]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("base에서 테스트를 실행할 수 없다(수집 오류)");
  });

  it("fails when a target is not collected on the head tree", async () => {
    const { h, base, head } = setup({ headTest: "// EXCLUDED by config\n" });
    h.deps.spawn = fakeSpawn(h, []);
    const r = await runEvidence(h.deps, plan(base, head));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("수집되지 않았다");
    expect(r.reason).toContain("src/pages.test.ts");
  });

  it("does not count a substring match of another file as the target", async () => {
    // pages.test.ts 대신 다른 파일만 보고서에 있으면 대상이 실행된 것이 아니다.
    const { h, base, head } = setup();
    const inner = fakeSpawn(h, []);
    h.deps.spawn = async (cmd, args, o) => {
      const r = await inner(cmd, args, o);
      const out = args.find((a) => a.startsWith("--outputFile.json="))?.slice(18);
      if (out !== undefined && existsSync(out)) {
        const rep = JSON.parse(readFileSync(out, "utf8")) as { testResults: { name: string }[] };
        for (const t of rep.testResults) t.name = t.name.replace("pages.test.ts", "xpages.test.ts");
        writeFileSync(out, JSON.stringify(rep));
      }
      return r;
    };
    const r = await runEvidence(h.deps, plan(base, head));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("수집되지 않았다");
  });

  it("fails closed when the JSON report is missing or malformed", async () => {
    for (const report of [{ head: "none" }, { base: "garbage" }] as const) {
      const { h, base, head } = setup();
      h.deps.spawn = fakeSpawn(h, [], { report });
      const r = await runEvidence(h.deps, plan(base, head));
      expect(r.ok).toBe(false);
      expect(r.reason).toContain("결과 보고서");
    }
  });

  it("rejects a head test file that is a symlink, before running anything", async () => {
    const { h, base, head } = setup({
      headExtra: (dir) => symlinkSync("pages.test.ts", path.join(dir, "apps/web/src/link.test.ts")),
    });
    const seen: Seen[] = [];
    h.deps.spawn = fakeSpawn(h, seen);
    const r = await runEvidence(
      h.deps,
      plan(base, head, { testFiles: [TEST, "apps/web/src/link.test.ts"] }),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("일반 파일(100644)이 아니다");
    expect(seen).toEqual([]);
    expect(git(h.dir, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("rejects an overlay target whose directory resolves outside the base tree", async () => {
    // base 트리에서 apps/web/src2가 트리 밖을 가리키는 심볼릭 링크다.
    const outside = mkdtempSync(path.join(tmpdir(), "evidence-outside-"));
    const h = makeTestDeps({
      settings: { env: { PATH: process.env.PATH, HOME: process.env.HOME } },
    });
    git(h.dir, "init", "-q", "-b", "main");
    put(h.dir, SRC, "export const pages = 1;\n");
    symlinkSync(outside, path.join(h.dir, "apps/web/src2"));
    git(h.dir, "add", "-A");
    git(h.dir, "commit", "-qm", "base");
    const base = git(h.dir, "rev-parse", "HEAD");
    git(h.dir, "rm", "-q", "apps/web/src2");
    put(h.dir, "apps/web/src2/a.test.ts", "// always-pass\n");
    git(h.dir, "add", "-A");
    git(h.dir, "commit", "-qm", "head");
    const head = git(h.dir, "rev-parse", "HEAD");
    const seen: Seen[] = [];
    h.deps.spawn = fakeSpawn(h, seen);
    const r = await runEvidence(
      h.deps,
      plan(base, head, { testFiles: ["apps/web/src2/a.test.ts"] }),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("안전하지 않은 테스트 파일 경로");
    expect(existsSync(path.join(outside, "a.test.ts"))).toBe(false);
    expect(seen).toEqual([]);
  });

  it("does not write through an overlay target that is a symlink in the base tree", async () => {
    // base 트리에서 apps/web/src/a.test.ts가 트리 밖 파일을 가리키는 심볼릭 링크다.
    const outsideDir = mkdtempSync(path.join(tmpdir(), "evidence-outside-"));
    const outside = path.join(outsideDir, "victim.txt");
    writeFileSync(outside, "original\n");
    const h = makeTestDeps({
      settings: { env: { PATH: process.env.PATH, HOME: process.env.HOME } },
    });
    git(h.dir, "init", "-q", "-b", "main");
    put(h.dir, SRC, "export const pages = 1;\n");
    symlinkSync(outside, path.join(h.dir, "apps/web/src/a.test.ts"));
    git(h.dir, "add", "-A");
    git(h.dir, "commit", "-qm", "base");
    const base = git(h.dir, "rev-parse", "HEAD");
    git(h.dir, "rm", "-q", "apps/web/src/a.test.ts");
    put(h.dir, "apps/web/src/a.test.ts", "// always-pass\n");
    git(h.dir, "add", "-A");
    git(h.dir, "commit", "-qm", "head");
    const head = git(h.dir, "rev-parse", "HEAD");
    const seen: Seen[] = [];
    h.deps.spawn = fakeSpawn(h, seen);
    const r = await runEvidence(
      h.deps,
      plan(base, head, { testFiles: ["apps/web/src/a.test.ts"] }),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("안전하지 않은 테스트 파일 경로");
    expect(readFileSync(outside, "utf8")).toBe("original\n");
    expect(seen).toEqual([]);
  });

  it("does not count a killed or timed-out base run as a reproduction", async () => {
    const { h, base, head } = setup();
    h.deps.spawn = fakeSpawn(h, [], { codes: { base: null } });
    const r = await runEvidence(h.deps, plan(base, head));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("시간 제한");
  });

  it("reports a spawn failure distinctly from a timeout", async () => {
    const { h, base, head } = setup();
    const inner = fakeSpawn(h, []);
    h.deps.spawn = async (cmd, args, o) => {
      if (cmd === "pnpm" && args[0] !== "install") throw new Error("spawn pnpm ENOENT");
      return inner(cmd, args, o);
    };
    const r = await runEvidence(h.deps, plan(base, head));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("시작하지 못했다");
    expect(r.reason).not.toContain("시간 제한");
  });

  it("passes immediately without running anything when evidence is not required", async () => {
    const { h, base, head } = setup();
    const seen: Seen[] = [];
    h.deps.spawn = fakeSpawn(h, seen);
    const r = await runEvidence(
      h.deps,
      plan(base, head, { required: false, reasonCode: "not_bug", testFiles: [] }),
    );
    expect(r.ok).toBe(true);
    expect(seen).toEqual([]);
  });

  it("fails a bug PR without test files and a bug PR with only e2e specs", async () => {
    const { h, base, head } = setup();
    const seen: Seen[] = [];
    h.deps.spawn = fakeSpawn(h, seen);
    const none = await runEvidence(
      h.deps,
      plan(base, head, { reasonCode: "no_test_files", testFiles: [] }),
    );
    expect(none.ok).toBe(false);
    expect(none.reason).toContain("테스트 파일 변경이 없다");
    const e2e = await runEvidence(
      h.deps,
      plan(base, head, { testFiles: ["apps/web/e2e/a.spec.ts"] }),
    );
    expect(e2e.ok).toBe(false);
    expect(e2e.unsupported).toEqual(["apps/web/e2e/a.spec.ts"]);
    expect(e2e.reason).toContain("Playwright E2E");
    expect(seen).toEqual([]);
  });

  // 판정 T2-a: required인데 테스트 파일이 없으면 reasonCode와 관계없이 실패하고, 출력에 reasonCode가 있다.
  it("fails a required plan with no test files for any reasonCode and reports the code", async () => {
    const { h, base, head } = setup();
    const seen: Seen[] = [];
    h.deps.spawn = fakeSpawn(h, seen);
    for (const reasonCode of ["unknown_state", "no_test_files", "evaluated", "not_bug"] as const) {
      const r = await runEvidence(h.deps, plan(base, head, { reasonCode, testFiles: [] }));
      expect(r.ok).toBe(false);
      expect(r.reasonCode).toBe(reasonCode);
      expect(renderEvidenceText(r)).toContain(`reasonCode=${reasonCode}`);
    }
    expect(seen).toEqual([]);
  });

  it("refuses unsafe paths that bypassed the schema before running anything", async () => {
    const { h, base, head } = setup();
    const seen: Seen[] = [];
    h.deps.spawn = fakeSpawn(h, seen);
    for (const bad of ["apps/web/src/-x.test.ts", "apps/web/../../x.test.ts", "notes.md"]) {
      const r = await runEvidence(h.deps, plan(base, head, { testFiles: [TEST, bad] }));
      expect(r.ok).toBe(false);
      expect(r.reason).toContain("안전하지 않은 테스트 파일 경로");
    }
    expect(seen).toEqual([]);
    expect(git(h.dir, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("refuses to judge when the checked-out head is not the planned head", async () => {
    const { h, base } = setup();
    h.deps.spawn = fakeSpawn(h, []);
    const r = await runEvidence(h.deps, plan(base, base));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("판정 대상");
  });
});
