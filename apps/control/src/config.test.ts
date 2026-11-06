import { describe, expect, it } from "vitest";
import { DEFAULT_IMPLEMENT_MODEL, parseList, resolveModel } from "./config";

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
});
