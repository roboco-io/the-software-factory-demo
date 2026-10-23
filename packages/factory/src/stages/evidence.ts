import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { scrubEnv } from "../agents/env";
import { tail } from "../exec/checks";
import type { ProcessResult } from "../exec/process";
import { TooManyFilesError, type ChangedFile } from "../github/port";
import { isSafeRelativePath, isTestFile, planSuites, SUITES } from "../policy/evidence";
import { parsePrMeta } from "../report/pr";
import type { StageDeps } from "./deps";

// 40자 소문자 16진수 커밋 SHA. CLI 옵션 검사(cli.ts의 sha40)도 이 함수를 쓴다.
const SHA = /^[0-9a-f]{40}$/;
export function isSha40(s: string): boolean {
  return SHA.test(s);
}

// evidence-plan job이 만들고 evidence job이 job output으로 받는 계획. 받는 쪽은 이 스키마로 다시 검증한다.
export const EvidencePlanSchema = z.object({
  pr: z.number().int().positive(),
  required: z.boolean(),
  reason: z.string().max(500),
  reasonCode: z.enum(["not_bug", "evaluated", "no_test_files", "unknown_state"]),
  baseSha: z.string().regex(SHA),
  headSha: z.string().regex(SHA),
  testFiles: z.array(z.string().refine(isTestFile, "테스트 파일 경로가 아니다")).max(200),
});
export type EvidencePlan = z.infer<typeof EvidencePlanSchema>;

export async function runEvidencePlan(
  deps: StageDeps,
  args: { pr: number; baseSha: string; headSha: string },
): Promise<EvidencePlan> {
  const plan = (
    required: boolean,
    reasonCode: EvidencePlan["reasonCode"],
    reason: string,
    testFiles: string[] = [],
  ): EvidencePlan =>
    EvidencePlanSchema.parse({
      pr: args.pr,
      required,
      reason,
      reasonCode,
      baseSha: args.baseSha,
      headSha: args.headSha,
      testFiles,
    });
  const pull = await deps.gh.getPull(args.pr);
  // 팩토리 봇이 연 PR만 대상이다. 사람이 연 PR의 본문 표식은 신뢰하지 않는다(stages/risk.ts와 같은 기준).
  const meta = pull.author === deps.settings.botLogin ? parsePrMeta(pull.body) : null;
  if (!meta) {
    return plan(
      false,
      "not_bug",
      "봇이 연 팩토리 PR이 아니다(표식 없음, 사람이 연 PR 등). 버그 PR 증거 검사를 하지 않는다.",
    );
  }
  const issue = await deps.gh.getIssue(meta.issue);
  if (!issue.labels.includes("type:bug")) {
    return plan(
      false,
      "not_bug",
      `연결 이슈 #${meta.issue}에 type:bug 라벨이 없다. 버그 PR 증거 검사를 하지 않는다.`,
    );
  }
  // 이벤트 이후 head가 바뀌었으면 이 head의 파일 목록을 알 수 없다. 실패로 두고 새 head의 실행에 맡긴다.
  if (pull.headSha !== args.headSha) {
    return plan(
      true,
      "unknown_state",
      `PR head가 ${pull.headSha}로 바뀌어 ${args.headSha}의 테스트 파일을 확정할 수 없다. 새 head의 evidence 실행이 판정한다.`,
    );
  }
  let files: ChangedFile[];
  try {
    files = await deps.gh.listPullFiles(args.pr);
  } catch (e) {
    if (!(e instanceof TooManyFilesError)) throw e;
    return plan(true, "unknown_state", "변경 파일이 너무 많아 테스트 파일 목록을 확정할 수 없다.");
  }
  // listPullFiles가 끝난 뒤 head가 다시 바뀌었는지 확인한다. 바뀌었으면 받은 목록은 다른 커밋의 것이다.
  const after = await deps.gh.getPull(args.pr);
  if (after.headSha !== args.headSha) {
    return plan(
      true,
      "unknown_state",
      `파일 목록을 읽는 동안 PR head가 ${after.headSha}로 바뀌었다. 새 head의 evidence 실행이 판정한다.`,
    );
  }
  // 원본 파일명에 그대로 검사한다. 역슬래시를 슬래시로 바꾸면 위험한 이름이 안전한 경로로 둔갑한다.
  const testFiles = [
    ...new Set(files.filter((f) => !f.removed && isTestFile(f.filename)).map((f) => f.filename)),
  ].sort();
  if (testFiles.length > 200) {
    return plan(true, "unknown_state", "테스트 파일이 200개를 넘어 확정할 수 없다.");
  }
  return plan(
    true,
    testFiles.length === 0 ? "no_test_files" : "evaluated",
    `연결 이슈 #${meta.issue}가 type:bug다. PR이 추가·수정한 테스트 파일 ${testFiles.length}개로 판정한다.`,
    testFiles,
  );
}

