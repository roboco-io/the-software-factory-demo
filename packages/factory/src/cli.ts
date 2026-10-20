import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { buildDeps } from "./main";
import { runBootstrap } from "./stages/bootstrap";
import { runCommand } from "./stages/command";
import {
  EvidencePlanSchema,
  isSha40,
  renderEvidenceText,
  runEvidence,
  runEvidencePlan,
  type EvidencePlan,
} from "./stages/evidence";
import { EvalPlanSchema, renderEvalText, runEval, runEvalPlan, type EvalPlan } from "./stages/eval";
import { runDeployFailed, runDeployed } from "./stages/deploy";
import { fixStage } from "./stages/fix";
import { runGate, runOnClosed } from "./stages/gate";
import { runGuard } from "./stages/guard";
import { implementStage } from "./stages/implement";
import { improveStage } from "./stages/improve";
import type { StageDeps } from "./stages/deps";
import { evalLiveStage } from "./stages/eval-live";
import { runPhase, type Phase, type PhasedStage } from "./stages/phased";
import { runCollect } from "./stages/collect";
import { reviewStage } from "./stages/review";
import { createIntakeClient, runIntake } from "./stages/intake";
import { normalizeSmokeResult, runSmokeReport } from "./stages/smoke";
import { runRisk } from "./stages/risk";
import { triageStage } from "./stages/triage";
import { runWeeklyReport } from "./stages/weekly";

export interface CliContext {
  env: NodeJS.ProcessEnv;
  buildDeps(env: NodeJS.ProcessEnv, phase: Phase): StageDeps;
  stdout(s: string): void;
  // 테스트용. 없으면 전역 fetch를 쓴다.
  fetch?: typeof fetch;
}

type Values = Record<string, string | boolean | undefined>;
type Handler = (ctx: CliContext, v: Values) => Promise<number>;

class UsageError extends Error {}

const OPTIONS = {
  issue: { type: "string" },
  pr: { type: "string" },
  sha: { type: "string" },
  branch: { type: "string" },
  reason: { type: "string" },
  sender: { type: "string" },
  actor: { type: "string" },
  phase: { type: "string" },
  state: { type: "string" },
  outcome: { type: "string" },
  json: { type: "boolean" },
  check: { type: "boolean" },
  base: { type: "string" },
  result: { type: "string" },
  "excerpt-file": { type: "string" },
} as const;

const PHASES: readonly Phase[] = ["prepare", "agent", "publish", "all"];

function num(v: Values, name: string): number {
  const raw = v[name];
  if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw)) {
    throw new UsageError(`--${name} <양의 정수>가 필요하다`);
  }
  return Number(raw);
}

function optNum(v: Values, name: string): number | undefined {
  return v[name] === undefined ? undefined : num(v, name);
}

