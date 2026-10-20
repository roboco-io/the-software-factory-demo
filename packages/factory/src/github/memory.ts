import {
  type LabeledIssueRef,
  BranchNotFoundError,
  ConflictError,
  type BoardSpec,
  type BoardSyncResult,
  type ChangedFile,
  type CheckRun,
  type CommitInfo,
  type Comment,
  type FileContent,
  type GitHubPort,
  type Issue,
  type MergedPull,
  type Permission,
  type Pull,
  type Review,
} from "./port";

interface StoredPull extends Pull {
  files: ChangedFile[];
  mergedAt?: string;
}

function toChanged(f: string | ChangedFile): ChangedFile {
  return typeof f === "string" ? { filename: f, additions: [], deletions: [] } : { ...f };
}

function clonePull(p: StoredPull): Pull {
  return {
    number: p.number,
    title: p.title,
    body: p.body,
    author: p.author,
    headRef: p.headRef,
    headSha: p.headSha,
    baseRef: p.baseRef,
    labels: [...p.labels],
    draft: p.draft,
    state: p.state,
    merged: p.merged,
  };
}

// 단계 스크립트 테스트용 GitHub. 실제 API의 의미(번호 공유, sha 잠금, head sha 병합 조건)만 흉내 낸다.
export class InMemoryGitHub implements GitHubPort {
  readonly botLogin: string;
  readonly issues = new Map<number, Issue>();
  readonly pulls = new Map<number, StoredPull>();
  readonly comments = new Map<number, Comment[]>();
  readonly reviews = new Map<number, Review[]>();
  readonly checkRuns = new Map<string, CheckRun[]>();
  readonly commitMessages = new Map<string, string>();
  readonly permissions = new Map<string, Permission>();
  readonly contents = new Map<string, FileContent>();
  readonly variables = new Map<string, string>();
  readonly labels = new Map<string, { color: string; description: string }>();
  readonly branches = new Set<string>();
  readonly branchHeads = new Map<string, { sha: string; files: ChangedFile[] }>();
  readonly dispatches: { file: string; inputs: Record<string, string> }[] = [];
  readonly cancelled: number[] = [];
  readonly merges: { pr: number; sha: string; title: string; message: string; mergeSha: string }[] =
    [];
  readonly orphanMessages = new Map<string, string>();
  readonly writes: { branch: string; path: string; message: string }[] = [];
  readonly commits: CommitInfo[] = [];
  readonly createdAt = new Map<number, string>();
  readonly board = new Map<number, string>();
  boardState: "ok" | "missing" | "ambiguous" | "error" = "ok";
  clock: () => Date = () => new Date();
  injectConflicts = 0;
  mergeResult = true;
  private seq = 1;
  private commentSeq = 1;
  private blobSeq = 1;

  constructor(opts: { botLogin: string }) {
    this.botLogin = opts.botLogin;
  }

  addIssue(input: { title: string; body?: string; author?: string; labels?: string[] }): Issue {
    const issue: Issue = {
      number: this.seq++,
      title: input.title,
      body: input.body ?? "",
      author: input.author ?? "someone",
      labels: [...(input.labels ?? [])],
      state: "open",
      isPullRequest: false,
    };
    this.issues.set(issue.number, issue);
    this.createdAt.set(issue.number, this.clock().toISOString());
    return { ...issue, labels: [...issue.labels] };
  }

  addComment(n: number, author: string, body: string): void {
    const list = this.comments.get(n) ?? [];
    list.push({ id: this.commentSeq++, author, body });
    this.comments.set(n, list);
  }

  setBranch(branch: string, sha: string, files: (string | ChangedFile)[]): void {
    const changed = files.map(toChanged);
    this.branchHeads.set(branch, { sha, files: changed });
    for (const p of this.pulls.values()) {
      if (p.headRef === branch && p.state === "open") {
        p.headSha = sha;
        p.files = changed.map((f) => ({ ...f }));
      }
    }
  }

  setChecks(sha: string, conclusions: Record<string, string | null>, status = "completed"): void {
    this.checkRuns.set(
      sha,
      Object.entries(conclusions).map(([name, conclusion]) => ({ name, status, conclusion })),
    );
  }

  humanMerge(n: number, message: string): string {
    const p = this.mustPull(n);
    p.state = "closed";
    p.merged = true;
    const sha = `human-merge-${n}`;
    this.commitMessages.set(sha, message);
    return sha;
  }

