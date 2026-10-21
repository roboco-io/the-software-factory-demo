import { describe, expect, it } from "vitest";
import type { Topic } from "../api/types";
import { MAX_URL, proposalUrl } from "./proposal";

const topic = (over: Partial<Topic> = {}): Topic => ({
  id: 7,
  title: "계약의 다섯 연결에 수용 기준이 빠졌다",
  body: "**본문** 요약",
  kind: "argument",
  author: { username: "alice", image: null, kind: "human", owner: null },
  book: { docId: "ch05", anchor: "s03", revision: 5, status: "current" },
  replyCount: 2,
  createdAt: "2026-10-21T00:00:00.000Z",
  updatedAt: "2026-10-21T00:00:00.000Z",
  lastActivityAt: "2026-10-21T00:00:00.000Z",
  ...over,
});

const FORUM = "https://roboco.io/the-software-factory-demo/";

describe("proposalUrl", () => {
  it("prefills the book repository's feedback form with location, topic link and summary", () => {
    const url = new URL(
      proposalUrl(topic(), {
        docTitle: "5장 계약",
        sectionHeading: "계약의 다섯 연결",
        forumBase: FORUM,
      })!,
    );
    expect(url.origin + url.pathname).toBe(
      "https://github.com/roboco-io/the-software-factory/issues/new",
    );
    const q = url.searchParams;
    expect(q.get("template")).toBe("01-book-feedback.yml");
    expect(q.get("title")).toBe("[책 피드백] 포럼 토론: 계약의 다섯 연결에 수용 기준이 빠졌다");
    expect(q.get("location")).toBe(
      "https://factory.roboco.io/book/ch05/#s03 (5장 계약 · 계약의 다섯 연결)",
    );
    const feedback = q.get("feedback")!;
    expect(feedback).toContain("포럼 토론에서 나온 개정 제안");
    expect(feedback).toContain(`${FORUM}#/topic/7`);
    expect(feedback).toContain("반론");
    expect(feedback).toContain("**본문** 요약");
  });

  it("returns null for a topic not tied to the book", () => {
    expect(proposalUrl(topic({ book: null }), { forumBase: FORUM })).toBeNull();
  });

  it("falls back to ids and keeps the URL under the length limit by cutting the summary", () => {
    const url = proposalUrl(topic({ body: "가".repeat(20000) }), { forumBase: FORUM })!;
    expect(url.length).toBeLessThanOrEqual(MAX_URL);
    const q = new URL(url).searchParams;
    expect(q.get("location")).toBe("https://factory.roboco.io/book/ch05/#s03 (ch05 · s03)");
    expect(q.get("feedback")).toContain("(이하 생략)");
  });
});
