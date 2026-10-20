export const RAW =
  "https://raw.githubusercontent.com/roboco-io/the-software-factory-demo/factory-data";

export interface Run {
  ts: string;
  issue: number;
  role: string;
  engine: string | null;
  model?: string | null;
  ok: boolean;
  costUsd: number | null;
  failureReason: string | null;
  findings?: { category: string }[];
  incident?: {
    key: string;
    kind: string;
    phase: "initial" | "followup";
    detectedAt: string;
    recoveredAt: string | null;
    causePr: number | null;
    reverted: boolean;
    classification: string | null;
  };
}

function isRun(v: unknown): v is Run {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.ts === "string" &&
    typeof r.issue === "number" &&
    typeof r.role === "string" &&
    typeof r.ok === "boolean"
  );
}

// 깨진 줄과 필수 필드가 없는 줄은 버린다.
export function parseRuns(text: string): Run[] {
  const out: Run[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (isRun(v)) {
        out.push({
          ...v,
          engine: v.engine ?? null,
          model: typeof v.model === "string" && v.model.trim() ? v.model : null,
          costUsd: typeof v.costUsd === "number" ? v.costUsd : null,
          failureReason: v.failureReason ?? null,
        });
      }
    } catch {
      // 깨진 줄은 건너뛴다.
    }
  }
  return out;
}

// 오래된 달부터. 예: ["2026-08", "2026-09", "2026-10"]
export function recentMonths(now: Date, count: number): string[] {
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

// 404인 달은 건너뛴다. 그 밖의 오류는 예외다.
export async function loadRuns(now: Date, f: typeof fetch): Promise<Run[]> {
  const runs: Run[] = [];
  for (const month of recentMonths(now, 3)) {
    const res = await f(`${RAW}/runs/${month}.jsonl`);
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`runs/${month}.jsonl: HTTP ${res.status}`);
    runs.push(...parseRuns(await res.text()));
  }
  return runs;
}

export async function loadImprovements(
  f: typeof fetch,
): Promise<{ pr: number; key: string; mergedAt: string }[]> {
  const res = await f(`${RAW}/improvements.json`);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`improvements.json: HTTP ${res.status}`);
  const v: unknown = await res.json();
  if (!Array.isArray(v)) return [];
  return v.filter(
    (i): i is { pr: number; key: string; mergedAt: string } =>
      typeof i?.pr === "number" && typeof i?.key === "string" && typeof i?.mergedAt === "string",
  );
}
