import { z } from "zod";
import type { PostmortemPolicy } from "../policy/postmortem";
import type { CandidatePr, Timeline } from "./timeline";

const Statement = z.object({ text: z.string(), kind: z.enum(["fact", "guess"]) });

// 포스트모템 에이전트의 출력. 되돌리기 판정은 이 값을 믿지 않고 코드가 타임라인과 대조한다.
export const PostmortemAnalysisSchema = z.object({
  classification: z.enum(["bot_regression", "human_regression", "external", "stall"]),
  causePr: z.number().int().positive().nullable(),
  // 실패 원문에서 그대로 인용한 부분
  excerptQuote: z.string().nullable(),
  rootCause: z.array(Statement),
  // 막지 못한 방어선
  defenses: z.array(Statement),
  actions: z.array(z.string()),
  summary: z.string(),
});

export type PostmortemAnalysis = z.infer<typeof PostmortemAnalysisSchema>;

export type RevertRefusal =
  | "disabled"
  | "not_production_breakage"
  | "not_regression"
  | "no_cause"
  | "unknown_cause"
  | "no_excerpt"
  | "quote_not_in_excerpt"
  | "no_overlap"
  | "already_reverted";

export type RevertDecision =
  { revert: true; pr: CandidatePr } | { revert: false; reason: RevertRefusal };

const TOKEN = /[\p{L}\p{N}_-]{4,}/gu;

// 인용에서 뽑은 단어가 원인 PR의 변경 줄이나 파일 경로에 나오면 실패 원문과 변경이 겹친다고 본다.
function overlaps(quote: string, pr: CandidatePr): boolean {
  const tokens = [...new Set(quote.toLowerCase().match(TOKEN) ?? [])];
  return pr.files.some((f) => {
    const path = f.path.toLowerCase();
    const lines = [...f.deletions, ...f.additions].map((l) => l.toLowerCase());
    return tokens.some((t) => path.includes(t) || lines.some((l) => l.includes(t)));
  });
}

// 되돌리기 판정은 에이전트가 아니라 코드가 한다(spec 4.4 조건 1-4). 조건 5(충돌)는 git 결과로 따로 판정한다.
export function decideRevert(
  t: Timeline,
  a: PostmortemAnalysis,
  policy: PostmortemPolicy,
): RevertDecision {
  const no = (reason: RevertRefusal): RevertDecision => ({ revert: false, reason });
  if (!policy.revert.enabled) return no("disabled");
  if (t.incident.kind === "deploy" || t.incident.kind === "stall") {
    return no("not_production_breakage");
  }
  if (a.classification !== "bot_regression" && a.classification !== "human_regression") {
    return no("not_regression");
  }
  if (a.causePr === null) return no("no_cause");
  const cause = t.candidates.find((c) => c.number === a.causePr);
  if (!cause) return no("unknown_cause");
  if (t.excerpt === null) return no("no_excerpt");
  if (!a.excerptQuote || !t.excerpt.includes(a.excerptQuote)) return no("quote_not_in_excerpt");
  if (!overlaps(a.excerptQuote, cause)) return no("no_overlap");
  const number = new RegExp(`(?<![\\p{L}\\p{N}])${cause.number}(?![\\p{L}\\p{N}])`, "u");
  const reverted = t.candidates.some(
    (c) => c.mergedAt > cause.mergedAt && /revert/i.test(c.title) && number.test(c.title),
  );
  if (reverted) return no("already_reverted");
  return { revert: true, pr: cause };
}
