// SARIF 심각도 게이트. CodeQL의 analyze 단계는 결과가 있어도 실패하지 않으므로, 이 스크립트가 차단 결과를 찾는다.
// 차단 기준: security-severity가 임계값(기본 7.0) 이상인 결과, 또는 security-severity가 없고 level이 `error`인 결과.
// 억제된(suppressions가 있는) 결과는 무시한다.
// 사용: node scripts/sarif-gate.mjs <디렉토리-또는-파일>
//   디렉토리는 *.sarif 파일을 재귀적으로 모두 읽는다. 파일을 찾지 못하거나 읽을 수 없거나 JSON이 잘못되면 종료 코드 2(닫힌 실패).
//   차단 결과가 있으면 종료 코드 1, 없으면 0.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// rule 객체의 security-severity는 문자열이나 숫자로 올 수 있다. 숫자로 바꿀 수 없으면 null로 본다.
function severityOf(rule) {
  const raw = rule?.properties?.["security-severity"];
  if (raw === undefined || raw === null) return null;
  const n = Number.parseFloat(String(raw));
  return Number.isFinite(n) ? n : null;
}

// driver.rules와 tool.extensions[].rules를 모두 모은다.
function allRules(run) {
  const driverRules = run.tool?.driver?.rules ?? [];
  const extRules = (run.tool?.extensions ?? []).flatMap((ext) => ext?.rules ?? []);
  return { driverRules, all: [...driverRules, ...extRules] };
}

function ruleFor(result, run) {
  const { driverRules, all } = allRules(run);
  if (typeof result.ruleId === "string") {
    const byId = all.find((r) => r?.id === result.ruleId);
    return { id: result.ruleId, rule: byId };
  }
  if (Number.isInteger(result.ruleIndex)) {
    const byIndex = driverRules[result.ruleIndex];
    return { id: byIndex?.id, rule: byIndex };
  }
  return { id: undefined, rule: undefined };
}

// SARIF 문서에서 차단 결과 목록을 돌려준다. 결과가 없거나 차단 결과가 없으면 빈 배열이다.
export function blockingResults(sarif, threshold = 7.0) {
  if (!sarif || !Array.isArray(sarif.runs)) {
    throw new Error("SARIF 문서에 runs 배열이 없다");
  }
  if (sarif.runs.length === 0) throw new Error("SARIF 문서의 runs 배열이 비어 있다");
  const out = [];
  for (const run of sarif.runs) {
    if (!Array.isArray(run.results)) throw new Error("SARIF run에 results 배열이 없다");
    for (const result of run.results) {
      if (Array.isArray(result.suppressions) && result.suppressions.length > 0) continue;
      const { id, rule } = ruleFor(result, run);
      const severity = severityOf(rule);
      const level = result.level ?? rule?.defaultConfiguration?.level ?? "warning";
      const blocking = severity !== null ? severity >= threshold : level === "error";
      if (!blocking) continue;
      const physical = result.locations?.[0]?.physicalLocation;
      out.push({
        ruleId: id ?? "",
        file: physical?.artifactLocation?.uri ?? "",
        line: physical?.region?.startLine ?? null,
        severity,
      });
    }
  }
  return out;
}

// 디렉토리면 *.sarif 파일을 재귀적으로 모은다. 파일이면 그 파일 하나다.
function sarifFiles(path) {
  let st;
  try {
    st = statSync(path);
  } catch {
    throw new Error(`경로를 찾을 수 없다: ${path}`);
  }
  if (st.isFile()) return [path];
  const files = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) files.push(...sarifFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".sarif")) files.push(full);
  }
  return files;
}

function readSarif(file) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`SARIF를 읽을 수 없다: ${file} (${err.message})`, { cause: err });
  }
  return doc;
}

function main(argv) {
  const target = argv[2];
  if (!target) throw new Error("사용법: node scripts/sarif-gate.mjs <디렉토리-또는-파일>");
  const files = sarifFiles(target);
  if (files.length === 0) throw new Error(`.sarif 파일이 없다: ${target}`);
  const found = files.flatMap((file) => blockingResults(readSarif(file)));
  for (const r of found) {
    const where = r.line === null ? r.file : `${r.file}:${r.line}`;
    console.log(`${r.ruleId} ${where} ${r.severity ?? "level error"}`);
  }
  console.log(`sarif-gate: ${found.length} blocking`);
  return found.length > 0 ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv);
  } catch (err) {
    // 입력 오류와 예상하지 못한 오류 모두 닫힌 실패(종료 코드 2)로 끝낸다. 차단 결과(1)와 구분된다.
    console.error(`sarif-gate: ${err.message}`);
    process.exitCode = 2;
  }
}
