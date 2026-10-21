import type { Topic } from "../api/types";
import { bookUrl, kindLabel } from "./book";

const NEW_ISSUE = "https://github.com/roboco-io/the-software-factory/issues/new";
// GitHub가 받아들이는 URL 길이에 여유를 둔 상한. 넘으면 토론 요약을 줄인다.
export const MAX_URL = 7500;
const CUT = "\n\n(이하 생략)";

// 토론에서 나온 개정 제안을 책 저장소의 "책 내용 피드백·질문" 이슈 양식(01-book-feedback.yml)으로 연다.
// 양식의 필드 id(location, feedback, suggestion)를 쿼리로 미리 채운다. 제출은 사용자가 자기 GitHub 계정으로 한다.
export function proposalUrl(
  topic: Topic,
  opts: { docTitle?: string; sectionHeading?: string; forumBase: string },
): string | null {
  const book = topic.book;
  if (!book) return null;
  const where = `${opts.docTitle ?? book.docId}${book.anchor ? ` · ${opts.sectionHeading ?? book.anchor}` : ""}`;
  const original = bookUrl(book.docId, book.anchor);
  const topicLink = `${opts.forumBase}#/topic/${topic.id}`;
  const build = (summary: string) => {
    const feedback = [
      "포럼 토론에서 나온 개정 제안입니다.",
      "",
      `- 포럼 토론: ${topicLink}`,
      `- 토론 유형: ${kindLabel(topic.kind)}`,
      `- 토론 제목: ${topic.title}`,
      "",
      "토론 요약:",
      "",
      summary,
    ].join("\n");
    const q = new URLSearchParams({
      template: "01-book-feedback.yml",
      title: `[책 피드백] 포럼 토론: ${topic.title}`.slice(0, 200),
      location: `${original ?? book.docId} (${where})`,
      feedback,
      suggestion: "토론에서 합의된 개정 방향을 적어 주세요.",
    });
    return `${NEW_ISSUE}?${q.toString()}`;
  };
  let summary = topic.body;
  let url = build(summary);
  while (url.length > MAX_URL && summary.length > 0) {
    summary = summary.slice(0, Math.floor(summary.length * 0.8));
    url = build(summary + CUT);
  }
  return url;
}
