import { z } from "zod";
import type { CommitInfo } from "../github/port";
import { parseFactoryIssues } from "../report/commit";
import { readMarker } from "../report/text";
import type { RunRecord } from "../runs/store";
import type { StageDeps } from "./deps";

export const COLLECT = {
  windowDays: 28,
  minDistinct: 3,
  maxSamples: 5,
  maxSampleChars: 1000,
} as const;
export const IGNORED_REASONS = ["risk_t2", "risk_t3", "permission_denied"] as const;
// 개선 PR 본문 표식 {"key": "..."}
export const IMPROVE_MARKER = "factory:improve";
const IMPROVE_LABEL = "factory:improve";

export interface FailureEvent {
  key: string;
  issue: number | null;
  pr: number | null;
  ts: string;
  detail: string | null;
  distinctKey: string;
}

export const CandidateSchema = z.object({
  key: z.string().max(100),
  count: z.number().int(),
  distinct: z.number().int(),
  issues: z.array(z.number().int()).max(50),
  prs: z.array(z.number().int()).max(50),
  samples: z.array(z.string().max(1000)).max(5),
});
export type Candidate = z.infer<typeof CandidateSchema>;

export interface CollectResult {
  from: string;
  to: string;
  events: number;
  candidates: Candidate[];
  excluded: { key: string; reason: "open_improve_pr" }[];
}

const isIgnored = (reason: string | null): boolean =>
  (IGNORED_REASONS as readonly string[]).includes(reason ?? "");

export function failureEvents(runs: RunRecord[], commits: CommitInfo[]): FailureEvent[] {
  const out: FailureEvent[] = [];
  for (const r of runs) {
    // improve 자신의 실패는 개선 후보나 run:<사유> 집계에 넣지 않는다.
    if (r.role === "improve") continue;
    const base = { issue: r.issue, pr: r.pr, ts: r.ts };
    if (!r.ok && r.role === "smoke") {
      out.push({
        ...base,
        key: "smoke",
        detail: typeof r.detail === "string" ? r.detail : null,
        distinctKey: r.ts.slice(0, 10),
      });
    } else if (!r.ok && !isIgnored(r.failureReason)) {
      out.push({
        ...base,
        key: `run:${r.failureReason ?? "unknown"}`,
        detail: null,
        distinctKey: `issue:${r.issue}`,
      });
    }
    if (r.role === "review")
      for (const f of r.findings ?? [])
        out.push({
          ...base,
          key: `review:${f.category}`,
          detail: `${f.file}: ${f.message}`,
          distinctKey: `issue:${r.issue}`,
        });
  }
  for (const c of commits) {
    if (!c.message.startsWith('Revert "')) continue;
    out.push({
      key: "revert",
      issue: parseFactoryIssues(c.message)[0] ?? null,
      pr: null,
      ts: c.date,
      detail: null,
      distinctKey: c.sha,
    });
  }
  return out;
}

export function rankCandidates(
  events: FailureEvent[],
  openImproveKeys: Set<string>,
): Pick<CollectResult, "candidates" | "excluded"> {
  const byKey = new Map<string, FailureEvent[]>();
  for (const e of events) byKey.set(e.key, [...(byKey.get(e.key) ?? []), e]);
  const candidates: Candidate[] = [];
  const excluded: CollectResult["excluded"] = [];
  for (const [key, evs] of byKey) {
    const distinct = new Set(evs.map((e) => e.distinctKey)).size;
    if (distinct < COLLECT.minDistinct) continue;
    if (openImproveKeys.has(key)) {
      excluded.push({ key, reason: "open_improve_pr" });
      continue;
    }
    const nums = (pick: (e: FailureEvent) => number | null): number[] =>
      [...new Set(evs.map(pick).filter((n): n is number => n !== null && n > 0))]
        .sort((a, b) => a - b)
        .slice(0, 50);
    const details = evs
      .filter((e) => e.detail !== null)
      .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
      .map((e) => (e.detail as string).slice(0, COLLECT.maxSampleChars));
    candidates.push({
      key: key.slice(0, 100),
      count: evs.length,
      distinct,
      issues: nums((e) => e.issue),
      prs: nums((e) => e.pr),
      samples: [...new Set(details)].slice(0, COLLECT.maxSamples),
    });
  }
  candidates.sort(
    (a, b) => b.distinct - a.distinct || b.count - a.count || a.key.localeCompare(b.key),
  );
  excluded.sort((a, b) => a.key.localeCompare(b.key));
  return { candidates, excluded };
}

export async function runCollect(deps: StageDeps): Promise<CollectResult> {
  const to = deps.now();
  const from = new Date(to.getTime() - COLLECT.windowDays * 24 * 60 * 60 * 1000);
  const [runs, commits, pulls, merged] = await Promise.all([
    deps.runs.since(from),
    deps.gh.listCommits(from),
    deps.gh.listOpenPulls(),
    deps.gh.listMergedPulls(from),
  ]);
  const improveKey = (p: { author: string; labels: string[]; body: string }): string | null => {
    if (p.author !== deps.settings.botLogin || !p.labels.includes(IMPROVE_LABEL)) return null;
    return readMarker(p.body, IMPROVE_MARKER, z.object({ key: z.string() }))?.key ?? null;
  };
  const openKeys = new Set<string>();
  for (const p of pulls) {
    const key = improveKey(p);
    if (key) openKeys.add(key);
  }
  // 병합된 개선 PR이 다룬 범주는 병합 전 이벤트를 세지 않는다. 개선 뒤에도 같은 실패가
  // 서로 다른 이슈 3건에서 다시 나와야 후보가 된다(같은 근거로 개선 PR을 반복하지 않는다).
  const improvedAt = new Map<string, number>();
  for (const p of merged) {
    const key = improveKey(p);
    if (key) improvedAt.set(key, Math.max(improvedAt.get(key) ?? 0, Date.parse(p.mergedAt)));
  }
  const events = failureEvents(runs, commits).filter(
    (e) => Date.parse(e.ts) > (improvedAt.get(e.key) ?? Number.NEGATIVE_INFINITY),
  );
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    events: events.length,
    ...rankCandidates(events, openKeys),
  };
}
