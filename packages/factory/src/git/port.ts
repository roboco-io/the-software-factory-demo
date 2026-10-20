import { scrubEnv } from "../agents/env";
import { runProcess, type ProcessResult, type SpawnFn } from "../exec/process";

export interface GitIdentity {
  name: string;
  email: string;
}

export interface GitPort {
  fetch(ref: string): Promise<void>;
  checkoutNewBranch(branch: string, startPoint: string): Promise<void>;
  changedFiles(): Promise<string[]>;
  filesAgainst(base: string): Promise<string[]>;
  diffAgainst(base: string): Promise<string>;
  commitAll(message: string): Promise<string>;
  rebaseOnto(base: string): Promise<boolean>;
  createBundle(file: string): Promise<void>;
  importBundle(file: string, branch: string): Promise<void>;
  // expectSha(40자)를 주면 원격 브랜치가 그 커밋일 때만 덮어쓴다(force-with-lease). 없으면 무조건 덮어쓴다.
  push(branch: string, token: string, expectSha?: string): Promise<void>;
  headSha(): Promise<string>;
  // ref(origin/main, 팩토리 브랜치, 40자 SHA)를 커밋 SHA로 푼다.
  revParse(ref: string): Promise<string>;
  // base(40자 SHA)가 HEAD의 조상(또는 같은 커밋)이면 true. 객체가 없거나 오류면 false(fail closed).
  isAncestor(base: string): Promise<boolean>;
  // HEAD를 sha(40자)로 되돌리되 변경 내용은 스테이지에 남긴다. publish가 커밋을 직접 다시 만들 때 쓴다.
  resetSoft(sha: string): Promise<void>;
  // sha(40자) 커밋을 되돌리는 새 커밋을 message로 만들고 그 SHA를 돌려준다. 충돌하면 되돌리기를 중단하고 null.
  revert(sha: string, message: string): Promise<string | null>;
  // 지정한 경로만 fromSha(40자)의 내용으로 되돌려 작업 트리·스테이지에 올린다. fromSha에 없던 파일은 지운다. 커밋은 하지 않는다.
  restorePaths(paths: string[], fromSha: string): Promise<void>;
}

function splitZ(out: string): string[] {
  return out.split("\0").filter((s) => s.length > 0);
}

const BRANCH = /^(main|factory\/(issue|revert-issue)-[1-9]\d*)$/;
const SHA = /^[0-9a-f]{40}$/;
const START_POINT = /^((origin\/)?(main|factory\/(issue|revert-issue)-[1-9]\d*)|[0-9a-f]{40})$/;

function assertRef(kind: string, value: string, re: RegExp): void {
  if (!re.test(value)) throw new Error(`git: invalid ${kind}: ${JSON.stringify(value)}`);
}

export function createGit(
  cwd: string,
  identity: GitIdentity,
  spawnFn: SpawnFn = runProcess,
  env: Record<string, string> = scrubEnv(process.env),
): GitPort {
  // 에이전트가 .git/hooks에 심은 스크립트가 토큰이 있는 publish 단계에서 실행되지 않게 한다.
  const base = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgsign=false",
    "-c",
    `user.name=${identity.name}`,
    "-c",
    `user.email=${identity.email}`,
  ];
  // name은 오류 메시지용이다. args에는 토큰이 들어갈 수 있으므로 메시지에 넣지 않는다.
  async function git(name: string, args: string[], allowFail = false): Promise<ProcessResult> {
    const r = await spawnFn("git", [...base, ...args], { cwd, env });
    if (r.code !== 0 && !allowFail) {
      throw new Error(`git ${name} failed (${r.code}): ${r.stderr.trim()}`);
    }
    return r;
  }
  const port: GitPort = {
    async fetch(ref) {
      await git("fetch", [
        "fetch",
        "--no-tags",
        "origin",
        `+refs/heads/${ref}:refs/remotes/origin/${ref}`,
      ]);
    },
    async checkoutNewBranch(branch, startPoint) {
      assertRef("branch", branch, BRANCH);
      assertRef("start point", startPoint, START_POINT);
      await git("checkout", ["checkout", "-B", branch, startPoint]);
    },
    async changedFiles() {
      const r = await git("status", [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--no-renames",
      ]);
      return splitZ(r.stdout).map((entry) => entry.slice(3));
    },
    async filesAgainst(baseRef) {
      const r = await git("diff", [
        "diff",
        "--name-only",
        "-z",
        "--no-renames",
        `${baseRef}...HEAD`,
      ]);
      return [...new Set([...splitZ(r.stdout), ...(await port.changedFiles())])].sort();
    },
    async diffAgainst(baseRef) {
      return (await git("diff", ["diff", "--no-color", "--no-renames", `${baseRef}...HEAD`]))
        .stdout;
    },
    async commitAll(message) {
      await git("add", ["add", "-A"]);
      await git("commit", ["commit", "--no-verify", "-m", message]);
      return port.headSha();
    },
    async rebaseOnto(baseRef) {
      const r = await git("rebase", ["rebase", baseRef], true);
      if (r.code === 0) return true;
      await git("rebase", ["rebase", "--abort"], true);
      return false;
    },
    async createBundle(file) {
      await git("bundle", ["bundle", "create", file, "HEAD"]);
    },
    async importBundle(file, branch) {
      assertRef("branch", branch, BRANCH);
      await git("fetch", ["fetch", "--no-tags", file, `+HEAD:refs/heads/${branch}`]);
      await git("checkout", ["checkout", branch]);
    },
    async push(branch, token, expectSha) {
      if (expectSha !== undefined) assertRef("sha", expectSha, SHA);
      const auth = Buffer.from(`x-access-token:${token}`).toString("base64");
      await git("push", [
        "-c",
        `http.https://github.com/.extraheader=AUTHORIZATION: basic ${auth}`,
        "push",
        expectSha === undefined
          ? "--force"
          : `--force-with-lease=refs/heads/${branch}:${expectSha}`,
        "origin",
        `HEAD:refs/heads/${branch}`,
      ]);
    },
    async headSha() {
      return (await git("rev-parse", ["rev-parse", "HEAD"])).stdout.trim();
    },
    async revParse(ref) {
      assertRef("ref", ref, START_POINT);
      return (await git("rev-parse", ["rev-parse", "--verify", `${ref}^{commit}`])).stdout.trim();
    },
    async resetSoft(sha) {
      assertRef("sha", sha, SHA);
      await git("reset", ["reset", "--soft", sha]);
    },
    async revert(sha, message) {
      assertRef("sha", sha, SHA);
      const r = await git("revert", ["revert", "--no-commit", sha], true);
      if (r.code !== 0) {
        await git("revert", ["revert", "--abort"], true);
        return null;
      }
      await git("commit", ["commit", "--no-verify", "-m", message]);
      return port.headSha();
    },
    async restorePaths(paths, fromSha) {
      assertRef("sha", fromSha, SHA);
      for (const p of paths) {
        const exists = await git("cat-file", ["cat-file", "-e", `${fromSha}:${p}`], true);
        if (exists.code === 0) {
          await git("checkout", ["--literal-pathspecs", "checkout", fromSha, "--", p]);
        } else {
          await git("rm", ["--literal-pathspecs", "rm", "-rf", "--ignore-unmatch", "--", p]);
        }
      }
    },
    async isAncestor(baseSha) {
      assertRef("sha", baseSha, SHA);
      const r = await git("merge-base", ["merge-base", "--is-ancestor", baseSha, "HEAD"], true);
      return r.code === 0;
    },
  };
  return port;
}
