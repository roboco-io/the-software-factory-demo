// 마크다운 렌더링 검사. GitHub과 같은 CommonMark·GFM 규칙(micromark)으로 렌더링해 다음을 찾는다.
// 1. 닫히지 않은 강조: 렌더링 결과의 코드 밖 텍스트에 `**`가 남는 경우. 한국어 문서에서 닫는 `**` 바로 앞이
//    `)`·`.`·`%` 같은 문장부호이고 바로 뒤에 글자가 붙으면 강조가 닫히지 않는다(예: `**검증(PoC)**도`).
// 2. 의도하지 않은 취소선: GFM은 `~`나 `~~` 짝을 취소선으로 렌더링한다(예: `3~4시간 ... 5~6개`).
// 사용: node scripts/check-markdown.mjs [파일...]  (인자가 없으면 git이 추적하는 모든 .md 파일)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";

const EXCLUDE = [];

// 코드 펜스 안의 빈 줄에서는 나누지 않는다. 각 덩어리는 { line(1부터), text }다.
export function chunks(src) {
  const out = [];
  let buf = [];
  let start = 1;
  let fence = null;
  src.split("\n").forEach((line, i) => {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (m) {
      if (!fence) fence = m[1];
      else if (m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
    }
    if (!fence && line.trim() === "") {
      if (buf.length) out.push({ line: start, text: buf.join("\n") });
      buf = [];
      start = i + 2;
      return;
    }
    if (!buf.length) start = i + 1;
    buf.push(line);
  });
  if (buf.length) out.push({ line: start, text: buf.join("\n") });
  return out;
}

function render(text) {
  return micromark(text, {
    allowDangerousHtml: true,
    extensions: [gfm()],
    htmlExtensions: [gfmHtml()],
  });
}

// 렌더링 결과에서 코드와 태그를 빼고 남은 텍스트. 결과는 화면에 쓰지 않고 검사에만 쓴다.
// 태그를 지운 뒤 새 태그 모양이 생길 수 있으므로 더 바뀌지 않을 때까지 반복한다.
function plainText(html) {
  let text = html.replace(/<pre[\s\S]*?<\/pre>/g, "").replace(/<code[\s\S]*?<\/code>/g, "");
  for (let prev = ""; prev !== text;) {
    prev = text;
    text = text.replace(/<[^>]+>/g, "");
  }
  return text;
}

export function checkText(src) {
  const problems = [];
  for (const c of chunks(src)) {
    const html = render(c.text);
    const text = plainText(html);
    if (text.includes("**"))
      problems.push({
        line: c.line,
        kind: "unclosed-strong",
        message:
          "닫히지 않은 강조(**)가 그대로 보인다. 닫는 ** 앞이 문장부호이고 뒤에 글자가 붙어 있으면 문장부호를 강조 밖으로 옮기거나 ** 뒤에 공백을 넣는다.",
      });
    if (/<del>/.test(html))
      problems.push({
        line: c.line,
        kind: "strikethrough",
        message:
          "~ 짝이 취소선으로 렌더링된다. 범위는 -(3-4시간), 근사는 '약'(약 $2.6)으로 쓰고, 경로는 코드(`~/.config`)로 감싼다.",
      });
  }
  return problems;
}

function trackedMarkdown() {
  return execFileSync("git", ["ls-files", "*.md"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f && !EXCLUDE.some((e) => f.startsWith(e)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = process.argv.length > 2 ? process.argv.slice(2) : trackedMarkdown();
  let count = 0;
  for (const f of files) {
    for (const p of checkText(readFileSync(f, "utf8"))) {
      console.log(`${f}:${p.line}: [${p.kind}] ${p.message}`);
      count++;
    }
  }
  if (count) {
    console.log(`마크다운 렌더링 문제 ${count}건 (파일 ${files.length}개 검사)`);
    process.exit(1);
  }
  console.log(`마크다운 렌더링 문제 없음 (파일 ${files.length}개 검사)`);
}
