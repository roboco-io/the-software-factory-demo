import { z } from "zod";
import type { MergedPull } from "../github/port";
import { tierOf, type Tier } from "../policy/risk";
import { parseFactoryIssues } from "../report/commit";
import { parsePrMeta } from "../report/pr";
import { readMarker } from "../report/text";
import type { RunRecord } from "../runs/store";
import type { StageDeps } from "../stages/deps";
import { checkState, type CheckState } from "../stages/gate";
import type { Incident } from "./incident";

export const ERROR_FIRST_SEEN_MARKER = "factory:error-first-seen";
const FirstSeenSchema = z.object({ at: z.string().max(40) });
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

export interface CandidatePr {
  number: number;
  title: string;
  author: "bot" | "human";
  mergedAt: string;
  mergeSha: string | null;
  tier: Tier;
  files: { path: string; tier: Tier; deletions: string[]; additions: string[] }[];
  checks: { name: string; state: CheckState }[];
  requestIssue: number | null;
}

export interface Timeline {
  incident: Incident;
  excerpt: string | null;
  candidates: CandidatePr[];
  runs: RunRecord[];
  windowStart: string;
}

const TIER_ORDER: Tier[] = ["T0", "T1", "T2", "T3"];

function requestIssueOf(p: MergedPull): number | null {
  return parsePrMeta(p.body)?.issue ?? parseFactoryIssues(p.body)[0] ?? null;
}

async function describePull(deps: StageDeps, p: MergedPull): Promise<CandidatePr> {
  const files = (await deps.gh.listPullFiles(p.number)).map((f) => ({
    path: f.filename,
    tier: tierOf(f.filename, deps.policy).tier,
    deletions: f.deletions ?? [],
    additions: f.additions,
  }));
  const tier = files.reduce<Tier>(
    (acc, f) => (TIER_ORDER.indexOf(f.tier) > TIER_ORDER.indexOf(acc) ? f.tier : acc),
    "T0",
  );
  const runs = p.headSha ? await deps.gh.listCheckRuns(p.headSha) : [];
  return {
    number: p.number,
    title: p.title,
    author: p.author === deps.settings.botLogin ? "bot" : "human",
    mergedAt: p.mergedAt,
    mergeSha: p.mergeSha,
    tier,
    files,
    checks: runs.map((r) => ({ name: r.name, state: checkState(r) })),
    requestIssue: requestIssueOf(p),
  };
}

function windowStartOf(i: Incident, firstSeen: string | null): string {
  const back = (iso: string) => new Date(new Date(iso).getTime() - LOOKBACK_MS).toISOString();
  if (i.kind === "error") return back(firstSeen ?? i.detectedAt);
  return i.lastGoodAt ?? back(i.detectedAt);
}

export async function collectTimeline(
  deps: StageDeps,
  incident: Incident,
  opts: { excerptOverride?: string } = {},
): Promise<Timeline> {
  const issue = await deps.gh.getIssue(incident.issue);
  const firstSeen =
    incident.kind === "error"
      ? (readMarker(issue.body, ERROR_FIRST_SEEN_MARKER, FirstSeenSchema)?.at ?? null)
      : null;
  const windowStart = windowStartOf(incident, firstSeen);
  const merged = (await deps.gh.listMergedPulls(new Date(windowStart))).filter(
    (p) => p.mergedAt >= windowStart && p.mergedAt <= incident.detectedAt,
  );
  // 배포 실패·정체는 요청 이슈의 PR 하나만 본다.
  const picked =
    incident.kind === "deploy" || incident.kind === "stall"
      ? merged.filter((p) => requestIssueOf(p) === incident.issue)
      : merged;
  const candidates: CandidatePr[] = [];
  for (const p of picked) candidates.push(await describePull(deps, p));

  const records = await deps.runs.since(new Date(0));
  const issues = new Set([incident.issue, ...candidates.flatMap((c) => c.requestIssue ?? [])]);
  const runs = records.filter((r) => r.ts >= windowStart && issues.has(r.issue));
  const firstFailure = records.find(
    (r) => r.issue === incident.issue && !r.ok && r.ts >= incident.detectedAt,
  );
  return {
    incident,
    excerpt: opts.excerptOverride ?? firstFailure?.detail ?? null,
    candidates,
    runs,
    windowStart,
  };
}
