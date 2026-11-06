import { describe, expect, it } from "vitest";
import {
  DEFAULT_IMPLEMENT_MODEL,
  DEFAULT_REVIEW_MODEL,
  parseList,
  resolveModel,
  resolveReviewModel,
} from "./config";

describe("config", () => {
  it("parses comma lists exactly and treats empty as nothing", () => {
    expect(parseList(undefined)).toEqual([]);
    expect(parseList("")).toEqual([]);
    expect(parseList(" , ,")).toEqual([]);
    expect(parseList("alice, bob ,Carol")).toEqual(["alice", "bob", "Carol"]);
  });
  it("uses the default model unless a valid one is set", () => {
    expect(resolveModel(undefined)).toBe(DEFAULT_IMPLEMENT_MODEL);
    expect(resolveModel("")).toBe(DEFAULT_IMPLEMENT_MODEL);
    expect(resolveModel("--evil")).toBe(DEFAULT_IMPLEMENT_MODEL);
    expect(resolveModel("a b")).toBe(DEFAULT_IMPLEMENT_MODEL);
    expect(resolveModel("claude-opus-5")).toBe("claude-opus-5");
    expect(DEFAULT_IMPLEMENT_MODEL).toBe("claude-sonnet-5-5");
  });
  it("uses gpt-5.4-nano as the review model unless a valid one is set", () => {
    expect(DEFAULT_REVIEW_MODEL).toBe("gpt-5.4-nano");
    expect(resolveReviewModel(undefined)).toBe("gpt-5.4-nano");
    expect(resolveReviewModel("")).toBe("gpt-5.4-nano");
    expect(resolveReviewModel("--evil")).toBe("gpt-5.4-nano");
    expect(resolveReviewModel("gpt-5.5")).toBe("gpt-5.5");
  });
});
