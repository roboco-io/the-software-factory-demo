import { z } from "zod";
import { runStructured, type TimedResult } from "../agents/budget";
import { loadPrompt, renderPrompt } from "../agents/prompt";
import type { Budget, EngineName } from "../agents/types";
import { assignEngines, resolveModel } from "../config/agents";
import { TriageSchema, renderTriageComment, type Triage } from "../report/comments";
import { canTransition } from "../state/machine";
import {
  agentRecord,
  crashRecord,
  failureText,
  isBot,
  moveTo,
  readState,
  record,
  runLink,
  TimedResultSchema,
} from "./common";
import { INTAKE_SOURCES } from "./intake";
import type { PhasedStage } from "./phased";

export interface TriagePlan {
  issue: number;
  engine: EngineName;
  model: string;
  budget: Budget;
  prompt: string;
}

export interface TriageOutcome {
  result: TimedResult;
  triage: Triage | null;
}

// 외부 사용자도 자기 이슈의 본문은 고칠 수 있다. 수정을 반복해 에이전트 비용을 늘리지 못하도록 이슈당 재판정 횟수를 제한한다.
export const RETRIAGE_LIMIT = 2;
const TRIAGE_HEADING = "### 트리아지 결과";
const RETRIAGE_FAILED = "본문 수정 후 다시 판정하던 트리아지";

const OutcomeSchema = z.object({ result: TimedResultSchema, triage: TriageSchema.nullable() });

export const triageStage: PhasedStage<{ issue: number }, TriagePlan, TriageOutcome> = {
  name: "triage",
  async prepare(deps, { issue }) {
    const { issue: info, state } = await readState(deps.gh, issue);
    // 봇이 연 이슈(차단기 알림 등)는 건너뛴다. 단 유입 이슈(source:error|feedback|smoke)는 트리아지한다(spec 7.1.3).
    const intake = info.labels.some((l) => (INTAKE_SOURCES as readonly string[]).includes(l));
    if (
      info.isPullRequest ||
      info.state !== "open" ||
      (isBot(deps.settings, info.author) && !intake)
    ) {
      return null;
    }
    // triaged 이슈는 본문·제목 수정 이벤트로 다시 판정한다. 상태는 그대로 두고 결과만 새로 남긴다.
    if (state !== "triaged" && !canTransition(state, "triaged", "triage")) return null;
    if (state === "triaged") {
      const runs = (await deps.gh.listComments(issue)).filter(
        (c) =>
          isBot(deps.settings, c.author) &&
          (c.body.startsWith(TRIAGE_HEADING) || c.body.startsWith(RETRIAGE_FAILED)),
      ).length;
      // 첫 판정 1회와 재판정 RETRIAGE_LIMIT회까지만 실행한다.
      if (runs > RETRIAGE_LIMIT) {
        deps.log(`triage: #${issue} reached the re-triage limit (${RETRIAGE_LIMIT}); skipping`);
        return null;
      }
    }
    const role = assignEngines(deps.agents, info.labels).triage;
    const model = resolveModel(deps.agents, role.engine, deps.settings.env);
    const open = (await deps.gh.listOpenIssues())
      .filter((i) => i.number !== issue)
      .slice(0, 50)
      .map((i) => `- #${i.number} ${i.title}`)
      .join("\n");
    const prompt = renderPrompt(loadPrompt("triage"), {
      issueNumber: String(issue),
      issueTitle: info.title,
      issueBody: info.body || "(본문 없음)",
      openIssues: open || "(없음)",
    });
    return { issue, engine: role.engine, model, budget: role.budget, prompt };
  },
  async agent(deps, plan) {
    const adapter = deps.adapterFor(plan.engine, plan.model);
    const { result, value } = await runStructured(
      adapter,
      {
        role: "triage",
        prompt: plan.prompt,
        cwd: deps.settings.workdir,
        readOnly: true,
        budget: plan.budget,
      },
      TriageSchema,
    );
    return { result, triage: value };
  },
  parseOutcome(raw) {
    return OutcomeSchema.parse(raw) as TriageOutcome;
  },
  async publish(deps, plan, { result, triage }) {
    // prepare 이후 상태가 바뀌었으면(사람이 라벨을 바꾼 경우 등) 아무것도 하지 않는다.
    const { state } = await readState(deps.gh, plan.issue);
    const retriage = state === "triaged";
    if (!retriage && !canTransition(state, triage ? "triaged" : "needs-human", "triage")) {
      deps.log(`triage: #${plan.issue} is ${state}; skipping publish`);
      return;
    }
    await record(deps, agentRecord("triage", plan.engine, plan.model, result, plan.issue, null, 0));
    if (!triage && retriage) {
      await deps.gh.comment(
        plan.issue,
        `${RETRIAGE_FAILED} 에이전트가 실패했다(사유: ${failureText(result.failureReason)}). 이전 트리아지 결과를 유지한다.${runLink(deps.settings)}`,
      );
      return;
    }
    if (!triage) {
      await moveTo(
        deps,
        plan.issue,
        "needs-human",
        "triage",
        `트리아지 에이전트가 실패했다(사유: ${failureText(result.failureReason)}). 사람이 이슈를 확인한 뒤 \`@factory go\`로 구현을 시작할 수 있다.${runLink(deps.settings)}`,
      );
      return;
    }
    await deps.gh.comment(
      plan.issue,
      renderTriageComment(triage, { engine: plan.engine, model: plan.model }, { retriage }),
    );
    // type 라벨은 정확히 하나만 남긴다(이슈 템플릿이 붙인 type:*가 있을 수 있다).
    const typeLabel = `type:${triage.type}`;
    const { issue: current } = await readState(deps.gh, plan.issue);
    for (const l of current.labels) {
      if (l.startsWith("type:") && l !== typeLabel) await deps.gh.removeLabel(plan.issue, l);
    }
    if (!current.labels.includes(typeLabel)) await deps.gh.addLabels(plan.issue, [typeLabel]);
    if (!retriage) await moveTo(deps, plan.issue, "triaged", "triage");
  },
  async crashed(deps, plan) {
    await record(deps, crashRecord("triage", plan));
    if ((await readState(deps.gh, plan.issue)).state === "triaged") {
      await deps.gh.comment(
        plan.issue,
        `${RETRIAGE_FAILED} 단계가 비정상 종료했다. 이전 트리아지 결과를 유지한다.${runLink(deps.settings)}`,
      );
      return;
    }
    await moveTo(
      deps,
      plan.issue,
      "needs-human",
      "triage",
      `트리아지 단계가 비정상 종료했다.${runLink(deps.settings)}`,
    );
  },
};
