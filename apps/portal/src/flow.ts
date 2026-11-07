/** One state a run entered, and when. */
export interface PathStep {
  state: string;
  at: number;
}

export type StageStatus = "done" | "current" | "stopped" | "skipped" | "todo";

export interface StageCell {
  key: string;
  label: string;
  status: StageStatus;
  /** Time spent in this stage. Null when the run spent none, and always for the last stage. */
  ms: number | null;
}

/** The nine run states grouped into the seven stages a person follows, in the order work moves. */
export const STAGES = [
  { key: "intake", label: "접수", states: ["queued", "cloning"] },
  { key: "implement", label: "구현", states: ["implementing"] },
  { key: "pr", label: "PR", states: ["publishing", "pr_opened"] },
  { key: "review", label: "리뷰", states: ["reviewing"] },
  { key: "checks", label: "체크", states: ["awaiting_checks"] },
  { key: "approval", label: "승인", states: ["awaiting_approval"] },
  { key: "merge", label: "병합", states: ["merged"] },
] as const;

const MERGE_INDEX = STAGES.length - 1;
const STOPPED = ["needs_human", "failed"];

const stageIndex = (state: string) =>
  STAGES.findIndex((s) => (s.states as readonly string[]).includes(state));

function timeInStages(
  path: readonly PathStep[],
  now: number,
): (number | null)[] {
  const times: (number | null)[] = STAGES.map(() => null);
  path.forEach((step, i) => {
    const stage = stageIndex(step.state);
    if (stage === -1 || stage === MERGE_INDEX) return;
    const end = path[i + 1]?.at ?? now;
    times[stage] = (times[stage] ?? 0) + Math.max(0, end - step.at);
  });
  return times;
}

/**
 * Where one run stands on each stage. A stage before the run's position that it never entered is
 * "skipped": approval is only entered when the policy asks for it. A stopped run is marked on the
 * last stage it entered, because the stop itself is not a stage.
 */
export function stageCells(
  run: { state: string; path: readonly PathStep[] },
  now: number,
): StageCell[] {
  const entered = run.path
    .map((s) => stageIndex(s.state))
    .filter((i) => i >= 0);
  const stopped = STOPPED.includes(run.state);
  const position = stopped ? (entered.at(-1) ?? -1) : stageIndex(run.state);
  const atPosition: StageStatus =
    position === MERGE_INDEX ? "done" : stopped ? "stopped" : "current";
  const times = timeInStages(run.path, now);
  return STAGES.map((stage, i) => {
    let status: StageStatus = "todo";
    if (i === position) status = atPosition;
    else if (position === -1) status = entered.includes(i) ? "done" : "todo";
    else if (i < position) status = entered.includes(i) ? "done" : "skipped";
    return { key: stage.key, label: stage.label, status, ms: times[i] ?? null };
  });
}

/** Per stage: how many of these runs are in it now, and how many stopped there. */
export function stageCounts(
  runs: readonly { state: string; path: readonly PathStep[] }[],
  now: number,
): { active: number; stopped: number }[] {
  const counts = STAGES.map(() => ({ active: 0, stopped: 0 }));
  for (const run of runs)
    stageCells(run, now).forEach((cell, i) => {
      if (cell.status === "current") counts[i]!.active += 1;
      if (cell.status === "stopped") counts[i]!.stopped += 1;
    });
  return counts;
}

/** One rounded unit, short enough for a narrow stage column. */
export function durationText(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 1) return "1초 미만";
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간`;
  return `${Math.floor(hours / 24)}일`;
}
