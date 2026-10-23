import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { blockingResults } from "./sarif-gate.mjs";

const GATE = new URL("./sarif-gate.mjs", import.meta.url).pathname;

const sqlRule = { id: "js/sql-injection", properties: { "security-severity": "8.8" } };
const sqlResult = {
  ruleId: "js/sql-injection",
  level: "error",
  locations: [
    {
      physicalLocation: {
        artifactLocation: { uri: "apps/api/src/a.ts" },
        region: { startLine: 3 },
      },
    },
  ],
};

const doc = (results, rules = [sqlRule]) => ({
  runs: [{ tool: { driver: { name: "CodeQL", rules } }, results }],
});

test("blocks a result whose security-severity is at least 7.0", () => {
  assert.deepEqual(blockingResults(doc([sqlResult])), [
    { ruleId: "js/sql-injection", file: "apps/api/src/a.ts", line: 3, severity: 8.8 },
  ]);
});

test("passes a result with security-severity 5.0 and level warning", () => {
  const rules = [{ id: "js/sql-injection", properties: { "security-severity": "5.0" } }];
  const results = [{ ...sqlResult, level: "warning" }];
  assert.deepEqual(blockingResults(doc(results, rules)), []);
});

test("blocks a result without severity when level is error, with null line and severity", () => {
  const rules = [{ id: "js/plain" }];
  const results = [
    {
      ruleId: "js/plain",
      level: "error",
      locations: [{ physicalLocation: { artifactLocation: { uri: "apps/api/src/b.ts" } } }],
    },
  ];
  assert.deepEqual(blockingResults(doc(results, rules)), [
    { ruleId: "js/plain", file: "apps/api/src/b.ts", line: null, severity: null },
  ]);
});

test("suppressed result is ignored", () => {
  const results = [{ ...sqlResult, suppressions: [{ kind: "inSource" }] }];
  assert.deepEqual(blockingResults(doc(results)), []);
});

test("rule found via ruleIndex when ruleId missing", () => {
  const results = [{ ruleIndex: 0, level: "error", locations: sqlResult.locations }];
  assert.deepEqual(blockingResults(doc(results)), [
    { ruleId: "js/sql-injection", file: "apps/api/src/a.ts", line: 3, severity: 8.8 },
  ]);
});

test("rules from tool.extensions are used for severity", () => {
  const extensions = [{ name: "ext", rules: [sqlRule] }];
  const sarif = {
    runs: [
      {
        tool: { driver: { name: "CodeQL", rules: [] }, extensions },
        results: [sqlResult],
      },
    ],
  };
  assert.deepEqual(blockingResults(sarif), [
    { ruleId: "js/sql-injection", file: "apps/api/src/a.ts", line: 3, severity: 8.8 },
  ]);
});

test("threshold argument changes the cut-off", () => {
  const rules = [{ id: "js/sql-injection", properties: { "security-severity": "5.0" } }];
  const results = [sqlResult];
  assert.equal(blockingResults(doc(results, rules), 5.0).length, 1);
  assert.equal(blockingResults(doc(results, rules)).length, 0);
});

test("cli exits 2 when directory has no .sarif files", () => {
  const dir = mkdtempSync(join(tmpdir(), "sarif-gate-empty-"));
  try {
    writeFileSync(join(dir, "notes.txt"), "x");
    const r = spawnSync(process.execPath, [GATE, dir], { encoding: "utf8" });
    assert.equal(r.status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli exits 2 on invalid JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "sarif-gate-bad-"));
  try {
    writeFileSync(join(dir, "codeql.sarif"), "{ not json");
    const r = spawnSync(process.execPath, [GATE, dir], { encoding: "utf8" });
    assert.equal(r.status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli exits 2 when path does not exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "sarif-gate-missing-"));
  try {
    const r = spawnSync(process.execPath, [GATE, join(dir, "nope")], { encoding: "utf8" });
    assert.equal(r.status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli exits 1 and prints "js/sql-injection apps/api/src/a.ts:3 8.8"', () => {
  const dir = mkdtempSync(join(tmpdir(), "sarif-gate-block-"));
  try {
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "codeql.sarif"), JSON.stringify(doc([sqlResult])));
    const r = spawnSync(process.execPath, [GATE, dir], { encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /js\/sql-injection apps\/api\/src\/a\.ts:3 8\.8/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli exits 0 and prints "sarif-gate: 0 blocking"', () => {
  const dir = mkdtempSync(join(tmpdir(), "sarif-gate-pass-"));
  try {
    writeFileSync(join(dir, "codeql.sarif"), JSON.stringify(doc([])));
    const r = spawnSync(process.execPath, [GATE, dir], { encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /sarif-gate: 0 blocking/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("empty runs array fails closed", () => {
  assert.throws(() => blockingResults({ runs: [] }), /runs/);
});

test("run without results array fails closed", () => {
  assert.throws(() => blockingResults({ runs: [{ tool: { driver: {} } }] }), /results/);
});

test("rule defaultConfiguration.level error blocks when result lacks level and severity", () => {
  const sarif = {
    runs: [
      {
        tool: { driver: { rules: [{ id: "x/y", defaultConfiguration: { level: "error" } }] } },
        results: [{ ruleId: "x/y" }],
      },
    ],
  };
  assert.equal(blockingResults(sarif).length, 1);
});
