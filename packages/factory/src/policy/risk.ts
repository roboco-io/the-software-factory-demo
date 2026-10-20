import { readFileSync } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { parse } from "yaml";
import { z } from "zod";
import { FACTORY_DIR } from "../paths";

export const TIERS = ["T0", "T1", "T2", "T3"] as const;
export type Tier = (typeof TIERS)[number];

const TierSchema = z.enum(TIERS);
const PolicySchema = z.object({
  default: TierSchema,
  requiredChecks: z.array(z.string().min(1)).min(1),
  rules: z
    .array(z.object({ tier: TierSchema, patterns: z.array(z.string().min(1)).min(1) }))
    .min(1),
});

export type RiskPolicy = z.infer<typeof PolicySchema>;

export interface FileTier {
  file: string;
  tier: Tier;
  pattern: string | null;
}

export interface RiskResult {
  tier: Tier;
  files: FileTier[];
}

/**
 * PR의 변경 파일 한 건. `additions`는 이 파일에서 추가된 줄의 내용(diff의 `+` 접두사 제외)이다.
 * runRisk가 봇 implement PR의 `tests/realworld/skip.txt` 추가 줄을 금지할 때 쓴다(F21).
 */
export interface ChangedFile {
  filename: string;
  previousFilename?: string;
  additions: string[];
  /** 이 파일에서 삭제된 줄의 내용(diff의 `-` 접두사 제외). 포스트모템 타임라인이 쓴다. */
  deletions?: string[];
  /** API가 알려 준 추가 줄 수. patch가 잘리거나 없을 때 `additions`와 비교한다. */
  additionCount?: number;
  /** GitHub가 patch를 주지 않았다(바이너리 또는 큰 diff). */
  patchMissing?: boolean;
  /** GitHub가 이 파일을 삭제(status "removed")로 보고했다. evidence는 삭제된 테스트를 실행 대상에서 뺀다. */
  removed?: boolean;
}

/**
 * unified diff patch에서 추가된 줄의 내용만 뽑는다.
 * GitHub API의 patch에는 `---`/`+++` 파일 헤더가 없다. 첫 `@@` 앞의 헤더 줄만 건너뛰고,
 * 그 뒤의 `+`로 시작하는 줄은 내용이 `++`로 시작해도 추가된 줄로 센다(F22).
 */
export function addedLinesFromPatch(patch: string | undefined): string[] {
  if (!patch) return [];
  const out: string[] = [];
  let inHunk = false;
  for (const l of patch.split("\n")) {
    if (!inHunk) {
      if (l.startsWith("@@")) inHunk = true;
      continue;
    }
    if (l.startsWith("+")) out.push(l.slice(1));
  }
  return out;
}

/** unified diff patch에서 삭제된 줄의 내용만 뽑는다. 헤더 처리는 addedLinesFromPatch와 같다. */
export function deletedLinesFromPatch(patch: string | undefined): string[] {
  if (!patch) return [];
  const out: string[] = [];
  let inHunk = false;
  for (const l of patch.split("\n")) {
    if (!inHunk) {
      if (l.startsWith("@@")) inHunk = true;
      continue;
    }
    if (l.startsWith("-")) out.push(l.slice(1));
  }
  return out;
}

export function parseRiskPolicy(text: string): RiskPolicy {
  return PolicySchema.parse(parse(text));
}

export function loadRiskPolicy(file = path.join(FACTORY_DIR, "risk-policy.yml")): RiskPolicy {
  return parseRiskPolicy(readFileSync(file, "utf8"));
}

export function maxTier(a: Tier, b: Tier): Tier {
  return TIERS.indexOf(a) >= TIERS.indexOf(b) ? a : b;
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

export function tierOf(file: string, policy: RiskPolicy): FileTier {
  const f = normalizePath(file);
  for (const rule of policy.rules) {
    for (const pattern of rule.patterns) {
      // T3는 대소문자를 무시한다. 대소문자 무시 파일시스템에서 Agents.md 같은 이름으로 에이전트 지침을 바꾸는 우회를 막는다.
      if (picomatch.isMatch(f, pattern, { dot: true, nocase: rule.tier === "T3" }))
        return { file: f, tier: rule.tier, pattern };
    }
  }
  return { file: f, tier: policy.default, pattern: null };
}

export function classifyFiles(files: string[], policy: RiskPolicy): RiskResult {
  const unique = [...new Set(files.map(normalizePath))].filter((f) => f.length > 0);
  const tiers = unique.map((f) => tierOf(f, policy));
  return { tier: tiers.reduce<Tier>((acc, t) => maxTier(acc, t.tier), "T0"), files: tiers };
}
