/**
 * The rule that decides whether the factory merges a Dependabot pull request without a
 * person (docs/operations.md, "Dependabot 보안 업데이트"). Pure: every fact comes in as data.
 */

/** GitHub's Dependabot account. The login alone can be imitated; the id cannot. */
export const DEPENDABOT_USER_ID = 49699333;
export const DEPENDABOT_LOGIN = "dependabot[bot]";
/** The account GitHub commits as when it writes a commit itself and signs it. */
export const GITHUB_WEB_FLOW_ID = 19864447;

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
  /** Derived by GitHub from the author email, which whoever pushes can choose. */
  authorId: number | null;
  committerId: number | null;
  /** GitHub verified the signature and reports it as valid. */
  verified: boolean;
  /** The commit message. It is part of what the signature covers. */
  message: string;
  /** Committer time in ms. NaN when GitHub gave none. */
  committedAt: number;
}

export interface PrFile {
  path: string;
  /** GitHub's status of the file in the pull request: modified, added, renamed, ... */
  status: string;
  /** The diff GitHub gives for the file. Null when GitHub left it out. */
  patch: string | null;
}

export interface OpenAlert {
  package: string;
  ecosystem: string;
  /** First patched version of the advisory, when one exists. */
  patched: string | null;
}

export type ChecksState = "success" | "failed" | "pending";

export interface JudgeInput {
  pr: DependabotPr;
  commits: readonly PrCommit[];
  files: readonly PrFile[];
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
  /^(?:[a-z]+(?:\([a-z-]+\))?: )?bump ((?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+) from ([0-9A-Za-z.+-]+) to ([0-9A-Za-z.+-]+)(?: in \S+)?$/i;

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

const LOCKFILE = "pnpm-lock.yaml";
const isPackageJson = (path: string) =>
  (path === "package.json" || path.endsWith("/package.json")) &&
  !path.split("/").includes("node_modules");

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Added and removed lines of a GitHub patch, without the leading sign. */
function changedLines(patch: string): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("+")) added.push(line.slice(1));
    else if (line.startsWith("-")) removed.push(line.slice(1));
  }
  return { added, removed };
}

/** A manifest may change nothing but the version range of the one package. */
function manifestOk(
  patch: string,
  bump: { package: string; from: string; to: string },
): boolean {
  const { added, removed } = changedLines(patch);
  const line = (version: string) =>
    new RegExp(
      `^\\s*"${escapeRegExp(bump.package)}": "[\\^~]?${escapeRegExp(version)}",?\\s*$`,
    );
  return (
    added.length > 0 &&
    added.length === removed.length &&
    added.every((l) => line(bump.to).test(l)) &&
    removed.every((l) => line(bump.from).test(l))
  );
}

/** Anything that makes a lockfile entry come from somewhere other than the registry. */
const LOCK_SOURCE =
  /https?:|git[+@:]|ssh:|file:|link:|tarball|github:|gitlab:|bitbucket:|directory:|commit:|repo:|type:/i;
const LOCK_RESOLUTION =
  /^\s*resolution: \{integrity: sha512-[A-Za-z0-9+/=]+\}$/;

/**
 * A lockfile update pulls in whatever the new version depends on, so its lines cannot be
 * matched one by one. Added lines must at least keep every entry on the registry.
 */
function lockfileOk(
  patch: string,
  bump: { package: string; to: string },
): boolean {
  const { added } = changedLines(patch);
  const name = escapeRegExp(bump.package);
  const to = escapeRegExp(bump.to);
  // The update itself must be there: the package's entry at the new version, or, when
  // that version was already in the lockfile, an importer moving to it.
  const entry = new RegExp(`^\\s*'?${name}@${to}['(:]`);
  const moved = new RegExp(`^\\s*version: ${to}(\\(|$)`);
  return (
    added.some((l) => entry.test(l) || moved.test(l)) &&
    added.every((l) =>
      /^\s*resolution:/.test(l)
        ? LOCK_RESOLUTION.test(l)
        : !LOCK_SOURCE.test(l),
    )
  );
}

function filesOk(
  files: readonly PrFile[],
  bump: { package: string; from: string; to: string },
): boolean {
  // An update always changes the lockfile.
  if (!files.some((file) => file.path === LOCKFILE)) return false;
  return files.every((file) => {
    if (file.status !== "modified" || file.patch === null) return false;
    if (file.path === LOCKFILE) return lockfileOk(file.patch, bump);
    return isPackageJson(file.path) && manifestOk(file.patch, bump);
  });
}

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

  // Anyone with write access can push to the branch, and can write any author into a
  // commit. What they cannot do is have GitHub sign it as its own commit: Dependabot's
  // commit is committed and signed by GitHub. Dependabot keeps one commit per pull
  // request, so a second commit is someone else's.
  const [commit] = input.commits;
  if (
    commit === undefined ||
    input.commits.length !== 1 ||
    commit.authorId !== DEPENDABOT_USER_ID ||
    commit.committerId !== GITHUB_WEB_FLOW_ID ||
    !commit.verified
  )
    return human("foreign_commit");

  // What is updated comes from the signed commit message. The title can be edited by
  // anyone who may triage; it only has to agree.
  const bump = parseBump(commit.message.split("\n", 1)[0] as string);
  const titled = parseBump(pr.title);
  if (
    bump === null ||
    titled === null ||
    titled.package !== bump.package ||
    titled.from !== bump.from ||
    titled.to !== bump.to
  )
    return human("not_single_update");

  const from = parseVersion(bump.from);
  const to = parseVersion(bump.to);
  if (from === null || to === null || compare(to, from) <= 0)
    return human("version_unreadable");
  // Below 1.0 a minor release may break, so only a patch release counts there.
  if (to[0] !== from[0] || (to[0] === 0 && to[1] !== from[1]))
    return human("major_update");

  const fixesAlert = input.alerts.some((alert) => {
    if (
      alert.ecosystem !== "npm" ||
      alert.package !== bump.package ||
      alert.patched === null
    )
      return false;
    const patched = parseVersion(alert.patched);
    // The old version must be affected and the new one fixed.
    return (
      patched !== null &&
      compare(from, patched) < 0 &&
      compare(to, patched) >= 0
    );
  });
  if (!fixesAlert) return human("not_security_update");

  if (input.filesTruncated || !filesOk(input.files, bump))
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
