import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentAdapter, EngineName } from "../src/agents/types";
import { loadAgentsConfig } from "../src/config/agents";
import type { SpawnFn } from "../src/exec/process";
import type { GitPort } from "../src/git/port";
import { InMemoryGitHub } from "../src/github/memory";
import { renderPrBody, type PrMeta } from "../src/report/pr";
import { loadPostmortemPolicy } from "../src/policy/postmortem";
import { loadRiskPolicy, type ChangedFile } from "../src/policy/risk";
import { createRunStore } from "../src/runs/store";
import { DEFAULT_BOT_LOGIN, type Settings, type StageDeps } from "../src/stages/deps";

export const BOT = DEFAULT_BOT_LOGIN;

// 실제 git 대신 임시 디렉토리의 파일 내용을 스냅숏과 비교해 변경 파일을 계산한다.
export class FakeGit implements GitPort {
  readonly dir: string;
  branch = "main";
  rebaseOk = true;
  // 번들 head가 준비 시점 base의 후손인지(false면 조상이 아닌 것으로 판정).
  descendsFromBase = true;
  readonly baseSha = "b".repeat(40);
  // checkoutNewBranch로 맞춘 시작 커밋. 커밋이 생기면 sha-N이 우선한다.
  startHead: string | null = null;
  headOverride: string | null = null;
  // 커밋이 없을 때 diffAgainst가 돌려줄 PR 변경(리뷰 테스트용). 빈 문자열이면 변경 없음.
  baseDiff = "diff --git a/x b/x\n+++ b/x\n+x";
  readonly pushLeases: (string | undefined)[] = [];
  readonly messages: string[] = [];
  readonly pushes: { branch: string; sha: string; files: string[] }[] = [];
  readonly bundles: string[] = [];
  onPush: ((branch: string, sha: string, files: string[]) => void) | null = null;
  private snapshot = new Map<string, string>();
  private sinceBase = new Set<string>();

  constructor(dir: string) {
    this.dir = dir;
  }

  private walk(rel = ""): string[] {
    const abs = path.join(this.dir, rel);
    if (!existsSync(abs)) return [];
    return readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
      const child = rel ? `${rel}/${e.name}` : e.name;
      return e.isDirectory() ? this.walk(child) : [child];
    });
  }

  private read(file: string): string {
    return readFileSync(path.join(this.dir, file), "utf8");
  }

  async fetch(): Promise<void> {}
  async checkoutNewBranch(branch: string, startPoint?: string): Promise<void> {
    this.branch = branch;
    this.startHead = startPoint ?? null;
    this.sinceBase.clear();
    this.snapshot = new Map(this.walk().map((f) => [f, this.read(f)]));
  }
  async changedFiles(): Promise<string[]> {
    return this.walk().filter((f) => this.snapshot.get(f) !== this.read(f));
  }
  async filesAgainst(): Promise<string[]> {
    return [...new Set([...this.sinceBase, ...(await this.changedFiles())])].sort();
  }
  async diffAgainst(): Promise<string> {
    if (this.sinceBase.size === 0) return this.baseDiff;
    return [...this.sinceBase]
      .map((f) => `diff --git a/${f} b/${f}\n+++ b/${f}\n+${this.read(f)}`)
      .join("\n");
  }
  async commitAll(message: string): Promise<string> {
    for (const f of await this.changedFiles()) {
      this.snapshot.set(f, this.read(f));
      this.sinceBase.add(f);
    }
    this.messages.push(message);
    return this.headSha();
  }
  async rebaseOnto(): Promise<boolean> {
    return this.rebaseOk;
  }
  async createBundle(file: string): Promise<void> {
    this.bundles.push(file);
  }
  async importBundle(): Promise<void> {}
  async push(branch: string, token: string, expectSha?: string): Promise<void> {
    if (!token) throw new Error("push without token");
    this.pushLeases.push(expectSha);
    const sha = await this.headSha();
    const files = await this.filesAgainst();
    this.pushes.push({ branch, sha, files });
    this.onPush?.(branch, sha, files);
  }
  async headSha(): Promise<string> {
    if (this.headOverride) return this.headOverride;
    if (this.messages.length === 0 && this.startHead) return this.startHead;
    return `sha-${this.messages.length}`;
  }
  async revParse(): Promise<string> {
    return this.baseSha;
  }
  async resetSoft(): Promise<void> {}
  async isAncestor(): Promise<boolean> {
    return this.descendsFromBase;
  }
}

