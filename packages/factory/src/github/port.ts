import type { ChangedFile } from "../policy/risk";

export type { ChangedFile };

export type Permission = "admin" | "maintain" | "write" | "triage" | "read" | "none";

export interface Issue {
  number: number;
  title: string;
  body: string;
  author: string;
  labels: string[];
  state: "open" | "closed";
  isPullRequest: boolean;
}

export interface LabeledIssueRef {
  number: number;
  state: "open" | "closed";
  createdAt: string;
}

export interface Comment {
  id: number;
  author: string;
  body: string;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  author: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  labels: string[];
  draft: boolean;
  state: "open" | "closed";
  merged: boolean;
}

export interface Review {
  author: string;
  state: string;
  body: string;
  commitId: string;
}

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface FileContent {
  content: string;
  sha: string;
}

export interface CommitInfo {
  sha: string;
  message: string;
  date: string;
}

export interface MergedPull {
  number: number;
  title: string;
  body: string;
  author: string;
  labels: string[];
  mergedAt: string;
  mergeSha: string | null;
  headSha: string | null;
}

export interface BoardSpec {
  title: string;
  field: string;
  options: readonly string[];
}

export type BoardSyncResult = "synced" | "no-board" | "ambiguous";

export class BranchNotFoundError extends Error {
  override name = "BranchNotFoundError";
}

export class TooManyFilesError extends Error {
  override name = "TooManyFilesError";
}

export class ConflictError extends Error {
  override name = "ConflictError";
}

export interface GitHubPort {
  getIssue(n: number): Promise<Issue>;
  listOpenIssues(): Promise<Issue[]>;
  // 라벨이 붙은 닫힌 이슈(PR 제외) 전체. 끝까지 읽지 못하면 예외다.
  listClosedIssuesWithLabel(label: string): Promise<Issue[]>;
  // 열림·닫힘 상관없이 라벨이 붙은 이슈(PR 제외) 가운데 가장 최근에 만든 것.
  latestIssueWithLabel(label: string): Promise<LabeledIssueRef | null>;
  addLabels(n: number, labels: string[]): Promise<void>;
  removeLabel(n: number, label: string): Promise<void>;
  comment(n: number, body: string): Promise<void>;
  listComments(n: number): Promise<Comment[]>;
  closeIssue(n: number): Promise<void>;
  reopenIssue(n: number): Promise<void>;
  editComment(id: number, body: string): Promise<void>;
  getPermission(user: string): Promise<Permission>;
  getPull(n: number): Promise<Pull>;
  findOpenPullByHead(branch: string): Promise<Pull | null>;
  // 열린 PR(base main) 전체. 끝까지 읽지 못하면 예외다.
  listOpenPulls(): Promise<Pull[]>;
  listPullFiles(n: number): Promise<ChangedFile[]>;
  createPull(input: {
    title: string;
    body: string;
    head: string;
    base: string;
    draft: boolean;
  }): Promise<number>;
  updatePullBody(n: number, body: string): Promise<void>;
  // draft PR을 ready for review로 바꾼다(GraphQL markPullRequestReadyForReview).
  markReady(n: number): Promise<void>;
  createReview(
    n: number,
    input: { event: "COMMENT"; body: string; commitId: string },
  ): Promise<void>;
  listReviews(n: number): Promise<Review[]>;
  listCheckRuns(sha: string): Promise<CheckRun[]>;
  mergePull(n: number, input: { sha: string; title: string; message: string }): Promise<boolean>;
  // main의 커밋 가운데 since 이후 것. 끝까지 읽지 못하면 예외다.
  listCommits(since: Date): Promise<CommitInfo[]>;
  // since 이후 병합된 PR(base main). 끝까지 읽지 못하면 예외다.
  listMergedPulls(since: Date): Promise<MergedPull[]>;
  getCommitMessage(sha: string): Promise<string>;
  readFile(branch: string, path: string): Promise<FileContent | null>;
  writeFile(
    branch: string,
    path: string,
    content: string,
    sha: string | null,
    message: string,
  ): Promise<void>;
  setVariable(name: string, value: string): Promise<void>;
  createIssue(title: string, body: string, labels: string[]): Promise<number>;
  dispatchWorkflow(file: string, inputs: Record<string, string>): Promise<void>;
  cancelRunsForIssue(issue: number): Promise<number>;
  ensureLabel(name: string, color: string, description: string): Promise<void>;
  // 조직 Projects v2 보드를 만든다. 제목이 같은 보드가 이미 있으면 만들지 않는다.
  ensureBoard(spec: BoardSpec): Promise<{ created: boolean; url: string }>;
  // 이슈를 보드에 추가하고 단일 선택 필드를 option으로 맞춘다.
  syncBoardStatus(spec: BoardSpec, issue: number, option: string): Promise<BoardSyncResult>;
  createOrphanBranch(branch: string, files: Record<string, string>, message: string): Promise<void>;
}
