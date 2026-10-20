import { describe, expect, it } from "vitest";
import { createOctokitPort } from "../src/github/octokit";
import { BranchNotFoundError, ConflictError, TooManyFilesError } from "../src/github/port";

type Route = { method: string; path: RegExp; status: number; body: unknown };

// Response objects built by hand have an empty url; Octokit pagination reads response.url.
function withUrl(res: Response, url: URL): Response {
  Object.defineProperty(res, "url", { value: url.href });
  return res;
}

function fakeFetch(routes: Route[], calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push(`${method} ${url.pathname}${url.search}`);
    const route = routes.find(
      (r) => r.method === method && r.path.test(decodeURIComponent(url.pathname)),
    );
    if (!route) return new Response(JSON.stringify({ message: "no route" }), { status: 500 });
    return withUrl(
      new Response(route.status === 204 ? null : JSON.stringify(route.body), {
        status: route.status,
        headers: { "content-type": "application/json" },
      }),
      url,
    );
  }) as typeof fetch;
}

const port = (routes: Route[], calls?: string[]) =>
  createOctokitPort({ token: "t", owner: "o", repo: "r", fetch: fakeFetch(routes, calls) });

describe("createOctokitPort", () => {
  it("maps collaborator permission using role_name first", async () => {
    const gh = port([
      {
        method: "GET",
        path: /collaborators\/alice\/permission$/,
        status: 200,
        body: { permission: "write", role_name: "maintain" },
      },
      {
        method: "GET",
        path: /collaborators\/bob\/permission$/,
        status: 404,
        body: { message: "Not Found" },
      },
      {
        method: "GET",
        path: /collaborators\/carol\/permission$/,
        status: 200,
        body: { permission: "write", role_name: "custom-role" },
      },
    ]);
    expect(await gh.getPermission("alice")).toBe("maintain");
    expect(await gh.getPermission("bob")).toBe("none");
    expect(await gh.getPermission("carol")).toBe("write");
  });

  it("reads a file from a branch, returning null for 404", async () => {
    const gh = port([
      {
        method: "GET",
        path: /contents\/runs\/2026-10\.jsonl$/,
        status: 200,
        body: { type: "file", sha: "s1", content: Buffer.from("a\n").toString("base64") },
      },
      {
        method: "GET",
        path: /contents\/runs\/2026-09\.jsonl$/,
        status: 404,
        body: { message: "Not Found" },
      },
    ]);
    expect(await gh.readFile("factory-data", "runs/2026-10.jsonl")).toEqual({
      content: "a\n",
      sha: "s1",
    });
    expect(await gh.readFile("factory-data", "runs/2026-09.jsonl")).toBeNull();
  });

  it("turns a 409 on write into ConflictError", async () => {
    const gh = port([
      { method: "PUT", path: /contents\/runs/, status: 409, body: { message: "sha mismatch" } },
    ]);
    await expect(
      gh.writeFile("factory-data", "runs/x.jsonl", "x", "old", "m"),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("keeps only the newest check run per name", async () => {
    const gh = port([
      {
        method: "GET",
        path: /commits\/abc\/check-runs$/,
        status: 200,
        body: {
          total_count: 3,
          check_runs: [
            { id: 1, name: "unit", status: "completed", conclusion: "failure" },
            { id: 5, name: "unit", status: "completed", conclusion: "success" },
            { id: 2, name: "e2e", status: "in_progress", conclusion: null },
          ],
        },
      },
    ]);
    expect(await gh.listCheckRuns("abc")).toEqual([
      { name: "unit", status: "completed", conclusion: "success" },
      { name: "e2e", status: "in_progress", conclusion: null },
    ]);
  });

  it("returns false when the merge is refused", async () => {
    const gh = port([
      { method: "PUT", path: /pulls\/7\/merge$/, status: 405, body: { message: "not mergeable" } },
    ]);
    expect(await gh.mergePull(7, { sha: "s", title: "t", message: "m" })).toBe(false);
  });

  it("marks a draft PR ready through GraphQL, and skips a PR that is already ready", async () => {
    const calls: string[] = [];
    const gh = port(
      [
        {
          method: "GET",
          path: /pulls\/7$/,
          status: 200,
          body: { number: 7, draft: true, node_id: "PR_node" },
        },
        {
          method: "GET",
          path: /pulls\/8$/,
          status: 200,
          body: { number: 8, draft: false, node_id: "PR_other" },
        },
        {
          method: "POST",
          path: /graphql$/,
          status: 200,
          body: { data: { markPullRequestReadyForReview: { pullRequest: { id: "PR_node" } } } },
        },
      ],
      calls,
    );
    await gh.markReady(7);
    await gh.markReady(8);
    expect(calls.filter((c) => c.startsWith("POST"))).toEqual(["POST /graphql"]);
  });

  describe("syncBoardStatus", () => {
    const spec = { title: "Software Factory", field: "Factory", options: ["new", "approved"] };
    const board = (id: string) => ({
      id,
      title: "Software Factory",
      url: "https://x/" + id,
      fields: {
        nodes: [
          {},
          {
            id: "F1",
            name: "Factory",
            options: [
              { id: "O_new", name: "new" },
              { id: "O_approved", name: "approved" },
            ],
          },
        ],
      },
    });
    const graphql = (reply: (q: string, v: Record<string, unknown>) => unknown, sent: string[]) =>
      (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables: Record<string, unknown>;
        };
        sent.push(body.query.trim().split(/[\s({]/)[0] + ":" + JSON.stringify(body.variables));
        return withUrl(
          new Response(JSON.stringify({ data: reply(body.query, body.variables) }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
          url,
        );
      }) as typeof fetch;

    it("returns ambiguous without mutating when two boards share the title", async () => {
      const sent: string[] = [];
      const gh = createOctokitPort({
        token: "t",
        owner: "o",
        repo: "r",
        fetch: graphql(
          () => ({
            organization: { id: "ORG", projectsV2: { nodes: [board("P1"), board("P2")] } },
          }),
          sent,
        ),
      });
      expect(await gh.syncBoardStatus(spec, 5, "approved")).toBe("ambiguous");
      expect(sent.every((s) => s.startsWith("query"))).toBe(true);
    });

    it("returns no-board when none matches", async () => {
      const gh = createOctokitPort({
        token: "t",
        owner: "o",
        repo: "r",
        fetch: graphql(() => ({ organization: { id: "ORG", projectsV2: { nodes: [] } } }), []),
      });
      expect(await gh.syncBoardStatus(spec, 5, "approved")).toBe("no-board");
    });

    it("adds the item then sets the single-select option by id", async () => {
      const sent: string[] = [];
      const gh = createOctokitPort({
        token: "t",
        owner: "o",
        repo: "r",
        fetch: graphql((q) => {
          if (q.includes("organization("))
            return { organization: { id: "ORG", projectsV2: { nodes: [board("P1")] } } };
          if (q.includes("repository(")) return { repository: { issue: { id: "ISSUE_5" } } };
          if (q.includes("addProjectV2ItemById"))
            return { addProjectV2ItemById: { item: { id: "ITEM" } } };
          return { updateProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM" } } };
        }, sent),
      });
      expect(await gh.syncBoardStatus(spec, 5, "approved")).toBe("synced");
      const muts = sent.filter((s) => s.startsWith("mutation"));
      expect(muts).toHaveLength(2);
      expect(muts[0]).toContain('"projectId":"P1"');
      expect(muts[0]).toContain('"contentId":"ISSUE_5"');
      expect(muts[1]).toContain('"itemId":"ITEM"');
      expect(muts[1]).toContain('"optionId":"O_approved"');
    });

    it("sends every board GraphQL call with an abort signal and no request option in the variables", async () => {
      const sent: string[] = [];
      const signals: (AbortSignal | null | undefined)[] = [];
      const inner = graphql((q) => {
        if (q.includes("organization("))
          return { organization: { id: "ORG", projectsV2: { nodes: [board("P1")] } } };
        if (q.includes("repository(")) return { repository: { issue: { id: "ISSUE_5" } } };
        if (q.includes("addProjectV2ItemById"))
          return { addProjectV2ItemById: { item: { id: "ITEM" } } };
        return { updateProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM" } } };
      }, sent);
      const gh = createOctokitPort({
        token: "t",
        owner: "o",
        repo: "r",
        fetch: ((i: string | URL | Request, init?: RequestInit) => {
          signals.push(init?.signal);
          return inner(i, init);
        }) as typeof fetch,
      });
      expect(await gh.syncBoardStatus(spec, 5, "approved")).toBe("synced");
      expect(signals).toHaveLength(4);
      for (const sig of signals) expect(sig).toBeInstanceOf(AbortSignal);
      expect(sent.join("\n")).not.toContain("request");
    });
  });

  describe("ensureBoard", () => {
    const spec = { title: "Software Factory", field: "Factory", options: ["new", "approved"] };
    const withField = {
      id: "P1",
      title: "Software Factory",
      url: "https://x/P1",
      fields: {
        nodes: [
          {
            id: "F1",
            name: "Factory",
            options: [
              { id: "a", name: "new" },
              { id: "b", name: "approved" },
            ],
          },
        ],
      },
    };
    // Routes REST (repos.get) and GraphQL separately; GraphQL replies come from `reply`.
    const mk = (
      reply: (q: string) => unknown,
      sent: { q: string; v: Record<string, unknown> }[],
      failOn?: string,
    ) =>
      (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        const json = (status: number, body: unknown) =>
          withUrl(
            new Response(JSON.stringify(body), {
              status,
              headers: { "content-type": "application/json" },
            }),
            url,
          );
        if (!url.pathname.endsWith("/graphql")) return json(200, { node_id: "REPO_NODE" });
        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables: Record<string, unknown>;
        };
        sent.push({ q: body.query, v: body.variables });
        if (failOn && body.query.includes(failOn))
          return json(200, { errors: [{ message: "denied" }] });
        return json(200, { data: reply(body.query) });
      }) as typeof fetch;
    const reply = (nodes: unknown[]) => (q: string) => {
      if (q.includes("organization("))
        return { organization: { id: "ORG", projectsV2: { nodes } } };
      if (q.includes("createProjectV2("))
        return { createProjectV2: { projectV2: { id: "NEW", url: "https://x/NEW" } } };
      return {};
    };
    const names = (sent: { q: string }[]) =>
      sent.map(
        (s) =>
          /(createProjectV2Field|createProjectV2|updateProjectV2|organization)\b/.exec(s.q)?.[1],
      );

    it("creates the board, field, then makes it public when absent", async () => {
      const sent: { q: string; v: Record<string, unknown> }[] = [];
      const gh = createOctokitPort({
        token: "t",
        owner: "o",
        repo: "r",
        fetch: mk(reply([]), sent),
      });
      expect(await gh.ensureBoard(spec)).toEqual({ created: true, url: "https://x/NEW" });
      expect(names(sent)).toEqual([
        "organization",
        "createProjectV2",
        "createProjectV2Field",
        "updateProjectV2",
      ]);
      expect(sent[1]!.v).toEqual({
        ownerId: "ORG",
        title: "Software Factory",
        repositoryId: "REPO_NODE",
      });
      expect(sent[2]!.v).toEqual({
        input: {
          projectId: "NEW",
          dataType: "SINGLE_SELECT",
          name: "Factory",
          singleSelectOptions: [
            { name: "new", color: "GRAY", description: "" },
            { name: "approved", color: "GRAY", description: "" },
          ],
        },
      });
      expect(sent[3]!.v).toEqual({ projectId: "NEW" });
      expect(sent[3]!.q).toContain("public: true");
    });

    it("still reports created when making the board public fails", async () => {
      const sent: { q: string; v: Record<string, unknown> }[] = [];
      const gh = createOctokitPort({
        token: "t",
        owner: "o",
        repo: "r",
        fetch: mk(reply([]), sent, "updateProjectV2("),
      });
      expect(await gh.ensureBoard(spec)).toEqual({ created: true, url: "https://x/NEW" });
      expect(names(sent).at(-1)).toBe("updateProjectV2");
    });

    it("sends no mutation when the board and field already exist", async () => {
      const sent: { q: string; v: Record<string, unknown> }[] = [];
      const gh = createOctokitPort({
        token: "t",
        owner: "o",
        repo: "r",
        fetch: mk(reply([withField]), sent),
      });
      expect(await gh.ensureBoard(spec)).toEqual({ created: false, url: "https://x/P1" });
      expect(sent.some((s) => s.q.trim().startsWith("mutation"))).toBe(false);
    });

    it("creates only the missing field when the board exists without it", async () => {
      const sent: { q: string; v: Record<string, unknown> }[] = [];
      const bare = { ...withField, fields: { nodes: [{}] } };
      const gh = createOctokitPort({
        token: "t",
        owner: "o",
        repo: "r",
        fetch: mk(reply([bare]), sent),
      });
      expect(await gh.ensureBoard(spec)).toEqual({ created: false, url: "https://x/P1" });
      expect(names(sent)).toEqual(["organization", "createProjectV2Field"]);
      expect((sent[1]!.v.input as { projectId: string }).projectId).toBe("P1");
    });

    it("syncBoardStatus throws when the field is missing", async () => {
      const bare = { ...withField, fields: { nodes: [{}] } };
      const gh = createOctokitPort({
        token: "t",
        owner: "o",
        repo: "r",
        fetch: mk(reply([bare]), []),
      });
      await expect(gh.syncBoardStatus(spec, 5, "approved")).rejects.toThrow(/보드 필드 없음/);
    });
  });

  it("dispatches workflows on main", async () => {
    const calls: string[] = [];
    const gh = port([{ method: "POST", path: /dispatches$/, status: 204, body: null }], calls);
    await gh.dispatchWorkflow("factory-fix.yml", { pr: "3" });
    expect(calls[0]).toBe("POST /repos/o/r/actions/workflows/factory-fix.yml/dispatches");
  });
});

describe("createOctokitPort listPullFiles", () => {
  it("fills additions from the patch and previousFilename from previous_filename", async () => {
    const gh = port([
      { method: "GET", path: /pulls\/4$/, status: 200, body: { changed_files: 2 } },
      {
        method: "GET",
        path: /pulls\/4\/files$/,
        status: 200,
        body: [
          {
            filename: "a.ts",
            status: "modified",
            patch: "@@ -1 +1,2 @@\n ctx\n+added one\n-gone\n+added two",
          },
          { filename: "new.ts", previous_filename: "old.ts", status: "renamed" },
        ],
      },
    ]);
    expect(await gh.listPullFiles(4)).toEqual([
      { filename: "a.ts", additions: ["added one", "added two"], deletions: ["gone"] },
      {
        filename: "new.ts",
        previousFilename: "old.ts",
        additions: [],
        deletions: [],
        patchMissing: true,
      },
    ]);
  });

  it("marks files GitHub reports as removed", async () => {
    const gh = port([
      { method: "GET", path: /pulls\/5$/, status: 200, body: { changed_files: 1 } },
      {
        method: "GET",
        path: /pulls\/5\/files$/,
        status: 200,
        body: [
          { filename: "a.test.ts", status: "removed", additions: 0, patch: "@@ -1 +0,0 @@\n-x" },
        ],
      },
    ]);
    expect(await gh.listPullFiles(5)).toEqual([
      { filename: "a.test.ts", additions: [], deletions: ["x"], additionCount: 0, removed: true },
    ]);
  });
});

describe("createOctokitPort reopenIssue and editComment", () => {
  it("reopens an issue with PATCH state open", async () => {
    const calls: string[] = [];
    const gh = port([{ method: "PATCH", path: /issues\/7$/, status: 200, body: {} }], calls);
    await gh.reopenIssue(7);
    expect(calls).toEqual(["PATCH /repos/o/r/issues/7"]);
  });

  it("edits a comment by id", async () => {
    const calls: string[] = [];
    const gh = port(
      [{ method: "PATCH", path: /issues\/comments\/55$/, status: 200, body: {} }],
      calls,
    );
    await gh.editComment(55, "new body");
    expect(calls).toEqual(["PATCH /repos/o/r/issues/comments/55"]);
  });
});

describe("createOctokitPort pagination and caps", () => {
  const link = (path: string, page: number) => ({
    link: `<https://api.github.com${path}?per_page=100&page=${page}>; rel="next"`,
  });

  function pagedFetch(
    pages: Record<string, { body: unknown; headers?: Record<string, string> }>,
  ): typeof fetch {
    return (async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      const key = `${url.pathname}?page=${url.searchParams.get("page") ?? "1"}`;
      const p = pages[key];
      if (!p) return new Response(JSON.stringify({ message: `no route ${key}` }), { status: 500 });
      return withUrl(
        new Response(JSON.stringify(p.body), {
          status: 200,
          headers: { "content-type": "application/json", ...(p.headers ?? {}) },
        }),
        url,
      );
    }) as typeof fetch;
  }
  const mk = (pages: Parameters<typeof pagedFetch>[0]) =>
    createOctokitPort({ token: "t", owner: "o", repo: "r", fetch: pagedFetch(pages) });

  it("follows Link headers for listClosedIssuesWithLabel and drops pull requests", async () => {
    const issue = (number: number, pr = false) => ({
      number,
      title: "t",
      body: null,
      user: { login: "bot" },
      labels: [{ name: "source:error" }],
      state: "closed",
      ...(pr ? { pull_request: {} } : {}),
    });
    const gh = mk({
      "/repos/o/r/issues?page=1": {
        body: [issue(1), issue(2, true)],
        headers: link("/repos/o/r/issues", 2),
      },
      "/repos/o/r/issues?page=2": { body: [issue(3)] },
    });
    expect((await gh.listClosedIssuesWithLabel("source:error")).map((i) => i.number)).toEqual([
      1, 3,
    ]);
  });

  it("lists closed issues newest first and stops after 5 pages", async () => {
    const urls: string[] = [];
    const inner = pagedFetch(
      Object.fromEntries(
        [1, 2, 3, 4, 5, 6, 7].map((p) => [
          `/repos/o/r/issues?page=${p}`,
          {
            body: [
              {
                number: p,
                title: "t",
                body: null,
                user: { login: "bot" },
                labels: [{ name: "source:error" }],
                state: "closed",
              },
            ],
            headers: link("/repos/o/r/issues", p + 1),
          },
        ]),
      ),
    );
    const spy = ((input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input instanceof Request ? input.url : input));
      return inner(input, init);
    }) as typeof fetch;
    const gh = createOctokitPort({ token: "t", owner: "o", repo: "r", fetch: spy });
    expect((await gh.listClosedIssuesWithLabel("source:error")).map((i) => i.number)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(urls).toHaveLength(5);
    expect(urls[0]).toContain("sort=created");
    expect(urls[0]).toContain("direction=desc");
  });

  it("follows Link headers for listPullFiles", async () => {
    const gh = mk({
      "/repos/o/r/pulls/9?page=1": { body: { changed_files: 2 } },
      "/repos/o/r/pulls/9/files?page=1": {
        body: [{ filename: "a.ts", additions: 1, patch: "@@ -0,0 +1 @@\n+x" }],
        headers: link("/repos/o/r/pulls/9/files", 2),
      },
      "/repos/o/r/pulls/9/files?page=2": { body: [{ filename: "b.ts" }] },
    });
    expect(await gh.listPullFiles(9)).toEqual([
      { filename: "a.ts", additions: ["x"], deletions: [], additionCount: 1 },
      { filename: "b.ts", additions: [], deletions: [], patchMissing: true },
    ]);
  });

  it("follows Link headers for listCheckRuns and keeps the newest per name", async () => {
    const gh = mk({
      "/repos/o/r/commits/abc/check-runs?page=1": {
        body: {
          total_count: 3,
          check_runs: [{ id: 1, name: "unit", status: "completed", conclusion: "failure" }],
        },
        headers: link("/repos/o/r/commits/abc/check-runs", 2),
      },
      "/repos/o/r/commits/abc/check-runs?page=2": {
        body: {
          total_count: 3,
          check_runs: [
            { id: 9, name: "unit", status: "completed", conclusion: "success" },
            { id: 3, name: "e2e", status: "completed", conclusion: "success" },
          ],
        },
      },
    });
    expect(await gh.listCheckRuns("abc")).toEqual([
      { name: "unit", status: "completed", conclusion: "success" },
      { name: "e2e", status: "completed", conclusion: "success" },
    ]);
  });

  it("fails closed at the 3000-file cap", async () => {
    const gh = mk({ "/repos/o/r/pulls/9?page=1": { body: { changed_files: 3000 } } });
    await expect(gh.listPullFiles(9)).rejects.toBeInstanceOf(TooManyFilesError);
  });

  it("fails closed when fewer files are returned than changed_files", async () => {
    const gh = mk({
      "/repos/o/r/pulls/9?page=1": { body: { changed_files: 5 } },
      "/repos/o/r/pulls/9/files?page=1": { body: [{ filename: "a.ts" }] },
    });
    await expect(gh.listPullFiles(9)).rejects.toBeInstanceOf(TooManyFilesError);
  });

  it("maps a missing patch (binary or large diff) to empty additions with patchMissing", async () => {
    const gh = mk({
      "/repos/o/r/pulls/9?page=1": { body: { changed_files: 1 } },
      "/repos/o/r/pulls/9/files?page=1": { body: [{ filename: "img.png" }] },
    });
    expect(await gh.listPullFiles(9)).toEqual([
      { filename: "img.png", additions: [], deletions: [], patchMissing: true },
    ]);
  });

  it("treats 422 as a conflict only for sha problems, and 404 branch as BranchNotFoundError", async () => {
    const other = port([
      { method: "PUT", path: /contents/, status: 422, body: { message: "Invalid request" } },
    ]);
    await expect(other.writeFile("b", "p", "x", null, "m")).rejects.not.toBeInstanceOf(
      ConflictError,
    );
    const sha = port([
      { method: "PUT", path: /contents/, status: 422, body: { message: "sha wasn't supplied" } },
    ]);
    await expect(sha.writeFile("b", "p", "x", null, "m")).rejects.toBeInstanceOf(ConflictError);
    const nb = port([
      { method: "PUT", path: /contents/, status: 404, body: { message: "Branch b not found" } },
    ]);
    await expect(nb.writeFile("b", "p", "x", null, "m")).rejects.toBeInstanceOf(
      BranchNotFoundError,
    );
  });

  it("throws when file content is empty but size is positive", async () => {
    const gh = port([
      {
        method: "GET",
        path: /contents\/big$/,
        status: 200,
        body: { type: "file", sha: "s", size: 2_000_000, content: "" },
      },
    ]);
    await expect(gh.readFile("b", "big")).rejects.toThrow(/too large/);
  });
});

describe("createOctokitPort createOrphanBranch", () => {
  const routes = (refStatus: number, refMessage: string): Route[] => [
    {
      method: "GET",
      path: /branches\/factory-data$/,
      status: 404,
      body: { message: "Branch not found" },
    },
    { method: "POST", path: /git\/trees$/, status: 201, body: { sha: "tree1" } },
    { method: "POST", path: /git\/commits$/, status: 201, body: { sha: "commit1" } },
    { method: "POST", path: /git\/refs$/, status: refStatus, body: { message: refMessage } },
  ];

  it("treats 'Reference already exists' as success", async () => {
    const gh = port(routes(422, "Reference already exists"));
    await expect(
      gh.createOrphanBranch("factory-data", { a: "b" }, "init"),
    ).resolves.toBeUndefined();
  });

  it("rethrows other createRef failures", async () => {
    const gh = port(routes(422, "Object does not exist"));
    await expect(gh.createOrphanBranch("factory-data", { a: "b" }, "init")).rejects.toThrow();
  });
});

describe("history listing", () => {
  it("listCommits maps message and committer date", async () => {
    const calls: string[] = [];
    const gh = port(
      [
        {
          method: "GET",
          path: /\/repos\/o\/r\/commits$/,
          status: 200,
          body: [
            { sha: "s1", commit: { message: "m1", committer: { date: "2026-10-10T00:00:00Z" } } },
          ],
        },
      ],
      calls,
    );
    expect(await gh.listCommits(new Date("2026-10-01T00:00:00Z"))).toEqual([
      { sha: "s1", message: "m1", date: "2026-10-10T00:00:00Z" },
    ]);
    expect(calls[0]).toBe(
      "GET /repos/o/r/commits?sha=main&since=2026-10-01T00%3A00%3A00.000Z&per_page=100",
    );
  });

  it("listMergedPulls skips unmerged and old merges and stops paging", async () => {
    const calls: string[] = [];
    const pr = (number: number, merged_at: string | null, updated_at: string) => ({
      number,
      title: `t${number}`,
      body: null,
      user: { login: "u" },
      labels: [{ name: "x" }],
      merged_at,
      updated_at,
      merge_commit_sha: merged_at ? `m${number}` : null,
      head: { sha: `h${number}` },
    });
    const gh = port(
      [
        {
          method: "GET",
          path: /\/repos\/o\/r\/pulls$/,
          status: 200,
          body: [
            pr(3, "2026-10-11T00:00:00Z", "2026-10-11T00:00:00Z"),
            pr(2, null, "2026-10-05T00:00:00Z"),
            pr(1, "2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z"),
          ],
        },
      ],
      calls,
    );
    const out = await gh.listMergedPulls(new Date("2026-10-01T00:00:00Z"));
    expect(out).toEqual([
      {
        number: 3,
        title: "t3",
        body: "",
        author: "u",
        labels: ["x"],
        mergedAt: "2026-10-11T00:00:00Z",
        mergeSha: "m3",
        headSha: "h3",
      },
    ]);
    expect(calls).toEqual([
      "GET /repos/o/r/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100",
    ]);
  });
});

describe("listOpenPulls", () => {
  it("lists open pulls against main across pages", async () => {
    const calls: string[] = [];
    const gh = port(
      [
        {
          method: "GET",
          path: /\/repos\/o\/r\/pulls$/,
          status: 200,
          body: [
            {
              number: 5,
              title: "t",
              body: null,
              user: { login: "bot" },
              head: { ref: "h", sha: "s" },
              base: { ref: "main" },
              labels: [{ name: "factory:improve" }],
              draft: false,
              state: "open",
            },
          ],
        },
      ],
      calls,
    );
    const out = await gh.listOpenPulls();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      number: 5,
      author: "bot",
      labels: ["factory:improve"],
      body: "",
    });
    expect(calls[0]).toBe("GET /repos/o/r/pulls?state=open&base=main&per_page=100");
  });
});