export const passingSpawn: SpawnFn = async () => ({ code: 0, stdout: "ok", stderr: "" });

// pnpm <script>별 종료 코드를 차례로 돌려준다. 목록이 비면 0.
export function scriptedSpawn(codes: Record<string, number[]>): SpawnFn & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (cmd: string, args: readonly string[]) => {
    const key = args[0] ?? cmd;
    calls.push(`${cmd} ${args.join(" ")}`);
    const queue = codes[key];
    const code = queue && queue.length > 0 ? queue.shift()! : 0;
    return { code, stdout: code ? `${key} failed: expected 1 received 2` : "ok", stderr: "" };
  }) as unknown as SpawnFn & { calls: string[] };
  fn.calls = calls;
  return fn;
}

export interface TestHarness {
  deps: StageDeps;
  gh: InMemoryGitHub;
  git: FakeGit;
  dir: string;
  logs: string[];
  requested: string[];
  setNow(d: Date): void;
}

export function makeTestDeps(
  opts: {
    adapters?: Partial<Record<EngineName, AgentAdapter>>;
    settings?: Partial<Settings>;
    now?: Date;
    spawn?: SpawnFn;
  } = {},
): TestHarness {
  const dir = mkdtempSync(path.join(tmpdir(), "factory-stage-"));
  const gh = new InMemoryGitHub({ botLogin: BOT });
  gh.permissions.set("serithemage", "admin");
  const git = new FakeGit(dir);
  gh.clock = () => now;
  git.onPush = (branch, sha, files) => gh.setBranch(branch, sha, files);
  let now = opts.now ?? new Date("2026-10-12T03:00:00.000Z");
  const logs: string[] = [];
  const requested: string[] = [];
  const settings: Settings = {
    owner: "roboco-io",
    repo: "the-software-factory-demo",
    workdir: dir,
    botLogin: BOT,
    botEmail: `1+${BOT}@users.noreply.github.com`,
    paused: false,
    dailyLimit: 20,
    webUrl: "https://roboco.io/the-software-factory-demo/",
    workersSubdomain: "roboco",
    runUrl: "https://github.com/roboco-io/the-software-factory-demo/actions/runs/1",
    runId: 1,
    token: "test-token",
    bundlePath: null,
    env: { CODEX_MODEL: "gpt-6.1-sol" },
    ...opts.settings,
  };
  const deps: StageDeps = {
    gh,
    runs: createRunStore(gh, () => now),
    git,
    spawn: opts.spawn ?? passingSpawn,
    adapterFor: (engine, model) => {
      requested.push(`${engine}/${model}`);
      const adapter = opts.adapters?.[engine];
      if (!adapter) throw new Error(`no fake adapter for ${engine}`);
      return adapter;
    },
    agents: loadAgentsConfig(),
    policy: loadRiskPolicy(),
    postmortem: loadPostmortemPolicy(),
    settings,
    now: () => now,
    log: (m) => logs.push(m),
  };
  return {
    deps,
    gh,
    git,
    dir,
    logs,
    requested,
    setNow: (d) => {
      now = d;
    },
  };
}

export async function openBotPr(
  h: TestHarness,
  meta: Partial<PrMeta> = {},
  files: (string | ChangedFile)[] = ["apps/api/src/routes/tags.ts"],
) {
  const issue = h.gh.addIssue({ title: "태그 목록 API", labels: ["factory:in-review"] });
  const branch = `factory/issue-${issue.number}`;
  h.gh.setBranch(branch, "sha-a", files);
  const full: PrMeta = {
    issue: issue.number,
    role: "implement",
    implementEngine: "claude",
    implementModel: "claude-sonnet-5-5",
    round: 0,
    ...meta,
  };
  const body = renderPrBody({
    meta: full,
    summary: "s",
    issueTitle: "태그 목록 API",
    acceptanceCriteria: [],
    checks: [],
    preview: "p",
    risks: [],
    risk: { tier: "T1", files: [] },
    run: { engine: "claude", model: "m", turns: 1, durationMs: 1 },
  });
  const pr = await h.gh.createPull({
    title: "feat: 태그",
    body,
    head: branch,
    base: "main",
    draft: false,
  });
  return { issue: issue.number, pr, branch };
}