function str(v: Values, name: string): string | null {
  const raw = v[name];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function reqStr(v: Values, name: string): string {
  const s = str(v, name);
  if (!s) throw new UsageError(`--${name} <값>이 필요하다`);
  return s;
}

function sha40(v: Values, name: string): string {
  const s = reqStr(v, name);
  if (!isSha40(s)) throw new UsageError(`--${name}는 40자리 소문자 16진수여야 한다`);
  return s;
}

function phaseOf(v: Values): Phase {
  // 워크플로가 단계를 명시하도록 기본값을 두지 않는다. all은 명시했을 때만(로컬·테스트) 쓴다.
  const p = str(v, "phase");
  if (!p) throw new UsageError(`--phase <${PHASES.join("|")}>가 필요하다`);
  if (!(PHASES as readonly string[]).includes(p)) {
    throw new UsageError(`--phase는 ${PHASES.join("|")} 중 하나다`);
  }
  return p as Phase;
}

async function phased<A, P, O>(
  ctx: CliContext,
  v: Values,
  stage: PhasedStage<A, P, O>,
  args: A,
): Promise<number> {
  const phase = phaseOf(v);
  await runPhase(stage, phase, ctx.buildDeps(ctx.env, phase), args, {
    plan: str(v, "state"),
    outcome: str(v, "outcome"),
  });
  return 0;
}

export const COMMANDS: Record<string, Handler> = {
  triage: (ctx, v) => phased(ctx, v, triageStage, { issue: num(v, "issue") }),
  command: async (ctx, v) => {
    const outcome = await runCommand(ctx.buildDeps(ctx.env, "all"), {
      issue: num(v, "issue"),
      actor: reqStr(v, "actor"),
      body: ctx.env.COMMENT_BODY ?? "",
    });
    ctx.stdout(outcome);
    return 0;
  },
  review: (ctx, v) => phased(ctx, v, reviewStage, { pr: num(v, "pr") }),
  fix: (ctx, v) => {
    const reason = reqStr(v, "reason");
    if (reason !== "review" && reason !== "ci") {
      throw new UsageError("--reason은 review|ci 중 하나다");
    }
    return phased(ctx, v, fixStage, { pr: num(v, "pr"), sha: reqStr(v, "sha"), reason });
  },
  implement: (ctx, v) => {
    const sender = str(v, "sender");
    return phased(
      ctx,
      v,
      implementStage,
      sender ? { issue: num(v, "issue"), sender } : { issue: num(v, "issue") },
    );
  },
  improve: (ctx, v) => phased(ctx, v, improveStage, { issue: num(v, "issue") }),
  "eval-live": (ctx, v) =>
    phased(ctx, v, evalLiveStage, { pr: num(v, "pr"), issue: num(v, "issue") }),
  gate: async (ctx, v) => {
    const pr = optNum(v, "pr");
    const branch = str(v, "branch");
    if (pr === undefined && !branch) throw new UsageError("--pr 또는 --branch가 필요하다");
    ctx.stdout(
      await runGate(ctx.buildDeps(ctx.env, "all"), pr !== undefined ? { pr } : { branch: branch! }),
    );
    return 0;
  },
  "on-closed": async (ctx, v) => {
    ctx.stdout(String(await runOnClosed(ctx.buildDeps(ctx.env, "all"), { pr: num(v, "pr") })));
    return 0;
  },
  risk: async (ctx, v) => {
    const sha = str(v, "sha");
    if (typeof v.sha === "string" && !/^[0-9a-f]{40}$/.test(v.sha)) {
      throw new UsageError("--sha는 40자리 소문자 16진수여야 한다");
    }
    const report = await runRisk(ctx.buildDeps(ctx.env, "all"), {
      pr: num(v, "pr"),
      check: v.check === true,
      ...(sha ? { sha } : {}),
    });
    ctx.stdout(
      v.json === true
        ? JSON.stringify(report)
        : `risk ${report.tier}: ${report.files.map((f) => `${f.file}=${f.tier}`).join(", ")}`,
    );
    if (v.check === true && report.forbidden.length > 0) {
      ctx.stdout(`구현 역할 PR이 T3 경로를 바꿨다: ${report.forbidden.join(", ")}`);
      return 1;
    }
    return 0;
  },
  bootstrap: async (ctx) => {
    ctx.stdout(JSON.stringify(await runBootstrap(ctx.buildDeps(ctx.env, "all"))));
    return 0;
  },
  collect: async (ctx) => {
    ctx.stdout(JSON.stringify(await runCollect(ctx.buildDeps(ctx.env, "all"))));
    return 0;
  },
  "weekly-report": async (ctx) => {
    ctx.stdout(JSON.stringify(await runWeeklyReport(ctx.buildDeps(ctx.env, "all"))));
    return 0;
  },
  guard: async (ctx) => {
    ctx.stdout(JSON.stringify(await runGuard(ctx.buildDeps(ctx.env, "all"))));
    return 0;
  },
  deployed: async (ctx, v) => {
    ctx.stdout(
      JSON.stringify(await runDeployed(ctx.buildDeps(ctx.env, "all"), { sha: reqStr(v, "sha") })),
    );
    return 0;
  },
  "deploy-failed": async (ctx, v) => {
    ctx.stdout(
      JSON.stringify(
        await runDeployFailed(ctx.buildDeps(ctx.env, "all"), { sha: reqStr(v, "sha") }),
      ),
    );
    return 0;
  },
  evidence: async (ctx, v) => {
    const plan = await runEvidencePlan(ctx.buildDeps(ctx.env, "all"), {
      pr: num(v, "pr"),
      headSha: sha40(v, "sha"),
      baseSha: sha40(v, "base"),
    });
    ctx.stdout(
      v.json === true
        ? JSON.stringify(plan)
        : `evidence ${plan.required ? "required" : "not required"}: ${plan.reason}`,
    );
    return 0;
  },
  "evidence-run": async (ctx, v) => {
    // 계획은 다른 job이 넘긴 값이다. 형식이 틀리거나 없으면(evidence-plan job 실패) 통과시키지 않는다.
    let plan: EvidencePlan;
    try {
      plan = EvidencePlanSchema.parse(JSON.parse(ctx.env.EVIDENCE_PLAN ?? ""));
    } catch {
      ctx.stdout(
        "evidence 실패: EVIDENCE_PLAN(판정 계획)이 없거나 형식이 틀렸다. evidence-plan job 결과를 확인한다.",
      );
      return 1;
    }
    const result = await runEvidence(ctx.buildDeps(ctx.env, "agent"), plan);
    ctx.stdout(v.json === true ? JSON.stringify(result) : renderEvidenceText(result));
    return result.ok ? 0 : 1;
  },
  eval: async (ctx, v) => {
    const plan = await runEvalPlan(ctx.buildDeps(ctx.env, "all"), {
      pr: num(v, "pr"),
      headSha: sha40(v, "sha"),
      baseSha: sha40(v, "base"),
    });
    ctx.stdout(v.json === true ? JSON.stringify(plan) : `eval: ${plan.reason}`);
    return 0;
  },
  "eval-run": async (ctx) => {
    // 계획은 다른 job이 넘긴 값이다. 형식이 틀리거나 없으면 통과시키지 않는다.
    let plan: EvalPlan;
    try {
      plan = EvalPlanSchema.parse(JSON.parse(ctx.env.EVAL_PLAN ?? ""));
    } catch {
      ctx.stdout(
        "eval 실패: EVAL_PLAN(판정 계획)이 없거나 형식이 틀렸다. eval-plan job 결과를 확인한다.",
      );
      return 1;
    }
    const baseRoot = ctx.env.EVAL_BASE_DIR;
    if (!baseRoot) {
      ctx.stdout("eval 실패: EVAL_BASE_DIR가 없다.");
      return 1;
    }
    const result = await runEval(ctx.buildDeps(ctx.env, "agent"), plan, baseRoot);
    ctx.stdout(renderEvalText(result));
    return result.ok ? 0 : 1;
  },
  intake: async (ctx) => {
    const url = ctx.env.INTAKE_URL ?? "";
    const token = ctx.env.INTAKE_TOKEN ?? "";
    // 토큰이 평문으로 나가지 않게 https만 허용한다. 테스트용 loopback만 http를 허용한다.
    const secure =
      /^https:\/\/\S+$/.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/\S*)?$/.test(url);
    if (!secure || token.length === 0) {
      throw new UsageError("INTAKE_URL(https://...)과 INTAKE_TOKEN 환경변수가 필요하다");
    }
    const summary = await runIntake(
      ctx.buildDeps(ctx.env, "all"),
      createIntakeClient(url, token, ctx.fetch),
    );
    ctx.stdout(JSON.stringify(summary));
    return summary.failed > 0 ? 1 : 0;
  },
  // --result는 checks job 결과다. success 외의 값(failure·cancelled·skipped·timed_out)은 모두 실패로 본다.
  "smoke-report": async (ctx, v) => {
    const result = normalizeSmokeResult(reqStr(v, "result"));
    if (result === null) throw new UsageError("--result <checks job 결과>가 필요하다");
    // --excerpt-file은 실패 원문 발췌다. checks가 시간 초과 등으로 발췌를 못 남겼으면 파일이 없다. 그래도 보고는 한다.
    const file = str(v, "excerpt-file");
    const excerpt = file && existsSync(file) ? readFileSync(file, "utf8").slice(0, 64_000) : null;
    ctx.stdout(
      JSON.stringify(await runSmokeReport(ctx.buildDeps(ctx.env, "all"), { result, excerpt })),
    );
    return 0;
  },
};

export async function main(argv: string[], ctx: CliContext): Promise<number> {
  const [command, ...rest] = argv;
  const handler = command ? COMMANDS[command] : undefined;
  if (!handler) {
    ctx.stdout(`usage: pnpm factory <${Object.keys(COMMANDS).join("|")}> [options]`);
    return 2;
  }
  try {
    const { values } = parseArgs({
      args: rest,
      options: OPTIONS,
      strict: true,
      allowPositionals: false,
    });
    return await handler(ctx, values as Values);
  } catch (e) {
    if (
      e instanceof UsageError ||
      (e instanceof Error && "code" in e && String(e.code).startsWith("ERR_PARSE_ARGS"))
    ) {
      ctx.stdout(`${command}: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

// 이후 Task에서 COMMANDS에 추가하는 핸들러가 쓰는 인자 헬퍼.
export { optNum, reqStr, str, num, sha40 };

// 테스트에서 import할 때는 실행하지 않는다.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), { env: process.env, buildDeps, stdout: (s) => console.log(s) }).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err);
      process.exit(1);
    },
  );
}
