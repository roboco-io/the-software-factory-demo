import type { z } from "zod";

// 에이전트·이슈 텍스트가 팩토리 표식(HTML 주석)을 열거나 닫지 못하게 한다.
export function sanitize(text: string): string {
  return text.replace(/<!--/g, "&lt;!--").replace(/--\s*!?\s*>/g, (m) => `${m.slice(0, -1)}&gt;`);
}

export function writeMarker(name: string, value: unknown): string {
  // JSON.stringify는 U+2028/U+2029를 그대로 둔다. 줄 구분 문자로 취급하는 도구가 있으므로 이스케이프한다.
  const json = JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `<!-- ${name} ${json} -->`;
}

export function readMarker<T>(body: string, name: string, schema: z.ZodType<T>): T | null {
  // `.`은 U+2028/U+2029와 맞지 않는다. 이스케이프 전에 저장된 마커도 읽되, 마커가 줄을 넘지는 않게 한다.
  const re = new RegExp(`<!-- ${name} (\\{[^\\n\\r]*?\\}) -->`, "g");
  const last = [...body.matchAll(re)].at(-1);
  if (!last?.[1]) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(last[1]));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// 표 셀·한 줄 필드용: 줄바꿈을 공백으로, 표 구분자 `|`를 이스케이프한다.
export function cell(s: string): string {
  return neutralizeRefs(sanitize(s))
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r\n|\r|\n/g, " ");
}

// 코드 span(`...`) 안에 넣을 값: 백틱을 제거하고 cell 규칙을 적용한다.
export function codeCell(s: string): string {
  return cell(s).replace(/`/g, "'");
}

// 한 줄 필드(목록 항목·제목): 줄바꿈을 공백으로 바꾸고 표식·참조를 무력화한다.
export function inline(s: string): string {
  return neutralizeRefs(sanitize(s))
    .replace(/\s*[\r\n]+\s*/g, " ")
    .trim();
}

// 여러 줄 텍스트를 인용문으로 내려 제목·섹션을 만들지 못하게 한다.
export function demote(s: string): string {
  return neutralizeRefs(sanitize(s))
    .split(/\r\n|\r|\n/)
    .map((l) => `> ${l}`)
    .join("\n");
}

// 여러 줄 신뢰 불가 본문용: 코드 펜스 안에 가둬 마크다운·HTML이 해석되지 않게 한다.
// 펜스는 내용 안의 가장 긴 백틱 연속보다 하나 더 길게(최소 3) 만들어 내용이 펜스를 닫지 못한다.
export function codeBlock(s: string): string {
  const content = neutralizeRefs(sanitize(s.replace(/\0/g, "").replace(/\r\n|\r/g, "\n")));
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((m) => m.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${content}\n${fence}`;
}

// GitHub 닫기 키워드(close/fix/resolve + #N)와 @멘션을 무력화한다(ZWJ 삽입).
export function neutralizeRefs(text: string): string {
  return text
    .replace(
      /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(\s*:?\s*)((?:[\w.-]+\/[\w.-]+)?#\d+)/gi,
      (_m, kw: string, sp: string, ref: string) => `${kw}\u200d${sp}${ref}`,
    )
    .replace(/@(?=[A-Za-z0-9])/g, "@\u200d");
}

// HTML 주석(닫히지 않은 것 포함)을 제거한다.
export function stripComments(text: string): string {
  let prev: string;
  let cur = text;
  do {
    prev = cur;
    cur = prev.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  } while (cur !== prev);
  return cur;
}