  private mustPull(n: number): StoredPull {
    const p = this.pulls.get(n);
    if (!p) throw new Error(`pull #${n} not found`);
    return p;
  }

  private labelsOf(n: number): string[] {
    const target = this.issues.get(n) ?? this.pulls.get(n);
    if (!target) throw new Error(`#${n} not found`);
    return target.labels;
  }

  async getIssue(n: number): Promise<Issue> {
    const p = this.pulls.get(n);
    if (p) {
      return {
        number: n,
        title: p.title,
        body: p.body,
        author: p.author,
        labels: [...p.labels],
        state: p.state,
        isPullRequest: true,
      };
    }
    const i = this.issues.get(n);
    if (!i) throw new Error(`issue #${n} not found`);
    return { ...i, labels: [...i.labels] };
  }
  async listOpenIssues(): Promise<Issue[]> {
    return [...this.issues.values()]
      .filter((i) => i.state === "open")
      .map((i) => ({ ...i, labels: [...i.labels] }));
  }
  async listClosedIssuesWithLabel(label: string): Promise<Issue[]> {
    return [...this.issues.values()]
      .filter((i) => i.state === "closed" && !i.isPullRequest && i.labels.includes(label))
      .map((i) => ({ ...i, labels: [...i.labels] }));
  }
  async latestIssueWithLabel(label: string): Promise<LabeledIssueRef | null> {
    const hits = [...this.issues.values()]
      .filter((i) => !i.isPullRequest && i.labels.includes(label))
      .sort((a, b) => b.number - a.number);
    const i = hits[0];
    return i
      ? { number: i.number, state: i.state, createdAt: this.createdAt.get(i.number) ?? "" }
      : null;
  }
  async addLabels(n: number, labels: string[]): Promise<void> {
    const cur = this.labelsOf(n);
    for (const l of labels) if (!cur.includes(l)) cur.push(l);
  }
  async removeLabel(n: number, label: string): Promise<void> {
    const cur = this.labelsOf(n);
    const i = cur.indexOf(label);
    if (i >= 0) cur.splice(i, 1);
  }
  async comment(n: number, body: string): Promise<void> {
    this.labelsOf(n);
    this.addComment(n, this.botLogin, body);
  }
  async listComments(n: number): Promise<Comment[]> {
    return [...(this.comments.get(n) ?? [])];
  }
  async closeIssue(n: number): Promise<void> {
    const i = this.issues.get(n);
    if (i) i.state = "closed";
  }
  async reopenIssue(n: number): Promise<void> {
    const i = this.issues.get(n);
    if (i) i.state = "open";
  }
  async editComment(id: number, body: string): Promise<void> {
    for (const list of this.comments.values()) {
      const c = list.find((x) => x.id === id);
      if (c) {
        c.body = body;
        return;
      }
    }
    throw new Error(`comment ${id} not found`);
  }
  async getPermission(user: string): Promise<Permission> {
    return this.permissions.get(user) ?? "none";
  }
  async getPull(n: number): Promise<Pull> {
    return clonePull(this.mustPull(n));
  }
  async findOpenPullByHead(branch: string): Promise<Pull | null> {
    for (const p of this.pulls.values())
      if (p.headRef === branch && p.state === "open") return clonePull(p);
    return null;
  }
  async listOpenPulls(): Promise<Pull[]> {
    return [...this.pulls.values()].filter((p) => p.state === "open").map(clonePull);
  }
  async listPullFiles(n: number): Promise<ChangedFile[]> {
    return this.mustPull(n).files.map((f) => ({ ...f }));
  }
  async createPull(input: {
    title: string;
    body: string;
    head: string;
    base: string;
    draft: boolean;
  }): Promise<number> {
    const head = this.branchHeads.get(input.head);
    if (!head) throw new Error(`branch ${input.head} was not pushed`);
    const n = this.seq++;
    this.pulls.set(n, {
      number: n,
      title: input.title,
      body: input.body,
      author: this.botLogin,
      headRef: input.head,
      headSha: head.sha,
      baseRef: input.base,
      labels: [],
      draft: input.draft,
      state: "open",
      merged: false,
      files: head.files.map((f) => ({ ...f })),
    });
    return n;
  }
  async updatePullBody(n: number, body: string): Promise<void> {
    this.mustPull(n).body = body;
  }
  async markReady(n: number): Promise<void> {
    this.mustPull(n).draft = false;
  }
  async createReview(
    n: number,
    input: { event: "COMMENT"; body: string; commitId: string },
  ): Promise<void> {
    this.mustPull(n);
    const list = this.reviews.get(n) ?? [];
    list.push({
      author: this.botLogin,
      state: "COMMENTED",
      body: input.body,
      commitId: input.commitId,
    });
    this.reviews.set(n, list);
  }
  async listReviews(n: number): Promise<Review[]> {
    return [...(this.reviews.get(n) ?? [])];
  }
  async listCheckRuns(sha: string): Promise<CheckRun[]> {
    return [...(this.checkRuns.get(sha) ?? [])];
  }
  async mergePull(
    n: number,
    input: { sha: string; title: string; message: string },
  ): Promise<boolean> {
    const p = this.mustPull(n);
    if (!this.mergeResult || p.state !== "open" || p.headSha !== input.sha) return false;
    p.state = "closed";
    p.merged = true;
    const mergeSha = `merge-${n}`;
    this.commitMessages.set(mergeSha, `${input.title}\n\n${input.message}`);
    this.merges.push({ pr: n, ...input, mergeSha });
    return true;
  }
  async listCommits(since: Date): Promise<CommitInfo[]> {
    return this.commits.filter((c) => new Date(c.date) >= since).map((c) => ({ ...c }));
  }
  async listMergedPulls(since: Date): Promise<MergedPull[]> {
    return [...this.pulls.values()]
      .filter((p) => p.merged && p.mergedAt !== undefined && new Date(p.mergedAt) >= since)
      .map((p) => ({
        number: p.number,
        title: p.title,
        body: p.body,
        author: p.author,
        labels: [...p.labels],
        mergedAt: p.mergedAt as string,
        mergeSha: this.merges.find((m) => m.pr === p.number)?.mergeSha ?? null,
        headSha: p.headSha,
      }));
  }
  async getCommitMessage(sha: string): Promise<string> {
    const m = this.commitMessages.get(sha);
    if (m === undefined) throw new Error(`commit ${sha} not found`);
    return m;
  }
  async readFile(branch: string, path: string): Promise<FileContent | null> {
    const c = this.contents.get(`${branch}:${path}`);
    return c ? { ...c } : null;
  }
  async writeFile(
    branch: string,
    path: string,
    content: string,
    sha: string | null,
    message: string,
  ): Promise<void> {
    if (this.injectConflicts > 0) {
      this.injectConflicts--;
      throw new ConflictError(`${path} changed`);
    }
    if (!this.branches.has(branch) && !this.branchHeads.has(branch))
      throw new BranchNotFoundError(`Branch ${branch} not found`);
    const key = `${branch}:${path}`;
    if ((this.contents.get(key)?.sha ?? null) !== sha)
      throw new ConflictError(`${path} changed (sha)`);
    this.contents.set(key, { content, sha: `blob-${this.blobSeq++}` });
    this.writes.push({ branch, path, message });
  }
  async setVariable(name: string, value: string): Promise<void> {
    this.variables.set(name, value);
  }
  async createIssue(title: string, body: string, labels: string[]): Promise<number> {
    return this.addIssue({ title, body, author: this.botLogin, labels }).number;
  }
  async dispatchWorkflow(file: string, inputs: Record<string, string>): Promise<void> {
    this.dispatches.push({ file, inputs: { ...inputs } });
  }
  async cancelRunsForIssue(issue: number): Promise<number> {
    this.cancelled.push(issue);
    return 1;
  }
  async ensureLabel(name: string, color: string, description: string): Promise<void> {
    if (!this.labels.has(name)) this.labels.set(name, { color, description });
  }
  async ensureBoard(): Promise<{ created: boolean; url: string }> {
    if (this.boardState === "error") throw new Error("board error");
    const created = this.boardState === "missing";
    if (created) this.boardState = "ok";
    return { created, url: "https://github.com/orgs/test/projects/1" };
  }
  async syncBoardStatus(_spec: BoardSpec, issue: number, option: string): Promise<BoardSyncResult> {
    if (this.boardState === "error") throw new Error("board error");
    if (this.boardState === "missing") return "no-board";
    if (this.boardState === "ambiguous") return "ambiguous";
    this.board.set(issue, option);
    return "synced";
  }
  async createOrphanBranch(
    branch: string,
    files: Record<string, string>,
    message: string,
  ): Promise<void> {
    if (this.branches.has(branch)) return;
    this.branches.add(branch);
    this.orphanMessages.set(branch, message);
    for (const [p, c] of Object.entries(files))
      this.contents.set(`${branch}:${p}`, { content: c, sha: `blob-${this.blobSeq++}` });
  }
}
