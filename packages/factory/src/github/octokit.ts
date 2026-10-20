import { Octokit } from "@octokit/rest";
import {
  BranchNotFoundError,
  ConflictError,
  TooManyFilesError,
  type BoardSpec,
  type BoardSyncResult,
  type CheckRun,
  type GitHubPort,
  type MergedPull,
  type Issue,
  type Permission,
  type Pull,
} from "./port";
import { addedLinesFromPatch, deletedLinesFromPatch } from "../policy/risk";

const FIND_BOARD = `query($org: String!, $q: String!) {
  organization(login: $org) {
    id
    projectsV2(first: 20, query: $q) {
      nodes {
        id
        title
        url
        fields(first: 50) {
          nodes { ... on ProjectV2SingleSelectField { id name options { id name } } }
        }
      }
    }
  }
}`;

const BOARD_TIMEOUT_MS = 10_000;

interface BoardInfo {
  orgId: string;
  projectId: string;
  url: string;
  fieldId: string;
  options: Map<string, string>;
}

type BoardLookup =
  | { kind: "found"; board: BoardInfo }
  | { kind: "none"; orgId: string }
  | { kind: "ambiguous" }
  | { kind: "no-field"; projectId: string; url: string };

const MAX_PULL_FILES = 3000;

const PERMISSIONS: readonly Permission[] = ["admin", "maintain", "write", "triage", "read"];

function statusOf(e: unknown): number | undefined {
  if (typeof e === "object" && e !== null && "status" in e)
    return Number((e as { status: unknown }).status);
  return undefined;
}

function labelNames(labels: (string | { name?: string | null })[]): string[] {
  return labels
    .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
    .filter((l) => l.length > 0);
}

interface RawIssue {
  number: number;
  title: string;
  body?: string | null;
  user: { login: string } | null;
  labels: (string | { name?: string | null })[];
  state: string;
  pull_request?: unknown;
}

interface RawPull {
  number: number;
  title: string;
  body: string | null;
  user: { login: string } | null;
  head: { ref: string; sha: string };
  base: { ref: string };
  labels: { name?: string | null }[];
  draft?: boolean;
  state: string;
  merged?: boolean | null;
  merged_at?: string | null;
}

function toIssue(d: RawIssue): Issue {
  return {
    number: d.number,
    title: d.title,
    body: d.body ?? "",
    author: d.user?.login ?? "",
    labels: labelNames(d.labels),
    state: d.state === "closed" ? "closed" : "open",
    isPullRequest: Boolean(d.pull_request),
  };
}

function toPull(d: RawPull): Pull {
  return {
    number: d.number,
    title: d.title,
    body: d.body ?? "",
    author: d.user?.login ?? "",
    headRef: d.head.ref,
    headSha: d.head.sha,
    baseRef: d.base.ref,
    labels: labelNames(d.labels),
    draft: d.draft ?? false,
    state: d.state === "closed" ? "closed" : "open",
    merged: Boolean(d.merged ?? d.merged_at),
  };
}

