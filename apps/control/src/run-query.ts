import type { D1Like } from "./d1-repo";
import { costUsd } from "./pricing";

const DAY_MS = 86_400_000;
const LIST_LIMIT = 100;

export type Bucket = "attention" | "active" | "done";

export interface RunCost {
  status: "measured" | "not_measured" | "unknown";
  totalUsd: number | null;
  implementUsd: number | null;
  reviewUsd: number | null;
}

export interface RunSummary {
  id: string;
  repo: string;
  issueNumber: number;
  title: string | null;
  tier: string | null;
  state: string;
  reasonCode: string | null;
  prNumber: number | null;
  headSha: string | null;
  createdAt: number;
  updatedAt: number;
  bucket: Bucket;
  cost: RunCost;
}

export interface RunDetail extends RunSummary {
  events: {
    ts: number;
    kind: string;
    fromState: string | null;
    toState: string | null;
    reasonCode: string | null;
  }[];
}

export interface Totals {
  attention: number;
  active: number;
  done: number;
  usd: number | null;
}

const ATTENTION_STATES = new Set([
  "awaiting_approval",
  "needs_human",
  "failed",
]);

export function bucketOf(
  state: string,
  updatedAt: number,
  now: number,
): Bucket {
  if (state === "merged") return "done";
  if (ATTENTION_STATES.has(state)) {
    return now - updatedAt <= 7 * DAY_MS ? "attention" : "done";
  }
  return "active";
}

interface RunRow {
  id: string;
  repo: string;
  issue_number: number;
  title: string | null;
  tier: string | null;
  state: string;
  reason_code: string | null;
  pr_number: number | null;
  head_sha: string | null;
  created_at: number;
  updated_at: number;
}

interface UsageRow {
  run_id: string;
  phase: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

const RUN_COLUMNS =
  "id, repo, issue_number, title, tier, state, reason_code, pr_number, head_sha, created_at, updated_at";

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

function costOf(rows: UsageRow[] | undefined): RunCost {
  if (!rows || rows.length === 0) {
    return {
      status: "not_measured",
      totalUsd: null,
      implementUsd: null,
      reviewUsd: null,
    };
  }
  let implementUsd = 0;
  let reviewUsd = 0;
  for (const r of rows) {
    const usd = costUsd(r.model, {
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens,
      cacheWriteTokens: r.cache_write_tokens,
    });
    if (usd === null) {
      return {
        status: "unknown",
        totalUsd: null,
        implementUsd: null,
        reviewUsd: null,
      };
    }
    if (r.phase === "review") reviewUsd += usd;
    else implementUsd += usd;
  }
  return {
    status: "measured",
    totalUsd: implementUsd + reviewUsd,
    implementUsd,
    reviewUsd,
  };
}

async function usageByRun(
  db: D1Like,
  ids: string[],
): Promise<Map<string, UsageRow[]>> {
  const map = new Map<string, UsageRow[]>();
  if (ids.length === 0) return map;
  const { results } = await db
    .prepare(
      `SELECT run_id, phase, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
       FROM run_usage WHERE run_id IN (${placeholders(ids.length)}) ORDER BY id`,
    )
    .bind(...ids)
    .all<UsageRow>();
  for (const row of results) {
    const list = map.get(row.run_id) ?? [];
    list.push(row);
    map.set(row.run_id, list);
  }
  return map;
}

function summarize(
  r: RunRow,
  usage: UsageRow[] | undefined,
  now: number,
): RunSummary {
  return {
    id: r.id,
    repo: r.repo,
    issueNumber: r.issue_number,
    title: r.title,
    tier: r.tier,
    state: r.state,
    reasonCode: r.reason_code,
    prNumber: r.pr_number,
    headSha: r.head_sha,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    bucket: bucketOf(r.state, r.updated_at, now),
    cost: costOf(usage),
  };
}

export async function listRuns(
  db: D1Like,
  opts: { publicRepos: string[]; now: number },
): Promise<{ runs: RunSummary[]; totals: Totals }> {
  const totals: Totals = { attention: 0, active: 0, done: 0, usd: 0 };
  if (opts.publicRepos.length === 0) return { runs: [], totals };
  const { results } = await db
    .prepare(
      `SELECT ${RUN_COLUMNS} FROM runs WHERE repo IN (${placeholders(opts.publicRepos.length)})
       ORDER BY updated_at DESC, created_at DESC, id DESC LIMIT ${LIST_LIMIT}`,
    )
    .bind(...opts.publicRepos)
    .all<RunRow>();
  const usage = await usageByRun(
    db,
    results.map((r) => r.id),
  );
  const runs = results.map((r) => summarize(r, usage.get(r.id), opts.now));
  // Array.sort is stable, so newest-first order is kept inside each bucket.
  runs.sort(
    (a, b) =>
      (a.bucket === "attention" ? 0 : 1) - (b.bucket === "attention" ? 0 : 1),
  );
  let unknown = false;
  for (const run of runs) {
    totals[run.bucket] += 1;
    if (run.cost.status === "unknown") unknown = true;
    else if (run.cost.totalUsd !== null && totals.usd !== null)
      totals.usd += run.cost.totalUsd;
  }
  if (unknown) totals.usd = null;
  return { runs, totals };
}

export async function getRun(
  db: D1Like,
  id: string,
  opts: { publicRepos: string[]; now: number },
): Promise<RunDetail | null> {
  if (opts.publicRepos.length === 0) return null;
  const row = await db
    .prepare(
      `SELECT ${RUN_COLUMNS} FROM runs WHERE id = ? AND repo IN (${placeholders(opts.publicRepos.length)})`,
    )
    .bind(id, ...opts.publicRepos)
    .first<RunRow>();
  if (!row) return null;
  const usage = await usageByRun(db, [row.id]);
  const { results } = await db
    .prepare(
      "SELECT ts, kind, from_state, to_state, reason_code FROM events WHERE run_id = ? ORDER BY id ASC",
    )
    .bind(row.id)
    .all<{
      ts: number;
      kind: string;
      from_state: string | null;
      to_state: string | null;
      reason_code: string | null;
    }>();
  return {
    ...summarize(row, usage.get(row.id), opts.now),
    events: results.map((e) => ({
      ts: e.ts,
      kind: e.kind,
      fromState: e.from_state,
      toState: e.to_state,
      reasonCode: e.reason_code,
    })),
  };
}