export const EVIDENCE_STEP_TIMEOUT_MS = 15 * 60_000;

export interface SuiteOutcome {
  suite: string;
  targets: string[];
  baseCode: number | null;
  headCode: number | null;
  // JSON 보고서로 판정한 결과를 한 줄로 요약한다(판정 T3-b).
  baseSummary: string;
  headSummary: string;
  baseOutput: string;
  headOutput: string;
}

export interface EvidenceResult {
  pr: number;
  required: boolean;
  ok: boolean;
  reason: string;
  reasonCode: EvidencePlan["reasonCode"];
  testFiles: string[];
  unsupported: string[];
  suites: SuiteOutcome[];
}

// vitest 4.1.11 `--reporter=json` 보고서 중 판정에 쓰는 필드만 검증한다(실제 출력으로 확인했다).
// 파일을 수집하지 못하면(모듈 없음, 문법 오류) assertionResults가 비고 message에 오류가 들어간다.
const VitestReportSchema = z.object({
  testResults: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      message: z.string().optional(),
      assertionResults: z.array(z.object({ status: z.string() })),
    }),
  ),
});
type VitestReport = z.infer<typeof VitestReportSchema>;

function readReport(file: string): VitestReport | null {
  try {
    if (!existsSync(file)) return null;
    const r = VitestReportSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

interface SideJudgement {
  missing: string[];
  collectErrors: string[];
  passed: number;
  failed: number;
}

// 대상 파일마다 보고서 항목을 절대 경로가 정확히 같은 것으로 찾는다(부분 문자열 일치 금지).
// vitest는 실제 경로(realpath)를 쓸 수 있으므로 트리 루트의 두 형태를 모두 받는다.
function judgeSide(report: VitestReport, treeRoot: string, files: string[]): SideJudgement {
  const roots = new Set([treeRoot]);
  try {
    roots.add(realpathSync(treeRoot));
  } catch {
    // 루트를 해석하지 못하면 원래 경로만 쓴다.
  }
  const out: SideJudgement = { missing: [], collectErrors: [], passed: 0, failed: 0 };
  for (const file of files) {
    const names = new Set([...roots].map((r) => path.join(r, file)));
    const entries = report.testResults.filter((t) => names.has(t.name));
    if (entries.length === 0) {
      out.missing.push(file);
      continue;
    }
    for (const e of entries) {
      if ((e.message ?? "").trim() !== "" || e.assertionResults.length === 0) {
        out.collectErrors.push(file);
      }
      for (const a of e.assertionResults) {
        if (a.status === "passed") out.passed += 1;
        if (a.status === "failed") out.failed += 1;
      }
    }
  }
  return out;
}

function summarize(j: SideJudgement | null): string {
  if (j === null) return "결과 보고서 없음";
  const parts = [`통과 ${j.passed}, 실패 ${j.failed}`];
  if (j.missing.length > 0) parts.push(`수집되지 않음: ${j.missing.join(", ")}`);
  if (j.collectErrors.length > 0) parts.push(`수집 오류: ${j.collectErrors.join(", ")}`);
  return parts.join("; ");
}

type ExecResult = ProcessResult & { spawnError?: true };

// 이 함수는 PR 코드(테스트와 그 의존성)를 실행한다. 시크릿·GitHub 토큰이 없는 evidence job에서만 부른다(spec 7.1.2).
export async function runEvidence(deps: StageDeps, plan: EvidencePlan): Promise<EvidenceResult> {
  const { runs, unsupported } = planSuites(plan.testFiles);
  const done = (ok: boolean, reason: string, suites: SuiteOutcome[] = []): EvidenceResult => ({
    pr: plan.pr,
    required: plan.required,
    ok,
    reason,
    reasonCode: plan.reasonCode,
    testFiles: plan.testFiles,
    unsupported,
    suites,
  });
  if (!plan.required) return done(true, plan.reason);
  // 판정 T2-a: reasonCode와 관계없이(unknown_state 포함) 테스트 파일이 없으면 실패다.
  if (plan.testFiles.length === 0) {
    return done(
      false,
      `버그 PR인데 테스트 파일 변경이 없다. 수정 전 코드에서 실패하는 재현 테스트를 추가해야 한다. (${plan.reason})`,
    );
  }
  // 호출자가 스키마를 거치지 않았어도 경로를 다시 검사한다. 무엇이든 실행하기 전에 거부한다.
  // isTestFile은 isSafeRelativePath(`..`, 절대 경로, `-`로 시작하는 세그먼트 거부)를 포함한다.
  const bad = plan.testFiles.find((f) => !isTestFile(f));
  if (bad !== undefined) return done(false, `안전하지 않은 테스트 파일 경로: ${bad}`);
  if (runs.length === 0) {
    return done(
      false,
      "실행할 수 있는 Vitest 테스트 파일(apps/api, apps/web, packages/factory 아래 *.test.ts(x))이 없다. Playwright E2E(apps/web/e2e)는 덮어쓰기만 하고 실행하지 않으므로 E2E만으로는 evidence를 통과하지 못한다. Vitest 재현 테스트를 추가해야 한다.",
    );
  }
  // vitest에 넘기는 인자가 옵션으로 해석되지 않게 한다(판정 F8). isSafeRelativePath가 이미 막지만 실행 직전에 다시 확인한다.
  const flagLike = runs.flatMap((r) => r.targets).find((t) => t.startsWith("-"));
  if (flagLike !== undefined) return done(false, `안전하지 않은 테스트 파일 경로: ${flagLike}`);
  const env = scrubEnv(deps.settings.env);
  const repo = deps.settings.workdir;
  const exec = async (cmd: string, args: string[], cwd: string): Promise<ExecResult> => {
    try {
      return await deps.spawn(cmd, args, {
        cwd,
        env,
        signal: AbortSignal.timeout(EVIDENCE_STEP_TIMEOUT_MS),
      });
    } catch (e) {
      // 프로세스를 시작하지 못한 경우(ENOENT 등). 시간 초과(code null)와 구분한다.
      return { code: null, stdout: "", stderr: String(e), spawnError: true };
    }
  };
  const head = await exec("git", ["rev-parse", "--verify", "HEAD^{commit}"], repo);
  if (head.code !== 0 || head.stdout.trim() !== plan.headSha) {
    return done(
      false,
      `작업 트리 head(${head.stdout.trim() || "알 수 없음"})가 판정 대상 ${plan.headSha}와 다르다.`,
    );
  }
  const root = mkdtempSync(path.join(deps.settings.env.RUNNER_TEMP || tmpdir(), "evidence-"));
  const overlay = path.join(root, "overlay");
  try {
    const add = await exec(
      "git",
      ["worktree", "add", "--detach", "--", overlay, plan.baseSha],
      repo,
    );
    if (add.code !== 0)
      return done(false, `base 커밋 ${plan.baseSha}로 작업 트리를 만들지 못했다.`);
    const overlayReal = realpathSync(overlay);
    for (const file of plan.testFiles) {
      const target = path.resolve(overlay, file);
      if (!isSafeRelativePath(file) || !target.startsWith(`${overlay}${path.sep}`)) {
        return done(false, `안전하지 않은 테스트 파일 경로: ${file}`);
      }
      // 심볼릭 링크 등 일반 파일이 아닌 head 항목은 덮어쓰지 않는다(판정 T3-b).
      const entry = await exec("git", ["ls-tree", plan.headSha, "--", file], repo);
      const m = /^(\d{6}) (\w+) [0-9a-f]+\t(.+)$/.exec(entry.stdout.trim());
      if (entry.code !== 0 || m === null || m[3] !== file) {
        return done(false, `head에서 ${file}을 찾지 못했다.`);
      }
      if (m[1] !== "100644" || m[2] !== "blob") {
        return done(false, `head의 ${file}이 일반 파일(100644)이 아니다(mode ${m[1]}).`);
      }
      const blob = await exec("git", ["show", `${plan.headSha}:${file}`], repo);
      if (blob.code !== 0 || blob.truncated) return done(false, `head에서 ${file}을 읽지 못했다.`);
      const dir = path.dirname(target);
      mkdirSync(dir, { recursive: true });
      // base 트리 안의 심볼릭 링크 디렉토리를 따라 트리 밖에 쓰지 않는다.
      const dirReal = realpathSync(dir);
      if (dirReal !== overlayReal && !dirReal.startsWith(`${overlayReal}${path.sep}`)) {
        return done(false, `안전하지 않은 테스트 파일 경로: ${file}(트리 밖을 가리킨다)`);
      }
      // 확인과 쓰기 사이에 대상이 바뀌지 않도록, 심볼릭 링크를 따라가지 않고 연 뒤 연 파일을 확인한다.
      let fd: number;
      try {
        fd = openSync(
          target,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
        );
      } catch {
        return done(false, `안전하지 않은 테스트 파일 경로: ${file}(base에서 일반 파일이 아니다)`);
      }
      try {
        if (!fstatSync(fd).isFile()) {
          return done(
            false,
            `안전하지 않은 테스트 파일 경로: ${file}(base에서 일반 파일이 아니다)`,
          );
        }
        writeFileSync(fd, blob.stdout);
      } finally {
        closeSync(fd);
      }
    }
    for (const [dir, name] of [
      [overlay, "base+테스트"],
      [repo, "head"],
    ] as const) {
      const install = await exec("pnpm", ["install", "--frozen-lockfile"], dir);
      if (install.spawnError) return done(false, `${name} 트리에서 pnpm을 시작하지 못했다.`);
      if (install.code !== 0) return done(false, `${name} 트리의 의존성 설치가 실패했다.`);
    }
    const suites: SuiteOutcome[] = [];
    const judged: { base: SideJudgement | null; head: SideJudgement | null }[] = [];
    let spawnFailed = false;
    for (const run of runs) {
      const pkgDir = SUITES.find((s) => s.suite === run.suite)?.dir ?? "";
      const files = run.targets.map((t) => `${pkgDir}${t}`);
      // 보고서는 두 트리 밖(root 바로 아래)에 쓴다.
      const runSide = async (where: "base" | "head", cwd: string) => {
        const out = path.join(root, `${run.suite}-${where}.json`);
        rmSync(out, { force: true });
        const args = [
          "--filter",
          run.filter,
          "exec",
          "vitest",
          "run",
          "--reporter=default",
          "--reporter=json",
          `--outputFile.json=${out}`,
          ...run.targets,
        ];
        const res = await exec("pnpm", args, cwd);
        const report = readReport(out);
        return { res, judged: report === null ? null : judgeSide(report, cwd, files) };
      };
      const base = await runSide("base", overlay);
      const after = await runSide("head", repo);
      if (base.res.spawnError || after.res.spawnError) spawnFailed = true;
      judged.push({ base: base.judged, head: after.judged });
      suites.push({
        suite: run.suite,
        targets: run.targets,
        baseCode: base.res.code,
        headCode: after.res.code,
        baseSummary: summarize(base.judged),
        headSummary: summarize(after.judged),
        baseOutput: tail(`${base.res.stdout}\n${base.res.stderr}`.trim(), 3000),
        headOutput: tail(`${after.res.stdout}\n${after.res.stderr}`.trim(), 3000),
      });
    }
    if (spawnFailed) return done(false, "테스트 프로세스(pnpm)를 시작하지 못했다.", suites);
    if (suites.some((s) => s.baseCode === null || s.headCode === null)) {
      return done(false, "테스트 실행이 시간 제한(15분)에 걸리거나 강제 종료되었다.", suites);
    }
    if (judged.some((j) => j.base === null || j.head === null)) {
      return done(
        false,
        "vitest JSON 결과 보고서가 없거나 형식이 틀려 판정할 수 없다(fail closed).",
        suites,
      );
    }
    const sides = judged as { base: SideJudgement; head: SideJudgement }[];
    const headMissing = sides.flatMap((j) => j.head.missing);
    if (headMissing.length > 0) {
      return done(
        false,
        `재현 테스트가 수정 후(head) 코드에서 수집되지 않았다: ${headMissing.join(", ")}`,
        suites,
      );
    }
    if (
      sides.some((j) => j.head.collectErrors.length > 0 || j.head.failed > 0 || j.head.passed === 0)
    ) {
      return done(false, "재현 테스트가 수정 후(head) 코드에서 실패했다.", suites);
    }
    const baseMissing = sides.flatMap((j) => j.base.missing);
    if (baseMissing.length > 0) {
      return done(
        false,
        `재현 테스트가 수정 전(base) 코드에서 수집되지 않았다: ${baseMissing.join(", ")}`,
        suites,
      );
    }
    const baseErrors = sides.flatMap((j) => j.base.collectErrors);
    if (baseErrors.length > 0) {
      return done(
        false,
        `base에서 테스트를 실행할 수 없다(수집 오류): ${baseErrors.join(", ")}. 수정 전 코드에서 단언이 실패하는 재현 테스트여야 한다.`,
        suites,
      );
    }
    if (!sides.some((j) => j.base.failed > 0)) {
      return done(
        false,
        "재현 테스트가 수정 전(base) 코드에서도 통과했다. 버그를 재현하지 못하는 테스트다.",
        suites,
      );
    }
    return done(
      true,
      "재현 테스트가 수정 전(base) 코드에서 실패하고 수정 후(head) 코드에서 통과했다.",
      suites,
    );
  } finally {
    await exec("git", ["worktree", "remove", "--force", "--", overlay], repo);
    rmSync(root, { recursive: true, force: true });
  }
}

export function renderEvidenceText(r: EvidenceResult): string {
  const lines = [
    `evidence ${r.ok ? "통과" : "실패"}(PR #${r.pr}, reasonCode=${r.reasonCode}): ${r.reason}`,
    `테스트 파일: ${r.testFiles.length > 0 ? r.testFiles.join(", ") : "(없음)"}`,
  ];
  if (r.unsupported.length > 0) lines.push(`실행하지 않은 테스트: ${r.unsupported.join(", ")}`);
  for (const s of r.suites) {
    lines.push(
      `- ${s.suite} ${s.targets.join(" ")}: base 종료 코드 ${s.baseCode}(${s.baseSummary}), head 종료 코드 ${s.headCode}(${s.headSummary})`,
    );
    if (!r.ok) lines.push(`  base 출력:\n${s.baseOutput}`, `  head 출력:\n${s.headOutput}`);
  }
  return lines.join("\n");
}
