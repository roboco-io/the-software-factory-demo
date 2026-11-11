// The project's status has one source: docs/status.json. This script renders it into
// docs/status.md and the marked block of README.md, and checks that both are current.
// It also refuses status wording in other documents, so a claim such as "not verified yet"
// cannot go stale somewhere the source does not reach.
//
//   node scripts/status.mjs --write   render the generated files
//   node scripts/status.mjs --check   fail when anything is out of date (runs in `pnpm check`)

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BLOCK_BEGIN = "<!-- status:begin -->";
export const BLOCK_END = "<!-- status:end -->";

const STATES = { done: "완료", in_progress: "진행 중", not_started: "미착수" };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const text = (v) => typeof v === "string" && v.trim() !== "";

/** Every problem of the status source, as sentences. Empty when it is usable. */
export function validate(status) {
  const errors = [];
  if (!DATE.test(status?.asOf ?? "")) errors.push("asOf must be YYYY-MM-DD");
  const stages = Array.isArray(status?.stages) ? status.stages : [];
  if (stages.length === 0) errors.push("stages must not be empty");
  const ids = new Set();
  for (const s of stages) {
    if (!text(s.id) || !text(s.title) || !text(s.scope))
      errors.push(`stage ${JSON.stringify(s.id)} needs id, title and scope`);
    if (!(s.state in STATES))
      errors.push(
        `stage "${s.id}": state must be one of ${Object.keys(STATES)}`,
      );
    if (typeof s.note !== "string")
      errors.push(`stage "${s.id}": note must be a string (may be empty)`);
    if (/[|\n]/.test(`${s.title}${s.scope}${s.note}`))
      errors.push(`stage "${s.id}": no "|" or line break in table text`);
    ids.add(s.id);
  }
  const known = (kind, item) => {
    if (!ids.has(item.stage))
      errors.push(`${kind}: stage "${item.stage}" is not in stages`);
    if (!text(item.text)) errors.push(`${kind}: text must not be empty`);
  };
  for (const v of status?.verified ?? []) {
    known("verified", v);
    if (!DATE.test(v.date ?? ""))
      errors.push("verified: date must be YYYY-MM-DD");
  }
  for (const o of status?.open ?? []) {
    known("open", o);
    if (!text(o.owner)) errors.push("open: owner must not be empty");
  }
  for (const n of status?.next ?? [])
    if (!text(n)) errors.push("next: entries must not be empty");
  return errors;
}

const stageState = (s) =>
  s.note === "" ? STATES[s.state] : `${STATES[s.state]}. ${s.note}`;

function stageTable(status) {
  return [
    "| 단계 | 내용 | 상태 |",
    "| --- | --- | --- |",
    ...status.stages.map(
      (s) => `| ${s.id}. ${s.title} | ${s.scope} | ${stageState(s)} |`,
    ),
  ].join("\n");
}

/** The block for README.md, markers included. Prettier leaves it as written. */
export function renderReadmeBlock(status) {
  return [
    BLOCK_BEGIN,
    "<!-- prettier-ignore-start -->",
    "",
    `${status.asOf} 기준이다. 이 표는 \`docs/status.json\`에서 생성한다.`,
    "",
    stageTable(status),
    "",
    "<!-- prettier-ignore-end -->",
    BLOCK_END,
  ].join("\n");
}

/** The whole of docs/status.md. */
export function renderStatusDoc(status) {
  const title = new Map(
    status.stages.map((s) => [s.id, `${s.id}. ${s.title}`]),
  );
  const byStage = (items, line) =>
    status.stages.flatMap((s) => {
      const own = items.filter((i) => i.stage === s.id);
      return own.length === 0
        ? []
        : [`### ${title.get(s.id)}`, "", ...own.map(line), ""];
    });
  return [
    "# 현재 상태",
    "",
    `${status.asOf} 기준이다. 이 문서는 \`docs/status.json\`에서 \`pnpm docs:status\`로 생성하므로 직접 고치지 않는다. 상태를 바꾸려면 \`docs/status.json\`을 고친다.`,
    "",
    "이 문서가 이 저장소의 진행 상태, 실서비스에서 확인한 것, 아직 확인하지 않은 것의 유일한 원본이다. 다른 문서는 동작과 설계 이유만 설명한다.",
    "",
    "## 단계",
    "",
    stageTable(status),
    "",
    "## 실서비스에서 확인한 것",
    "",
    "가짜 서비스가 아닌 실제 Cloudflare, GitHub, 모델 공급사에서 확인한 항목과 확인한 날짜다.",
    "",
    ...byStage(status.verified, (v) => `- ${v.date}: ${v.text}`),
    "## 아직 확인하지 않은 것",
    "",
    "코드와 가짜 서비스 시험은 있지만 실서비스에서 확인하지 않았거나, 사람이 확인해야 하는 항목이다. 괄호 안은 확인할 주체다.",
    "",
    ...byStage(status.open, (o) => `- (${o.owner}) ${o.text}`),
    "## 다음 작업",
    "",
    ...status.next.map((n, i) => `${i + 1}. ${n}`),
    "",
  ].join("\n");
}

/** `text` with its marked block replaced by `block`. */
export function replaceBlock(text, block) {
  const begin = text.indexOf(BLOCK_BEGIN);
  const end = text.indexOf(BLOCK_END);
  if (begin === -1 || end === -1 || end < begin)
    throw new Error(`missing ${BLOCK_BEGIN} ... ${BLOCK_END} markers`);
  return text.slice(0, begin) + block + text.slice(end + BLOCK_END.length);
}

/**
 * Wording that states what is or is not done or verified. Such a claim belongs in
 * docs/status.json: anywhere else nothing updates it when the facts change.
 */
const STATUS_PHRASES =
  /확인하지 (?:못|않)|확인되지 않|해 보지 (?:못|않)|시험하지 (?:못|않)|실행해 보지|미확인|미착수|미검증/;

/** Lines outside the generated block that state status. */
export function findStatusPhrases(text) {
  const found = [];
  let inBlock = false;
  text.split("\n").forEach((line, i) => {
    if (line.includes(BLOCK_BEGIN)) inBlock = true;
    if (!inBlock && STATUS_PHRASES.test(line))
      found.push({ line: i + 1, text: line.trim().slice(0, 80) });
    if (line.includes(BLOCK_END)) inBlock = false;
  });
  return found;
}

/** Documents that describe behavior and design. They must not state status. */
const PROSE = [
  "README.md",
  "AGENTS.md",
  "docs/design.md",
  "docs/operations.md",
];

function main(argv) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const read = (p) => readFileSync(resolve(root, p), "utf8");
  const status = JSON.parse(read("docs/status.json"));
  const problems = validate(status).map((e) => `docs/status.json: ${e}`);
  if (problems.length === 0) {
    const want = {
      "docs/status.md": renderStatusDoc(status),
      "README.md": replaceBlock(read("README.md"), renderReadmeBlock(status)),
    };
    for (const [path, content] of Object.entries(want)) {
      if (argv.includes("--write")) writeFileSync(resolve(root, path), content);
      else if (read(path) !== content)
        problems.push(`${path} is out of date: run \`pnpm docs:status\``);
    }
  }
  for (const path of PROSE)
    for (const f of findStatusPhrases(read(path)))
      problems.push(
        `${path}:${f.line} states status ("${f.text}"): move it to docs/status.json`,
      );
  for (const p of problems) console.error(p);
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exit(main(process.argv.slice(2)));
