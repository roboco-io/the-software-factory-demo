import { describe, expect, it } from "vitest";
import { parseManuscript, sectionHash } from "../src/lib/book-sync";

describe("parseManuscript sections", () => {
  it("collects each ## section body until the next ## heading, keeping fenced code", () => {
    const md =
      "# 제목\n\n## 하나\n\n첫 본문.\n\n```\n## 코드 안 제목\n```\n\n### 소제목\n\n더.\n\n## 둘\n\n둘째.\n";
    const { title, headings, sections } = parseManuscript(md);
    expect(title).toBe("제목");
    expect(headings).toEqual(["하나", "둘"]);
    expect(sections.map((s) => s.heading)).toEqual(["하나", "둘"]);
    expect(sections[0]!.body).toContain("## 코드 안 제목");
    expect(sections[0]!.body).toContain("### 소제목");
    expect(sections[1]!.body).toBe("둘째.");
  });
});

describe("sectionHash", () => {
  it("ignores trailing spaces, CRLF and surrounding blank lines", async () => {
    expect(await sectionHash("\n본문.  \r\n다음\n\n")).toBe(await sectionHash("본문.\n다음"));
  });

  it("changes when the text changes", async () => {
    expect(await sectionHash("본문.")).not.toBe(await sectionHash("고친 본문."));
    expect(await sectionHash("본문.")).toMatch(/^[0-9a-f]{64}$/);
  });
});
