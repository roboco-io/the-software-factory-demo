import { describe, expect, it } from "vitest";
import { z } from "zod";
import { readMarker, writeMarker } from "../src/report/text";

const Schema = z.object({ summary: z.string() });

describe("marker", () => {
  it("round-trips values that contain U+2028 and U+2029", () => {
    const value = { summary: "첫 줄\u2028둘째 줄\u2029셋째 줄" };
    const body = `본문\n\n${writeMarker("factory:test-data", value)}`;
    expect(readMarker(body, "factory:test-data", Schema)).toEqual(value);
  });

  it("writes U+2028 and U+2029 as JSON escapes, not raw characters", () => {
    const marker = writeMarker("factory:test-data", { summary: "a\u2028b\u2029c" });
    expect(marker).not.toMatch(/[\u2028\u2029]/);
    expect(marker).toContain("\\u2028");
    expect(marker).toContain("\\u2029");
  });

  it("reads a stored marker that already holds raw U+2028", () => {
    const body = `<!-- factory:test-data {"summary":"a\u2028b"} -->`;
    expect(readMarker(body, "factory:test-data", Schema)).toEqual({ summary: "a\u2028b" });
  });
});
