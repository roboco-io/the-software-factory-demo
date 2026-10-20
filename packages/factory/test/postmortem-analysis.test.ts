import { describe, expect, it } from "vitest";
import { PostmortemAnalysisSchema } from "../src/postmortem/analysis";

const valid = {
  classification: "bot_regression",
  causePr: 66,
  excerptQuote: "TypeError: x is undefined",
  rootCause: [{ text: "PR 66이 x 초기화를 지웠다", kind: "fact" }],
  defenses: [{ text: "스모크가 이 경로를 확인하지 않았다", kind: "guess" }],
  actions: ["회귀 테스트 추가"],
  summary: "배포 후 기사 목록이 실패했다.",
};

describe("PostmortemAnalysisSchema", () => {
  it("accepts a complete analysis", () => {
    expect(PostmortemAnalysisSchema.parse(valid)).toEqual(valid);
  });

  it("accepts null causePr and excerptQuote", () => {
    const a = { ...valid, classification: "external", causePr: null, excerptQuote: null };
    expect(PostmortemAnalysisSchema.parse(a).causePr).toBeNull();
  });

  it.each([
    ["unknown classification", { classification: "bug" }],
    ["non-positive causePr", { causePr: 0 }],
    ["fractional causePr", { causePr: 1.5 }],
    ["unknown kind", { rootCause: [{ text: "t", kind: "maybe" }] }],
    ["missing summary", { summary: undefined }],
  ])("rejects %s", (_name, patch) => {
    expect(PostmortemAnalysisSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});
