const oneLine = (s: string): string => s.replace(/[\r\n]+/g, " ").trim();
// 본문·제목 줄이 트레일러(`Key: value`)처럼 보이면 인용 표시로 무력화한다.
const defang = (s: string): string => s.replace(/^(\s*(?:\*\s*)?[A-Za-z][A-Za-z-]*:\s)/gm, "> $1");

export function signatureTrailers(engine: string, model: string, issue: number): string {
  return `Agent-Signature: ${oneLine(engine)}/${oneLine(model)}\nFactory-Issue: #${issue}`;
}

export function commitMessage(
  subject: string,
  body: string,
  sig: { engine: string; model: string },
  issue: number,
): string {
  const parts = [
    oneLine(subject).replace(/^(\s*(?:\*\s*)?(?:Factory-Issue|Agent-Signature):)/i, "> $1"),
  ];
  if (body.trim()) parts.push(defang(body.trim()));
  parts.push(signatureTrailers(sig.engine, sig.model, issue));
  return parts.join("\n\n");
}

export function parseFactoryIssues(message: string): number[] {
  const found = [...message.matchAll(/^\s*(?:\*\s*)?Factory-Issue: #(\d+)\s*$/gm)].map((m) =>
    Number(m[1]),
  );
  return [...new Set(found)];
}

// 포스트모템 되돌리기 커밋의 장애 이슈 trailer. Factory-Issue와 달리 deploy 상태 전이 대상이 아니다.
export const REVERT_TRAILER = "Factory-Revert";

export function parseRevertIssues(message: string): number[] {
  const re = new RegExp(`^\\s*(?:\\*\\s*)?${REVERT_TRAILER}: #(\\d+)\\s*$`, "gm");
  return [...new Set([...message.matchAll(re)].map((m) => Number(m[1])))];
}