export function createOctokitPort(o: {
  token: string;
  owner: string;
  repo: string;
  fetch?: typeof fetch;
  excludeRunId?: number | null;
}): GitHubPort {
  const octokit = new Octokit({
    auth: o.token,
    ...(o.fetch ? { request: { fetch: o.fetch } } : {}),
  });
  const base = { owner: o.owner, repo: o.repo };

  // 멈춘 GraphQL 호출이 상태 전이를 붙잡지 않도록 보드 호출에는 제한 시간을 둔다.
  const boardGql = <T = unknown>(query: string, vars: Record<string, unknown> = {}): Promise<T> =>
    octokit.graphql<T>(query, {
      ...vars,
      request: { signal: AbortSignal.timeout(BOARD_TIMEOUT_MS) },
    });
  let cached: BoardInfo | null = null;
  async function findBoard(spec: BoardSpec): Promise<BoardLookup> {
    if (cached) return { kind: "found", board: cached };
    const res = await boardGql<{
      organization: {
        id: string;
        projectsV2: {
          nodes: {
            id: string;
            title: string;
            url: string;
            fields: {
              nodes: { id?: string; name?: string; options?: { id: string; name: string }[] }[];
            };
          }[];
        };
      };
    }>(FIND_BOARD, { org: base.owner, q: spec.title });
    const org = res.organization;
    const hits = org.projectsV2.nodes.filter((n) => n.title === spec.title);
    if (hits.length === 0) return { kind: "none", orgId: org.id };
    if (hits.length > 1) return { kind: "ambiguous" };
    const hit = hits[0]!;
    const field = hit.fields.nodes.find((f) => f.name === spec.field && f.options);
    if (!field?.id || !field.options) return { kind: "no-field", projectId: hit.id, url: hit.url };
    const options = new Map(field.options.map((o) => [o.name, o.id]));
    for (const o of spec.options) {
      if (!options.has(o)) throw new Error(`보드 옵션 없음: ${o}`);
    }
    cached = { orgId: org.id, projectId: hit.id, url: hit.url, fieldId: field.id, options };
    return { kind: "found", board: cached };
  }
  async function createBoardField(projectId: string, spec: BoardSpec): Promise<void> {
    await boardGql(
      `mutation($input: CreateProjectV2FieldInput!) { createProjectV2Field(input: $input) { projectV2Field { ... on ProjectV2SingleSelectField { id } } } }`,
      {
        input: {
          projectId,
          dataType: "SINGLE_SELECT",
          name: spec.field,
          singleSelectOptions: spec.options.map((name) => ({
            name,
            color: "GRAY",
            description: "",
          })),
        },
      },
    );
  }
  return {
    async getIssue(n) {
      const { data } = await octokit.rest.issues.get({ ...base, issue_number: n });
      return toIssue(data);
    },
    async listOpenIssues() {
      const data = await octokit.paginate(octokit.rest.issues.listForRepo, {
        ...base,
        state: "open",
        per_page: 100,
      });
      return data.filter((i) => !i.pull_request).map(toIssue);
    },
    // 최신순으로 최대 5쪽(500건)까지만 읽는다. 오래된 회귀 후보는 놓칠 수 있지만 API 호출을 제한한다.
    async listClosedIssuesWithLabel(label) {
      const data: Awaited<ReturnType<typeof octokit.rest.issues.listForRepo>>["data"] = [];
      let pages = 0;
      for await (const res of octokit.paginate.iterator(octokit.rest.issues.listForRepo, {
        ...base,
        state: "closed",
        labels: label,
        sort: "created",
        direction: "desc",
        per_page: 100,
      })) {
        data.push(...res.data);
        if (++pages >= 5) break;
      }
      return data.filter((i) => !i.pull_request).map(toIssue);
    },
    async latestIssueWithLabel(label) {
      const { data } = await octokit.rest.issues.listForRepo({
        ...base,
        state: "all",
        labels: label,
        sort: "created",
        direction: "desc",
        per_page: 10,
      });
      const i = data.find((x) => !x.pull_request);
      return i
        ? {
            number: i.number,
            state: i.state === "closed" ? "closed" : "open",
            createdAt: i.created_at,
          }
        : null;
    },
    async addLabels(n, labels) {
      if (labels.length > 0)
        await octokit.rest.issues.addLabels({ ...base, issue_number: n, labels });
    },
    async removeLabel(n, label) {
      try {
        await octokit.rest.issues.removeLabel({ ...base, issue_number: n, name: label });
      } catch (e) {
        if (statusOf(e) !== 404) throw e;
      }
    },
    async comment(n, body) {
      await octokit.rest.issues.createComment({ ...base, issue_number: n, body });
    },
    async listComments(n) {
      const data = await octokit.paginate(octokit.rest.issues.listComments, {
        ...base,
        issue_number: n,
        per_page: 100,
      });
      return data.map((c) => ({ id: c.id, author: c.user?.login ?? "", body: c.body ?? "" }));
    },
    async closeIssue(n) {
      await octokit.rest.issues.update({ ...base, issue_number: n, state: "closed" });
    },
    async reopenIssue(n) {
      await octokit.rest.issues.update({ ...base, issue_number: n, state: "open" });
    },
    async editComment(id, body) {
      await octokit.rest.issues.updateComment({ ...base, comment_id: id, body });
    },
    async getPermission(user) {
      try {
        const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
          ...base,
          username: user,
        });
        const role = (data as { role_name?: string }).role_name;
        if (role && (PERMISSIONS as readonly string[]).includes(role)) return role as Permission;
        return (PERMISSIONS as readonly string[]).includes(data.permission)
          ? (data.permission as Permission)
          : "none";
      } catch (e) {
        if (statusOf(e) === 404) return "none";
        throw e;
      }
    },
    async getPull(n) {
      const { data } = await octokit.rest.pulls.get({ ...base, pull_number: n });
      return toPull(data);
    },
    async findOpenPullByHead(branch) {
      const { data } = await octokit.rest.pulls.list({
        ...base,
        state: "open",
        head: `${o.owner}:${branch}`,
      });
      const first = data[0];
      return first ? toPull(first) : null;
    },
    async listOpenPulls() {
      const data = await octokit.paginate(octokit.rest.pulls.list, {
        ...base,
        state: "open",
        base: "main",
        per_page: 100,
      });
      return data.map(toPull);
    },
    async listPullFiles(n) {
      const { data: pull } = await octokit.rest.pulls.get({ ...base, pull_number: n });
      const expected = pull.changed_files;
      if (expected >= MAX_PULL_FILES)
        throw new TooManyFilesError(
          `pull #${n} has ${expected} changed files; GitHub lists at most ${MAX_PULL_FILES}`,
        );
      const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
        ...base,
        pull_number: n,
        per_page: 100,
      });
      if (files.length < expected)
        throw new TooManyFilesError(
          `pull #${n}: GitHub returned ${files.length} of ${expected} changed files`,
        );
      return files.map((f) => ({
        filename: f.filename,
        ...(f.previous_filename ? { previousFilename: f.previous_filename } : {}),
        additions: addedLinesFromPatch(f.patch ?? ""),
        deletions: deletedLinesFromPatch(f.patch ?? ""),
        additionCount: f.additions,
        ...(f.patch === undefined ? { patchMissing: true } : {}),
        ...(f.status === "removed" ? { removed: true } : {}),
      }));
    },
    async createPull(input) {
      const { data } = await octokit.rest.pulls.create({ ...base, ...input });
      return data.number;
    },
    async updatePullBody(n, body) {
      await octokit.rest.pulls.update({ ...base, pull_number: n, body });
    },
    async markReady(n) {
      const { data } = await octokit.rest.pulls.get({ ...base, pull_number: n });
      if (!data.draft) return;
      await octokit.graphql(
        `mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { id } } }`,
        { id: data.node_id },
      );
    },
    async createReview(n, input) {
      await octokit.rest.pulls.createReview({
        ...base,
        pull_number: n,
        event: input.event,
        body: input.body,
        commit_id: input.commitId,
      });
    },
    async listReviews(n) {
      const data = await octokit.paginate(octokit.rest.pulls.listReviews, {
        ...base,
        pull_number: n,
        per_page: 100,
      });
      return data.map((r) => ({
        author: r.user?.login ?? "",
        state: r.state,
        body: r.body ?? "",
        commitId: r.commit_id ?? "",
      }));
    },
    async listCheckRuns(sha) {
      const runs = await octokit.paginate(octokit.rest.checks.listForRef, {
        ...base,
        ref: sha,
        per_page: 100,
      });
      const latest = new Map<string, { id: number; run: CheckRun }>();
      for (const c of runs) {
        const prev = latest.get(c.name);
        if (!prev || c.id > prev.id)
          latest.set(c.name, {
            id: c.id,
            run: { name: c.name, status: c.status, conclusion: c.conclusion ?? null },
          });
      }
      return [...latest.values()].map((v) => v.run);
    },
    async mergePull(n, input) {
      try {
        const { data } = await octokit.rest.pulls.merge({
          ...base,
          pull_number: n,
          merge_method: "squash",
          sha: input.sha,
          commit_title: input.title,
          commit_message: input.message,
        });
        return data.merged;
      } catch (e) {
        if ([405, 409, 422].includes(statusOf(e) ?? 0)) return false;
        throw e;
      }
    },
    async listCommits(since) {
      const data = await octokit.paginate(octokit.rest.repos.listCommits, {
        ...base,
        sha: "main",
        since: since.toISOString(),
        per_page: 100,
      });
      return data.map((c) => ({
        sha: c.sha,
        message: c.commit.message,
        date: c.commit.committer?.date ?? c.commit.author?.date ?? "",
      }));
    },
    async listMergedPulls(since) {
      const out: MergedPull[] = [];
      for await (const res of octokit.paginate.iterator(octokit.rest.pulls.list, {
        ...base,
        state: "closed",
        base: "main",
        sort: "updated",
        direction: "desc",
        per_page: 100,
      })) {
        for (const p of res.data) {
          if (p.merged_at && new Date(p.merged_at) >= since)
            out.push({
              number: p.number,
              title: p.title,
              body: p.body ?? "",
              author: p.user?.login ?? "",
              labels: p.labels.map((l) => l.name ?? ""),
              mergedAt: p.merged_at,
              mergeSha: p.merge_commit_sha ?? null,
              headSha: p.head?.sha ?? null,
            });
        }
        const last = res.data.at(-1);
        if (!last || new Date(last.updated_at) < since) break;
      }
      return out;
    },
    async getCommitMessage(sha) {
      const { data } = await octokit.rest.repos.getCommit({ ...base, ref: sha });
      return data.commit.message;
    },
    async readFile(branch, path) {
      try {
        const { data } = await octokit.rest.repos.getContent({ ...base, path, ref: branch });
        if (Array.isArray(data) || data.type !== "file" || !("content" in data))
          throw new Error(`${path} is not a file`);
        if (data.content === "" && data.size > 0)
          throw new Error(`${path} is too large for the contents API (${data.size} bytes)`);
        return { content: Buffer.from(data.content, "base64").toString("utf8"), sha: data.sha };
      } catch (e) {
        if (statusOf(e) === 404) return null;
        throw e;
      }
    },
    async writeFile(branch, path, content, sha, message) {
      try {
        await octokit.rest.repos.createOrUpdateFileContents({
          ...base,
          path,
          branch,
          message,
          content: Buffer.from(content, "utf8").toString("base64"),
          ...(sha ? { sha } : {}),
        });
      } catch (e) {
        const s = statusOf(e);
        const msg = e instanceof Error ? e.message : "";
        if (s === 409) throw new ConflictError(`${path} changed (409)`);
        if (s === 422 && /sha/i.test(msg)) throw new ConflictError(`${path} changed (422)`);
        // Verified against real GitHub 2026-10-11: PUT contents to a missing branch returns
        // 404 with message "Branch <name> not found". Octokit may append " - <docs url>".
        if (s === 404 && /^Branch .+ not found(?: - https?:\/\/\S+)?$/.test(msg))
          throw new BranchNotFoundError(`Branch ${branch} not found`);
        throw e;
      }
    },
    async setVariable(name, value) {
      try {
        await octokit.rest.actions.updateRepoVariable({ ...base, name, value });
      } catch (e) {
        if (statusOf(e) !== 404) throw e;
        await octokit.rest.actions.createRepoVariable({ ...base, name, value });
      }
    },
    async createIssue(title, body, labels) {
      const { data } = await octokit.rest.issues.create({ ...base, title, body, labels });
      return data.number;
    },
    async dispatchWorkflow(file, inputs) {
      await octokit.rest.actions.createWorkflowDispatch({
        ...base,
        workflow_id: file,
        ref: "main",
        inputs,
      });
    },
    async cancelRunsForIssue(issue) {
      // 에이전트 워크플로의 run-name은 "<workflow> [factory/issue-N]" 형식이다(Task 17).
      const tag = `[factory/issue-${issue}]`;
      let cancelled = 0;
      for (const status of ["queued", "in_progress"] as const) {
        const runs = await octokit.paginate(octokit.rest.actions.listWorkflowRunsForRepo, {
          ...base,
          status,
          per_page: 100,
        });
        for (const run of runs) {
          if (run.id === o.excludeRunId) continue;
          if (!(run.display_title ?? "").includes(tag)) continue;
          await octokit.rest.actions.cancelWorkflowRun({ ...base, run_id: run.id });
          cancelled++;
        }
      }
      return cancelled;
    },
    async ensureLabel(name, color, description) {
      try {
        await octokit.rest.issues.getLabel({ ...base, name });
      } catch (e) {
        if (statusOf(e) !== 404) throw e;
        await octokit.rest.issues.createLabel({ ...base, name, color, description });
      }
    },
    async ensureBoard(spec) {
      const found = await findBoard(spec);
      if (found.kind === "found") return { created: false, url: found.board.url };
      if (found.kind === "ambiguous") throw new Error(`제목이 같은 보드가 둘 이상: ${spec.title}`);
      if (found.kind === "no-field") {
        // 보드는 있는데 필드 생성 전에 중단된 경우: 필드만 만들어 복구한다.
        await createBoardField(found.projectId, spec);
        return { created: false, url: found.url };
      }
      const repo = await octokit.rest.repos.get({ ...base });
      const made = await boardGql<{
        createProjectV2: { projectV2: { id: string; url: string } };
      }>(
        `mutation($ownerId: ID!, $title: String!, $repositoryId: ID!) { createProjectV2(input: {ownerId: $ownerId, title: $title, repositoryId: $repositoryId}) { projectV2 { id url } } }`,
        { ownerId: found.orgId, title: spec.title, repositoryId: repo.data.node_id },
      );
      const project = made.createProjectV2.projectV2;
      await createBoardField(project.id, spec);
      try {
        await boardGql(
          `mutation($projectId: ID!) { updateProjectV2(input: {projectId: $projectId, public: true}) { projectV2 { id } } }`,
          { projectId: project.id },
        );
      } catch (e) {
        // 조직 설정이 공개 보드를 막을 수 있다. 보드 자체는 만들어졌으므로 로그만 남긴다.
        console.warn(`board: 공개 전환 실패: ${e instanceof Error ? e.message : String(e)}`);
      }
      return { created: true, url: project.url };
    },
    async syncBoardStatus(spec, issue, option): Promise<BoardSyncResult> {
      const found = await findBoard(spec);
      if (found.kind === "none") return "no-board";
      if (found.kind === "ambiguous") return "ambiguous";
      if (found.kind === "no-field") throw new Error(`보드 필드 없음: ${spec.field}`);
      const { board } = found;
      const optionId = board.options.get(option);
      if (!optionId) throw new Error(`보드 옵션 없음: ${option}`);
      const iss = await boardGql<{ repository: { issue: { id: string } } }>(
        `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { id } } }`,
        { owner: base.owner, name: base.repo, number: issue },
      );
      const added = await boardGql<{ addProjectV2ItemById: { item: { id: string } } }>(
        `mutation($projectId: ID!, $contentId: ID!) { addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) { item { id } } }`,
        { projectId: board.projectId, contentId: iss.repository.issue.id },
      );
      await boardGql(
        `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) { updateProjectV2ItemFieldValue(input: {projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: {singleSelectOptionId: $optionId}}) { projectV2Item { id } } }`,
        {
          projectId: board.projectId,
          itemId: added.addProjectV2ItemById.item.id,
          fieldId: board.fieldId,
          optionId,
        },
      );
      return "synced";
    },
    async createOrphanBranch(branch, files, message) {
      try {
        await octokit.rest.repos.getBranch({ ...base, branch });
        return;
      } catch (e) {
        if (statusOf(e) !== 404) throw e;
      }
      const tree = await octokit.rest.git.createTree({
        ...base,
        tree: Object.entries(files).map(([path, content]) => ({
          path,
          mode: "100644" as const,
          type: "blob" as const,
          content,
        })),
      });
      const commit = await octokit.rest.git.createCommit({
        ...base,
        message,
        tree: tree.data.sha,
        parents: [],
      });
      try {
        await octokit.rest.git.createRef({
          ...base,
          ref: `refs/heads/${branch}`,
          sha: commit.data.sha,
        });
      } catch (e) {
        // Another runner created the branch first; that is success for us.
        const msg = e instanceof Error ? e.message : "";
        if (statusOf(e) === 422 && msg.includes("Reference already exists")) return;
        throw e;
      }
    },
  };
}
