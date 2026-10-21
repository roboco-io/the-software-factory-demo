import { describe, expect, it } from "vitest";
import { bookUrl, kindLabel } from "./book";

describe("bookUrl", () => {
  it.each([
    ["preface", null, "https://factory.roboco.io/book/preface/"],
    ["ch05", "s03", "https://factory.roboco.io/book/ch05/#s03"],
    ["p01", "s02", "https://factory.roboco.io/patterns/p01/#s02"],
    ["demo-request", null, "https://factory.roboco.io/demo/request/"],
  ])("%s#%s → %s", (docId, anchor, url) => {
    expect(bookUrl(docId, anchor)).toBe(url);
  });

  it("returns null for an unknown document id", () => {
    expect(bookUrl("x9", null)).toBeNull();
  });
});

describe("kindLabel", () => {
  it("names each topic kind in Korean", () => {
    expect([
      kindLabel("question"),
      kindLabel("argument"),
      kindLabel("case"),
      kindLabel("general"),
    ]).toEqual(["질문", "반론", "사례", "일반"]);
  });
});
