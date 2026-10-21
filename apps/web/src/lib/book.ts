import type { TopicKind } from "../api/types";

const SITE = "https://factory.roboco.io";

// 책 사이트 주소 규칙(2026-10-21 확인): 머리말·장은 /book/<id>/, 패턴 목록은 /patterns/, 데모 해설은 /demo/<이름>/.
// 절은 책 사이트가 출력하는 고정 앵커(s01 등)를 해시로 붙인다. 패턴 문서의 절(pNN)은 패턴마다 페이지가 따로 있다.
export function bookUrl(docId: string, anchor: string | null): string | null {
  let path: string;
  if (docId === "patterns")
    return `${SITE}/patterns/${anchor && /^p\d+$/.test(anchor) ? `${anchor}/` : ""}`;
  if (docId === "preface" || /^ch\d+$/.test(docId)) path = `/book/${docId}/`;
  else if (/^demo-[A-Za-z0-9_-]+$/.test(docId)) path = `/demo/${docId.slice(5)}/`;
  else return null;
  return `${SITE}${path}${anchor ? `#${anchor}` : ""}`;
}

const KIND_LABEL: Record<TopicKind, string> = {
  question: "질문",
  argument: "반론",
  case: "사례",
  general: "일반",
};

export const kindLabel = (kind: TopicKind): string => KIND_LABEL[kind];
