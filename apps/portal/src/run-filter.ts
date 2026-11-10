import { isAttention } from "./console-labels";
import { type PathStep, stageCells, STAGES } from "./flow";

/** What the run list shows. Each kind matches one count a person can click on the project page. */
export type RunFilter =
  | { kind: "all" }
  | { kind: "attention" }
  | { kind: "active" }
  | { kind: "merged" }
  | { kind: "stage"; stage: number; status: "current" | "stopped" };

type FilterableRun = {
  state: string;
  updatedAt: number;
  path: readonly PathStep[];
};

/** Same split as the API's project counts: anything not merged, stuck or failed is still active. */
const FINISHED = ["merged", "needs_human", "failed"];

export function matchesFilter(
  run: FilterableRun,
  filter: RunFilter,
  now: number,
): boolean {
  switch (filter.kind) {
    case "all":
      return true;
    case "attention":
      return isAttention(run, now);
    case "active":
      return !FINISHED.includes(run.state);
    case "merged":
      return run.state === "merged";
    case "stage":
      return stageCells(run, now)[filter.stage]?.status === filter.status;
  }
}

export function filterText(filter: RunFilter): string {
  switch (filter.kind) {
    case "all":
      return "모든 실행";
    case "attention":
      return "주의가 필요한 실행";
    case "active":
      return "진행 중인 실행";
    case "merged":
      return "병합된 실행";
    case "stage": {
      const label = STAGES[filter.stage]?.label ?? "";
      return filter.status === "stopped"
        ? `${label} 단계에서 멈춘 실행`
        : `${label} 단계에서 진행 중인 실행`;
    }
  }
}

export const sameFilter = (a: RunFilter, b: RunFilter): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
