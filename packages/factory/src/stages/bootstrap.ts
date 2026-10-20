import { ENGINES } from "../agents/types";
import { TIERS } from "../policy/risk";
import { DATA_BRANCH } from "../runs/store";
import { STATES, stateLabel } from "../state/machine";
import { BOARD } from "./board";
import type { StageDeps } from "./deps";

export interface LabelSpec {
  name: string;
  color: string;
  description: string;
}

export const LABELS: LabelSpec[] = [
  ...STATES.map((s) => ({
    name: stateLabel(s),
    color: "5319e7",
    description: `팩토리 상태: ${s}`,
  })),
  ...[1, 2, 3].map((n) => ({
    name: `factory:round-${n}`,
    color: "c5def5",
    description: `수정 라운드 ${n}/3`,
  })),
  { name: "factory:alert", color: "b60205", description: "팩토리 실패율 차단기 알림" },
  { name: "factory:improve", color: "0e8a16", description: "팩토리 자기개선 PR(T3, 사람 승인)" },
  { name: "factory:report", color: "c5def5", description: "팩토리 주간 리포트" },
  {
    name: "factory:postmortem",
    color: "c5def5",
    description: "포스트모템 개선 후보가 있는 장애 이슈",
  },
  ...TIERS.map((t) => ({
    name: `risk:${t}`,
    color: "fbca04",
    description: `위험 등급 ${t} (factory/risk-policy.yml)`,
  })),
  ...(["feature", "bug", "docs", "feedback"] as const).map((t) => ({
    name: `type:${t}`,
    color: "0e8a16",
    description: `분류: ${t}`,
  })),
  ...ENGINES.map((e) => ({
    name: `agent:${e}`,
    color: "d4c5f9",
    description: `구현 엔진을 ${e}로 지정`,
  })),
  {
    name: "source:deploy",
    color: "d93f0b",
    description: "프로덕션 배포·스모크 실패로 사람에게 돌아온 이슈",
  },
  {
    name: "source:error",
    color: "d93f0b",
    description: "프로덕션 에러 유입(factory-intake). 트리아지 후 @factory go로 착수",
  },
  {
    name: "source:feedback",
    color: "d93f0b",
    description: "앱 내 익명 피드백 유입(factory-intake). 트리아지 후 @factory go로 착수",
  },
  {
    name: "source:smoke",
    color: "d93f0b",
    description: "프로덕션 스모크 실패 유입(factory-smoke). 트리아지 후 @factory go로 착수",
  },
];

export async function runBootstrap(
  deps: StageDeps,
): Promise<{ labels: number; branch: string; board: { created: boolean; url: string } }> {
  for (const l of LABELS) await deps.gh.ensureLabel(l.name, l.color, l.description);
  await deps.gh.createOrphanBranch(
    DATA_BRANCH,
    {
      "README.md":
        "# factory-data\n\n팩토리 런 기록 브랜치다. 단계 런이 끝날 때마다 `runs/YYYY-MM.jsonl`(UTC 월)에 한 줄을 추가한다. 봇만 쓰며 보호 규칙을 걸지 않는다.\n",
    },
    "chore: factory-data 고아 브랜치 생성",
  );
  // 사람이 실행하는 설정 명령이므로 실패를 숨기지 않는다.
  const board = await deps.gh.ensureBoard(BOARD);
  return { labels: LABELS.length, branch: DATA_BRANCH, board };
}
