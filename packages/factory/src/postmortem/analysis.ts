import { z } from "zod";

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
