import type { Role } from "../agents/types";
import { BranchNotFoundError, ConflictError, type GitHubPort } from "../github/port";

export type RunRole = Role | "command" | "gate" | "deploy" | "intake" | "smoke";

export interface RunFinding {
  category: string;
  file: string;
  message: string;
}

export interface RunRecord {
  ts: string;
  issue: number;
  pr: number | null;
  role: RunRole;
  engine: string | null;
  model: string | null;
  ok: boolean;
  turns: number;
  costUsd: number | null;
  durationMs: number;
  failureReason: string | null;
  round: number;
  findings?: RunFinding[];
  // 스모크 실패처럼 사유 코드만으로 원인을 알 수 없을 때 남기는 실패 원문 발췌(최대 1000자).
  detail?: string;
}

export interface RunStore {
  append(record: RunRecord): Promise<void>;
  since(from: Date): Promise<RunRecord[]>;
}

export const DATA_BRANCH = "factory-data";
export const MAX_APPEND_ATTEMPTS = 4; // 첫 시도 + 재시도 3회(spec 5.6)

export function monthPath(d: Date): string {
  return `runs/${d.toISOString().slice(0, 7)}.jsonl`;
}

export function monthsBetween(from: Date, to: Date): string[] {
  const out: string[] = [];
  let y = from.getUTCFullYear();
  let m = from.getUTCMonth();
  const endY = to.getUTCFullYear();
  const endM = to.getUTCMonth();
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m + 1).padStart(2, "0")}`);
    m++;
    if (m === 12) {
      m = 0;
      y++;
    }
  }
  return out;
}

export function parseRecords(text: string): RunRecord[] {
  const out: RunRecord[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t) as RunRecord;
      if (typeof r.ts === "string" && typeof r.role === "string" && typeof r.ok === "boolean")
        out.push(r);
    } catch {
      // 깨진 줄은 집계에서 뺀다. 원본은 브랜치에 남는다.
    }
  }
  return out;
}

export function createRunStore(gh: GitHubPort, now: () => Date = () => new Date()): RunStore {
  return {
    async append(record) {
      const file = monthPath(new Date(record.ts));
      let created = false;
      for (let attempt = 1; ; attempt++) {
        const cur = await gh.readFile(DATA_BRANCH, file);
        const prev = cur?.content ?? "";
        const prefix = prev.length > 0 && !prev.endsWith("\n") ? `${prev}\n` : prev;
        try {
          await gh.writeFile(
            DATA_BRANCH,
            file,
            `${prefix}${JSON.stringify(record)}\n`,
            cur?.sha ?? null,
            `run: ${record.role} #${record.issue}`,
          );
          return;
        } catch (e) {
          if (e instanceof BranchNotFoundError && !created) {
            created = true;
            await gh.createOrphanBranch(
              DATA_BRANCH,
              { "README.md": "factory run records\n" },
              "init factory-data",
            );
            attempt--;
            continue;
          }
          if (!(e instanceof ConflictError) || attempt >= MAX_APPEND_ATTEMPTS) throw e;
        }
      }
    },
    async since(from) {
      const all: RunRecord[] = [];
      for (const month of monthsBetween(from, now())) {
        const f = await gh.readFile(DATA_BRANCH, `runs/${month}.jsonl`);
        if (f) all.push(...parseRecords(f.content));
      }
      return all.filter((r) => Date.parse(r.ts) >= from.getTime());
    },
  };
}
