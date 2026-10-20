import { describe, expect, it } from "vitest";
import { loadPostmortemPolicy, parsePostmortemPolicy } from "../src/policy/postmortem";

function yamlWith(over: { reasons?: string; exclude?: string; dailyUsd?: number } = {}): string {
  return `
triggers:
  production: [source:smoke]
  stall:
    reasons: ${over.reasons ?? "[max_turns, timeout]"}
    exclude: ${over.exclude ?? "[risk_t2]"}
revert:
  enabled: true
  reopen_request: true
budget:
  per_incident_analyses: 2
  per_analysis_usd: 2
  per_analysis_minutes: 15
  daily_usd: ${over.dailyUsd ?? 10}
report:
  max_chars: 6000
`;
}

describe("postmortem policy", () => {
  it("loads the repository policy with the spec defaults", () => {
    const p = loadPostmortemPolicy();
    expect(p.budget).toEqual({
      perIncidentAnalyses: 2,
      perAnalysisUsd: 2,
      perAnalysisMinutes: 15,
      dailyUsd: 10,
    });
    expect(p.report.maxChars).toBe(6000);
    expect(p.revert).toEqual({ enabled: true, reopenRequest: true });
    expect(p.triggers.production).toEqual(["source:smoke", "source:deploy", "source:error"]);
    expect(p.triggers.stall.exclude).toEqual([
      "risk_t2",
      "risk_t3",
      "permission_denied",
      "deploy_failed",
    ]);
    expect(p.triggers.stall.reasons).toEqual([
      "max_turns",
      "timeout",
      "budget",
      "engine_error",
      "invalid_output",
      "merge_refused",
      "smoke_contract",
      "preview_deploy",
      "human_action",
      "unlisted_check",
      "risk_tier",
      "too_many_files",
      "skip_txt",
      "review_needs_human",
    ]);
  });

  it("parses snake_case keys into camelCase", () => {
    const p = parsePostmortemPolicy(yamlWith());
    expect(p.budget.perIncidentAnalyses).toBe(2);
    expect(p.revert.reopenRequest).toBe(true);
  });

  it("rejects a reason listed as both stall and excluded", () => {
    expect(() =>
      parsePostmortemPolicy(yamlWith({ reasons: "[risk_t2, timeout]", exclude: "[risk_t2]" })),
    ).toThrow();
  });

  it("rejects non-positive budgets", () => {
    expect(() => parsePostmortemPolicy(yamlWith({ dailyUsd: 0 }))).toThrow();
  });
});
