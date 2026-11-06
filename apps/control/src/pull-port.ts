import type { CheckRun, ReviewEntry } from "./decision";

export interface PullRequestInfo {
  state: "open" | "closed";
  merged: boolean;
  headSha: string;
  /** The branch the pull request merges into. */
  baseRef: string;
  /** The repository's default branch. */
  defaultBranch: string;
  authorId: string | null;
  /** The file count GitHub reports for the pull request. */
  changedFiles: number;
}

export interface ChangedFileInfo {
  filename: string;
  previousFilename?: string | undefined;
}

export type PolicyFile = { kind: "ok"; text: string } | { kind: "missing" };

/** The App is not allowed to read check runs (the Checks read permission is not granted). */
export class ChecksPermissionMissing extends Error {
  constructor() {
    super("checks permission missing");
    this.name = "ChecksPermissionMissing";
  }
}

export type MergeResult = "merged" | "refused" | "conflict";

/**
 * Everything the machine needs from GitHub after the pull request exists.
 * All reads are for the repository's `owner/name` and are pinned by SHA where it matters.
 */
export interface PullRequestPort {
  getPullRequest(repo: string, prNumber: number): Promise<PullRequestInfo>;
  /** All changed files, paged. `truncated` is true when the list may be incomplete. */
  listFiles(
    repo: string,
    prNumber: number,
    expectedCount: number,
  ): Promise<{ files: ChangedFileInfo[]; truncated: boolean }>;
  /** `.factory/policy.yml` at the tip of the default branch, never at the pull request head. */
  readPolicy(repo: string, defaultBranch: string): Promise<PolicyFile>;
  /** The diff between two commits. */
  getDiff(repo: string, baseSha: string, headSha: string): Promise<string>;
  /** Check runs for a commit, paged. Throws ChecksPermissionMissing on a permission 403. */
  listChecks(repo: string, sha: string): Promise<CheckRun[]>;
  /** Reviews of the pull request, oldest first, paged. */
  listReviews(repo: string, prNumber: number): Promise<ReviewEntry[]>;
  /** Posts a comment-only review on the given commit. */
  postReview(
    repo: string,
    prNumber: number,
    headSha: string,
    body: string,
  ): Promise<void>;
  /** Squash merge pinned to `headSha`. Never forced. 405 is "refused", 409 is "conflict". */
  merge(
    repo: string,
    prNumber: number,
    headSha: string,
    message: { title: string; body: string },
  ): Promise<MergeResult>;
}
