import type { Run } from "./data";

export interface Improvement {
  pr: number;
  key: string;
  mergedAt: string;
}

export interface IssueStory {
  issue: number;
  firstAt: string;
  latestAt: string;
  deployed: boolean;
  pr: number | null;
  steps: Run[];
}

export interface RoleStat {
  engine: string;
  model: string | null;
  role: string;
  ok: number;
  n: number;
  costUsd: number;
  costRuns: number;
}

export interface EvidencePeriod {
  events: number | null;
  issues: number | null;
  affectedIssues: number | null;
  days: number | null;
  coverage: "complete" | "partial" | "unavailable";
  startAt: string | null;
  endAt: string | null;
}

export interface ImprovementStory extends Improvement {
  before: EvidencePeriod;
  after: EvidencePeriod;
  enoughSamples: boolean;
  supported: boolean;
}

const PIPELINE_ROLES = new Set([
  "triage",
  "command",
  "implement",
  "review",
  "fix",
  "gate",
  "deploy",
]);
const AGENT_ROLES = new Set(["triage", "implement", "review", "fix", "improve", "postmortem"]);
const POLICY_HOLDS = new Set(["risk_t2", "risk_t3", "permission_denied"]);
const DAY_MS = 86_400_000;
const positiveId = (id: number) => Number.isFinite(id) && id > 0;
const validTime = (run: Run) => Number.isFinite(Date.parse(run.ts));

export function issueStories(runs: Run[], limit = 6): IssueStory[] {
  const byIssue = new Map<number, Run[]>();
  for (const run of runs) {
    if (!positiveId(run.issue) || !PIPELINE_ROLES.has(run.role) || !validTime(run)) continue;
    const steps = byIssue.get(run.issue) ?? [];
    steps.push(run);
    byIssue.set(run.issue, steps);
  }
  return [...byIssue.entries()]
    .map(([issue, steps]): IssueStory => {
      steps.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
      let deployed = false;
      let pr: number | null = null;
      for (const step of steps) {
        if (step.role === "deploy") deployed = step.ok;
        const linkedPr = (step as Run & { pr?: number }).pr;
        if (typeof linkedPr === "number" && positiveId(linkedPr)) pr = linkedPr;
      }
      return {
        issue,
        firstAt: steps[0]!.ts,
        latestAt: steps[steps.length - 1]!.ts,
        deployed,
        pr,
        steps,
      };
    })
    .sort((a, b) => Date.parse(b.latestAt) - Date.parse(a.latestAt) || a.issue - b.issue)
    .slice(0, Math.max(0, limit));
}

export function roleStats(runs: Run[]): RoleStat[] {
  const byRole = new Map<string, RoleStat>();
  for (const run of runs) {
    if (!AGENT_ROLES.has(run.role) || !run.engine || !validTime(run)) continue;
    const reportedModel = (run as Run & { model?: unknown }).model;
    const model = typeof reportedModel === "string" && reportedModel.trim() ? reportedModel : null;
    const key = JSON.stringify([run.engine, model, run.role]);
    const stat = byRole.get(key) ?? {
      engine: run.engine,
      model,
      role: run.role,
      ok: 0,
      n: 0,
      costUsd: 0,
      costRuns: 0,
    };
    stat.n++;
    if (run.ok) stat.ok++;
    if (typeof run.costUsd === "number" && Number.isFinite(run.costUsd) && run.costUsd >= 0) {
      stat.costUsd += run.costUsd;
      stat.costRuns++;
    }
    byRole.set(key, stat);
  }
  return [...byRole.values()].sort(
    (a, b) =>
      a.role.localeCompare(b.role) ||
      a.engine.localeCompare(b.engine) ||
      (a.model === b.model
        ? 0
        : a.model === null
          ? -1
          : b.model === null
            ? 1
            : a.model.localeCompare(b.model)),
  );
}

