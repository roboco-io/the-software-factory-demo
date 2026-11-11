import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BLOCK_BEGIN,
  BLOCK_END,
  findStatusPhrases,
  renderReadmeBlock,
  renderStatusDoc,
  replaceBlock,
  validate,
} from "./status.mjs";

const status = {
  asOf: "2026-11-11",
  stages: [
    { id: "1", title: "기반", scope: "CI와 배포", state: "done", note: "" },
    {
      id: "2",
      title: "공개",
      scope: "공개 조건 시험",
      state: "in_progress",
      note: "DNS 실험만 끝남",
    },
    { id: "3", title: "책", scope: "책 개정", state: "not_started", note: "" },
  ],
  verified: [{ date: "2026-11-10", stage: "1", text: "배포가 성공했다." }],
  open: [{ stage: "2", owner: "사람", text: "크레딧 차감 확인" }],
  next: ["인젝션 시험"],
};

test("validate accepts a complete status and names what is wrong otherwise", () => {
  assert.deepEqual(validate(status), []);
  assert.match(validate({ ...status, asOf: "어제" })[0], /asOf/);
  const bad = structuredClone(status);
  bad.stages[0].state = "almost";
  bad.open[0].stage = "9";
  bad.verified[0].date = "11월";
  const errors = validate(bad).join("\n");
  assert.match(errors, /state/);
  assert.match(errors, /stage "9"/);
  assert.match(errors, /date/);
});

test("the README block shows every stage with its state in words", () => {
  const block = renderReadmeBlock(status);
  assert.ok(block.startsWith(BLOCK_BEGIN));
  assert.ok(block.endsWith(BLOCK_END));
  assert.match(block, /\| 1\. 기반 \| CI와 배포 \| 완료 \|/);
  assert.match(
    block,
    /\| 2\. 공개 \| 공개 조건 시험 \| 진행 중\. DNS 실험만 끝남 \|/,
  );
  assert.match(block, /\| 3\. 책 \| 책 개정 \| 미착수 \|/);
  assert.match(block, /2026-11-11/);
});

test("the status document lists stages, verified facts, open items and next work", () => {
  const doc = renderStatusDoc(status);
  assert.match(doc, /직접 고치지 않는다/);
  assert.match(doc, /2026-11-10.*배포가 성공했다\./);
  assert.match(doc, /크레딧 차감 확인/);
  assert.match(doc, /1\. 인젝션 시험/);
});

test("replaceBlock swaps only the marked block and fails without markers", () => {
  const text = `앞\n\n${BLOCK_BEGIN}\n낡은 표\n${BLOCK_END}\n\n뒤\n`;
  const out = replaceBlock(text, renderReadmeBlock(status));
  assert.ok(out.startsWith("앞\n\n"));
  assert.ok(out.endsWith("\n\n뒤\n"));
  assert.ok(!out.includes("낡은 표"));
  assert.throws(() => replaceBlock("표식 없음", "x"), /status:begin/);
});

test("status phrases outside the generated block are reported with their line", () => {
  const text = [
    "동작을 설명하는 문장이다.",
    "이 경로는 실서비스에서 확인하지 못했다.",
    BLOCK_BEGIN,
    "| 3. 책 | 책 개정 | 미착수 |",
    BLOCK_END,
    "아직 해 보지 않았다.",
  ].join("\n");
  assert.deepEqual(
    findStatusPhrases(text).map((f) => f.line),
    [2, 6],
  );
  assert.deepEqual(findStatusPhrases("잔액을 읽는 API는 찾지 못했다."), []);
});
