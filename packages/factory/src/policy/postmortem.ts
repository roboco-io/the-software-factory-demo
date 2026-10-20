import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { FACTORY_DIR } from "../paths";

const Name = z.string().min(1);
const Positive = z.number().positive();

// YAML은 snake_case, 코드는 camelCase로 쓴다. 변환은 스키마가 맡는다.
export const PostmortemPolicySchema = z.object({
  triggers: z.object({
    production: z.array(Name),
    stall: z
      .object({ reasons: z.array(Name), exclude: z.array(Name) })
      .refine((s) => !s.reasons.some((r) => s.exclude.includes(r)), {
        message: "stall reason cannot be both listed and excluded",
      }),
  }),
  revert: z
    .object({ enabled: z.boolean(), reopen_request: z.boolean() })
    .transform((r) => ({ enabled: r.enabled, reopenRequest: r.reopen_request })),
  budget: z
    .object({
      per_incident_analyses: Positive.int(),
      per_analysis_usd: Positive,
      per_analysis_minutes: Positive,
      daily_usd: Positive,
    })
    .transform((b) => ({
      perIncidentAnalyses: b.per_incident_analyses,
      perAnalysisUsd: b.per_analysis_usd,
      perAnalysisMinutes: b.per_analysis_minutes,
      dailyUsd: b.daily_usd,
    })),
  report: z.object({ max_chars: Positive.int() }).transform((r) => ({ maxChars: r.max_chars })),
});

export type PostmortemPolicy = z.infer<typeof PostmortemPolicySchema>;

export function parsePostmortemPolicy(text: string): PostmortemPolicy {
  return PostmortemPolicySchema.parse(parse(text));
}

export function loadPostmortemPolicy(
  file = path.join(FACTORY_DIR, "postmortem-policy.yml"),
): PostmortemPolicy {
  return parsePostmortemPolicy(readFileSync(file, "utf8"));
}
