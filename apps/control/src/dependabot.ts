/**
 * The rule that decides whether the factory merges a Dependabot pull request without a
 * person (docs/operations.md, "Dependabot 보안 업데이트"). Pure: every fact comes in as data.
 */

/** GitHub's Dependabot account. The login alone can be imitated; the id cannot. */
export const DEPENDABOT_USER_ID = 49699333;
export const DEPENDABOT_LOGIN = "dependabot[bot]";

export interface DependabotPr {
  number: number;
  title: string;
  author: { id: number; login: string; type: string };
  draft: boolean;
  headSha: string;
  /** The head branch is in the repository itself, not in a fork. */
  sameRepo: boolean;
  baseRef: string;
  defaultBranch: string;
  labels: string[];
}

export interface PrCommit {
  authorId: number | null;
  /** Committer time in ms. NaN when GitHub gave none. */
  committedAt: number;
}

export interface OpenAlert {
  package: string;
  /** First patched version of the advisory, when one exists. */
  patched: string | null;
}

export type ChecksState = "success" | "failed" | "pending";

export interface JudgeInput {
  pr: DependabotPr;
  commits: readonly PrCommit[];
  files: readonly string[];
  filesTruncated: boolean;
  alerts: readonly OpenAlert[];
  checks: ChecksState;
  now: number;
  minAgeMs: number;
}

export type HumanCode =
  | "not_single_update"
  | "foreign_commit"
  | "version_unreadable"
  | "major_update"
  | "not_security_update"
  | "unexpected_files"
  | "check_failed";

export type Judgement =
  | { action: "merge" }
  | { action: "skip" }
  | { action: "wait"; code: "checks_pending" | "too_new" }
  | { action: "needs_human"; code: HumanCode };

const BUMP =
  /^(?:[a-z]+(?:\([a-z-]+\))?: )?bump (\S+) from (\S+) to (\S+)(?: in \S+)?$/i;

/** The single package update a Dependabot title names. Null for grouped or other titles. */
export function parseBump(
  title: string,
): { package: string; from: string; to: string } | null {
  const m = BUMP.exec(title);
  if (m === null) return null;
  return { package: m[1] as string, from: m[2] as string, to: m[3] as string };
}

type Version = [number, number, number];

/** Plain `major.minor.patch` only. A prerelease or build tag is not read. */
function parseVersion(text: string): Version | null {
  const m = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/.exec(text);
  if (m === null) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return 0;
}

/** `package.json` in any directory, and the lockfile at the root. */
const isManifest = (path: string) =>
  path === "pnpm-lock.yaml" ||
  path === "package.json" ||
  path.endsWith("/package.json");

export function judgeDependabotPr(input: JudgeInput): Judgement {
  const { pr } = input;
  // Not a pull request this rule is about: leave it alone, without a label or a comment.
  if (
    pr.author.id !== DEPENDABOT_USER_ID ||
    pr.author.login !== DEPENDABOT_LOGIN ||
    pr.author.type !== "Bot" ||
    !pr.sameRepo ||
    pr.draft ||
    pr.baseRef !== pr.defaultBranch
  )
    return { action: "skip" };

  const human = (code: HumanCode): Judgement => ({
    action: "needs_human",
    code,
  });

  const bump = parseBump(pr.title);
  if (bump === null) return human("not_single_update");
  // Anyone with write access can push to the branch. Then it is no longer Dependabot's work.
  if (
    input.commits.length === 0 ||
    input.commits.some((c) => c.authorId !== DEPENDABOT_USER_ID)
  )
    return human("foreign_commit");

  const from = parseVersion(bump.from);
  const to = parseVersion(bump.to);
  if (from === null || to === null || compare(to, from) <= 0)
    return human("version_unreadable");
  // Below 1.0 a minor release may break, so only a patch release counts there.
  if (to[0] !== from[0] || (to[0] === 0 && to[1] !== from[1]))
    return human("major_update");

  const fixesAlert = input.alerts.some((alert) => {
    if (alert.package !== bump.package || alert.patched === null) return false;
    const patched = parseVersion(alert.patched);
    return patched !== null && compare(to, patched) >= 0;
  });
  if (!fixesAlert) return human("not_security_update");

  if (
    input.filesTruncated ||
    input.files.length === 0 ||
    !input.files.every(isManifest)
  )
    return human("unexpected_files");

  if (input.checks === "failed") return human("check_failed");
  if (input.checks === "pending")
    return { action: "wait", code: "checks_pending" };

  // The waiting period gives the registry and the community time to pull a bad release.
  const newest = Math.max(...input.commits.map((c) => c.committedAt));
  if (!(input.now - newest >= input.minAgeMs))
    return { action: "wait", code: "too_new" };

  return { action: "merge" };
}
