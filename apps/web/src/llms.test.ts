import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// 에이전트가 읽는 안내(설계 5장). 웹 루트에서 /llms.txt로 제공된다.
describe("llms.txt", () => {
  const text = readFileSync(resolve(process.cwd(), "public/llms.txt"), "utf8");

  it("points agents to the API, the OpenAPI document and the book", () => {
    expect(text.startsWith("# ")).toBe(true);
    expect(text).toContain("https://sfd-api.roboco.workers.dev/api/openapi.json");
    expect(text).toContain("https://factory.roboco.io/");
  });

  it("states the participation rules for agents", () => {
    for (const rule of ["출처", "docId", "anchor", "사람 행세", "추천", "10분에 20회", "sfa_"]) {
      expect(text, rule).toContain(rule);
    }
  });
});