// These are observations from loaded records, not evidence of causal effectiveness.
export function improvementStories(
  runs: Run[],
  improvements: Improvement[],
  now: Date,
): ImprovementStory[] {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return [];
  const loadedSince = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1);
  const unsupportedPeriod = (): EvidencePeriod => ({
    events: null,
    issues: null,
    affectedIssues: null,
    days: null,
    coverage: "unavailable",
    startAt: null,
    endAt: null,
  });
  const supportsKey = (key: string) =>
    key === "smoke" ||
    (key.startsWith("review:") && key.slice(7).trim().length > 0) ||
    (key.startsWith("run:") && key.slice(4).trim().length > 0);
  const eligible = runs.filter(
    (run) =>
      positiveId(run.issue) &&
      validTime(run) &&
      Date.parse(run.ts) <= nowMs &&
      run.role !== "improve" &&
      !POLICY_HOLDS.has(run.failureReason ?? ""),
  );

  function evidence(key: string, start: number, end: number, includeEnd: boolean): EvidencePeriod {
    if (!supportsKey(key)) return unsupportedPeriod();
    const observedStart = Math.max(start, loadedSince);
    const observedEnd = Math.min(end, nowMs);
    if (observedEnd < observedStart || (observedEnd === observedStart && !includeEnd))
      return unsupportedPeriod();
    const coverage = observedStart === start && observedEnd === end ? "complete" : "partial";
    const issues = new Set<number>();
    const affected = new Set<number>();
    let events = 0;
    for (const run of eligible) {
      const ts = Date.parse(run.ts);
      if (ts < observedStart || (includeEnd ? ts > observedEnd : ts >= observedEnd)) continue;
      let matches: number;
      if (key.startsWith("review:")) {
        if (run.role !== "review") continue;
        matches = Array.isArray(run.findings)
          ? run.findings.filter((finding) => finding?.category === key.slice(7)).length
          : 0;
      } else if (key === "smoke") {
        if (run.role !== "smoke") continue;
        matches = run.ok ? 0 : 1;
      } else if (key.startsWith("run:")) {
        matches = !run.ok && (run.failureReason ?? "unknown") === key.slice(4) ? 1 : 0;
      } else {
        continue;
      }
      issues.add(run.issue);
      events += matches;
      if (matches > 0) affected.add(run.issue);
    }
    return {
      events,
      issues: issues.size,
      affectedIssues: affected.size,
      days: (observedEnd - observedStart) / DAY_MS,
      coverage,
      startAt: new Date(observedStart).toISOString(),
      endAt: new Date(observedEnd).toISOString(),
    };
  }

  return improvements
    .filter(
      (improvement) =>
        Number.isFinite(Date.parse(improvement.mergedAt)) &&
        Date.parse(improvement.mergedAt) <= nowMs,
    )
    .map((improvement): ImprovementStory => {
      const merged = Date.parse(improvement.mergedAt);
      const before = evidence(improvement.key, merged - 28 * DAY_MS, merged, false);
      const after = evidence(improvement.key, merged, Math.min(nowMs, merged + 28 * DAY_MS), true);
      return {
        ...improvement,
        before,
        after,
        supported: supportsKey(improvement.key),
        enoughSamples:
          supportsKey(improvement.key) &&
          before.coverage === "complete" &&
          after.coverage === "complete" &&
          (before.issues ?? 0) >= 5 &&
          (after.issues ?? 0) >= 5,
      };
    })
    .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt) || b.pr - a.pr);
}

export interface IncidentRow {
  key: string;
  issue: number;
  kind: string;
  detectedAt: string;
  recoveredAt: string | null;
  mttrMinutes: number | null;
  causePr: number | null;
  reverted: boolean;
  classification: string | null;
}

// 같은 key의 initial·followup 레코드를 한 행으로 합친다. 뒤 단계 값이 앞 단계 값보다 우선한다.
export function incidents(runs: Run[]): IncidentRow[] {
  const byKey = new Map<string, IncidentRow>();
  const ordered = runs
    .filter((run) => run.incident && typeof run.incident.key === "string" && validTime(run))
    .sort(
      (a, b) =>
        Number(a.incident!.phase === "followup") - Number(b.incident!.phase === "followup") ||
        Date.parse(a.ts) - Date.parse(b.ts),
    );
  for (const run of ordered) {
    const i = run.incident!;
    const prev = byKey.get(i.key);
    byKey.set(i.key, {
      key: i.key,
      issue: run.issue,
      kind: i.kind,
      detectedAt: prev?.detectedAt ?? i.detectedAt,
      recoveredAt: i.recoveredAt ?? prev?.recoveredAt ?? null,
      mttrMinutes: null,
      causePr: i.causePr ?? prev?.causePr ?? null,
      reverted: i.reverted || (prev?.reverted ?? false),
      classification: i.classification ?? prev?.classification ?? null,
    });
  }
  return [...byKey.values()]
    .map((row) => {
      const start = Date.parse(row.detectedAt);
      const end = row.recoveredAt ? Date.parse(row.recoveredAt) : NaN;
      const mttrMinutes =
        Number.isFinite(start) && Number.isFinite(end) && end >= start
          ? Math.round((end - start) / 60_000)
          : null;
      return { ...row, mttrMinutes };
    })
    .sort(
      (a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt) || a.key.localeCompare(b.key),
    );
}
