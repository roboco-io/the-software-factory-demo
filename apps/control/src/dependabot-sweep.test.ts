import { describe, expect, it, vi } from "vitest";
import {
  DEPENDABOT_LOGIN,
  DEPENDABOT_USER_ID,
  GITHUB_WEB_FLOW_ID,
  type DependabotPr,
  type OpenAlert,
  type PrCommit,
  type PrFile,
} from "./dependabot";
import {
  LABEL_NEEDS_HUMAN,
  runDependabotSweep,
  type SweepDeps,
} from "./dependabot-sweep";
import type { CheckRun } from "./decision";
import type { MergeResult } from "./pull-port";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-20T00:00:00Z");
const SHA = "a".repeat(40);
const POLICY = "requiredChecks:\n  - unit\nautoMergeTiers: [T0]\nrules: []\n";

const bot = { id: DEPENDABOT_USER_ID, login: DEPENDABOT_LOGIN, type: "Bot" };
const pr = (over: Partial<DependabotPr> = {}): DependabotPr => ({
  number: 143,
  title: "chore(deps): bump hono from 4.13.13 to 4.13.16",
  author: bot,
  draft: false,
  headSha: SHA,
  sameRepo: true,
  baseRef: "main",
  defaultBranch: "main",
  labels: [],
  ...over,
});
const passed: CheckRun[] = [
  { name: "unit", status: "completed", conclusion: "success", appId: 15368 },
];

const lockFile: PrFile = {
  path: "pnpm-lock.yaml",
  status: "modified",
  patch: "@@ -1 +1 @@\n-  hono@4.13.13:\n+  hono@4.13.16:",
};

function world(
  over: {
    prs?: DependabotPr[];
    /** The pull request as `getPr` returns it, when it differs from the list. */
    live?: Partial<DependabotPr & { open: boolean }>;
    /** What the second read, right before the merge, adds on top. */
    liveAtMerge?: Partial<DependabotPr & { open: boolean }>;
    alerts?: OpenAlert[] | null;
    commits?: PrCommit[];
    files?: PrFile[];
    checks?: CheckRun[];
    policy?: string | null;
    merge?: MergeResult;
    paused?: boolean;
    projects?: string[];
  } = {},
) {
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  const order: string[] = [];
  const prs = over.prs ?? [pr()];
  const reads = new Map<number, number>();
  const github = {
    listOpenPrs: vi.fn(async () => prs),
    getPr: vi.fn(async (_repo: string, number: number) => ({
      ...(prs.find((p) => p.number === number) ?? pr({ number })),
      open: true,
      ...over.live,
      ...((reads.get(number) ?? 0) > 0 ? over.liveAtMerge : {}),
      ...(reads.set(number, (reads.get(number) ?? 0) + 1) && {}),
    })),
    listFiles: vi.fn(async () => ({
      files: over.files ?? [lockFile],
      truncated: false,
    })),
    listCommits: vi.fn(
      async () =>
        over.commits ?? [
          {
            authorId: DEPENDABOT_USER_ID,
            committerId: GITHUB_WEB_FLOW_ID,
            verified: true,
            message: "chore(deps): bump hono from 4.13.13 to 4.13.16",
            committedAt: NOW - 4 * DAY,
          },
        ],
    ),
    listOpenAlerts: vi.fn(async () =>
      over.alerts === undefined
        ? [{ package: "hono", ecosystem: "npm", patched: "4.13.16" }]
        : over.alerts,
    ),
    addLabel: vi.fn<(r: string, n: number, l: string) => Promise<void>>(
      async () => {
        order.push("label");
      },
    ),
    comment: vi.fn<(r: string, n: number, b: string) => Promise<void>>(
      async () => {
        order.push("comment");
      },
    ),
  };
  const pulls = {
    readPolicy: vi.fn(async () =>
      over.policy === null
        ? ({ kind: "missing" } as const)
        : ({ kind: "ok", text: over.policy ?? POLICY } as const),
    ),
    listChecks: vi.fn(async () => over.checks ?? passed),
    merge: vi.fn<
      (
        r: string,
        n: number,
        sha: string,
        m: { title: string; body: string },
      ) => Promise<MergeResult>
    >(async () => over.merge ?? "merged"),
  };
  const deps: SweepDeps = {
    now: () => NOW,
    minAgeMs: 3 * DAY,
    projects: over.projects ?? ["acme/demo"],
    github,
    pulls,
    paused: async () => over.paused ?? false,
    log: (event, fields = {}) => logs.push({ event, fields }),
  };
  return { deps, github, pulls, logs, order };
}

describe("runDependabotSweep", () => {
  it("merges a qualifying pull request pinned to its head and leaves a comment", async () => {
    const w = world();
    const results = await runDependabotSweep(w.deps);
    expect(results).toEqual([{ repo: "acme/demo", pr: 143, action: "merged" }]);
    expect(w.pulls.merge).toHaveBeenCalledTimes(1);
    const [repo, number, sha, message] = w.pulls.merge.mock.calls[0]!;
    expect([repo, number, sha]).toEqual(["acme/demo", 143, SHA]);
    expect(message.title).toBe(
      "chore(deps): bump hono from 4.13.13 to 4.13.16 (#143)",
    );
    expect(w.github.comment).toHaveBeenCalledTimes(1);
    expect(w.github.addLabel).not.toHaveBeenCalled();
    expect(w.pulls.readPolicy).toHaveBeenCalledWith("acme/demo", "main");
  });

  it("labels and comments once when a person is needed, and does not merge", async () => {
    const w = world({ alerts: [] });
    expect(await runDependabotSweep(w.deps)).toEqual([
      {
        repo: "acme/demo",
        pr: 143,
        action: "needs_human",
        code: "not_security_update",
      },
    ]);
    expect(w.pulls.merge).not.toHaveBeenCalled();
    expect(w.github.addLabel).toHaveBeenCalledWith(
      "acme/demo",
      143,
      LABEL_NEEDS_HUMAN,
    );
    expect(w.github.comment.mock.calls[0]![2]).toContain("not_security_update");
    expect(w.order).toEqual(["comment", "label"]);
  });

  it("does not repeat the label and comment on the next day", async () => {
    const w = world({ alerts: [], prs: [pr({ labels: [LABEL_NEEDS_HUMAN] })] });
    const results = await runDependabotSweep(w.deps);
    expect(results[0]!.action).toBe("needs_human");
    expect(w.github.addLabel).not.toHaveBeenCalled();
    expect(w.github.comment).not.toHaveBeenCalled();
  });

  it("does not merge a pull request a person was already asked to look at", async () => {
    const w = world({ prs: [pr({ labels: [LABEL_NEEDS_HUMAN] })] });
    expect(await runDependabotSweep(w.deps)).toEqual([
      { repo: "acme/demo", pr: 143, action: "skipped", code: "held" },
    ]);
    expect(w.pulls.merge).not.toHaveBeenCalled();
  });

  it("waits without touching the pull request while checks run", async () => {
    const w = world({
      checks: [
        { name: "unit", status: "in_progress", conclusion: null, appId: 15368 },
      ],
    });
    expect(await runDependabotSweep(w.deps)).toEqual([
      { repo: "acme/demo", pr: 143, action: "wait", code: "checks_pending" },
    ]);
    expect(w.pulls.merge).not.toHaveBeenCalled();
    expect(w.github.comment).not.toHaveBeenCalled();
  });

  it("ignores a check run of the same name from another app", async () => {
    const w = world({
      checks: [
        { name: "unit", status: "completed", conclusion: "success", appId: 9 },
      ],
    });
    expect((await runDependabotSweep(w.deps))[0]!.action).toBe("wait");
  });

  it("ignores pull requests of other authors without reading them", async () => {
    const w = world({
      prs: [pr({ author: { id: 7, login: "someone", type: "User" } })],
    });
    expect(await runDependabotSweep(w.deps)).toEqual([]);
    expect(w.github.listOpenAlerts).not.toHaveBeenCalled();
    expect(w.github.getPr).not.toHaveBeenCalled();
  });

  it("skips the repository when the alerts cannot be read", async () => {
    const w = world({ alerts: null });
    expect(await runDependabotSweep(w.deps)).toEqual([]);
    expect(w.logs.map((l) => l.event)).toContain(
      "dependabot_alerts_unavailable",
    );
    expect(w.pulls.merge).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", null],
    ["invalid", "nonsense: true\n"],
  ])("skips the repository when its policy is %s", async (_name, policy) => {
    const w = world({ policy });
    expect(await runDependabotSweep(w.deps)).toEqual([]);
    expect(w.logs.map((l) => l.event)).toContain("dependabot_policy_invalid");
    expect(w.pulls.merge).not.toHaveBeenCalled();
  });

  it("merges the head it judged, not the head the list gave", async () => {
    const w = world({ live: { headSha: "b".repeat(40) } });
    await runDependabotSweep(w.deps);
    expect(w.pulls.listChecks).toHaveBeenCalledWith(
      "acme/demo",
      "b".repeat(40),
    );
    expect(w.pulls.merge.mock.calls[0]![2]).toBe("b".repeat(40));
  });

  it("judges the title as it is now, not as the list gave it", async () => {
    const w = world({ live: { title: "bump the npm group with 3 updates" } });
    expect((await runDependabotSweep(w.deps))[0]).toMatchObject({
      action: "needs_human",
      code: "not_single_update",
    });
    expect(w.pulls.merge).not.toHaveBeenCalled();
  });

  it("does not merge after the base branch was changed", async () => {
    const w = world({ live: { baseRef: "release" } });
    expect((await runDependabotSweep(w.deps))[0]!.action).toBe("skipped");
    expect(w.pulls.merge).not.toHaveBeenCalled();
  });

  it("respects a hold label added after the list was read", async () => {
    const w = world({ live: { labels: [LABEL_NEEDS_HUMAN] } });
    expect((await runDependabotSweep(w.deps))[0]).toMatchObject({
      action: "skipped",
      code: "held",
    });
    expect(w.pulls.merge).not.toHaveBeenCalled();
  });

  it("skips a pull request that was closed in the meantime", async () => {
    const w = world({ live: { open: false } });
    expect(await runDependabotSweep(w.deps)).toEqual([
      { repo: "acme/demo", pr: 143, action: "skipped", code: "closed" },
    ]);
    expect(w.pulls.merge).not.toHaveBeenCalled();
  });

  it("does not merge when the factory was stopped during the pass", async () => {
    const w = world({ paused: true });
    expect(await runDependabotSweep(w.deps)).toEqual([
      { repo: "acme/demo", pr: 143, action: "skipped", code: "factory_paused" },
    ]);
    expect(w.pulls.merge).not.toHaveBeenCalled();
  });

  it("does not merge a commit that GitHub did not sign", async () => {
    const w = world({
      commits: [
        {
          authorId: DEPENDABOT_USER_ID,
          committerId: 3435720,
          verified: false,
          message: "chore(deps): bump hono from 4.13.13 to 4.13.16",
          committedAt: NOW - 4 * DAY,
        },
      ],
    });
    expect((await runDependabotSweep(w.deps))[0]).toMatchObject({
      action: "needs_human",
      code: "foreign_commit",
    });
    expect(w.pulls.merge).not.toHaveBeenCalled();
  });

  it("respects a hold label added right before the merge", async () => {
    const w = world({ liveAtMerge: { labels: [LABEL_NEEDS_HUMAN] } });
    expect(await runDependabotSweep(w.deps)).toEqual([
      { repo: "acme/demo", pr: 143, action: "skipped", code: "held" },
    ]);
    expect(w.pulls.merge).not.toHaveBeenCalled();
  });

  it("does not merge when the head moved right before the merge", async () => {
    const w = world({ liveAtMerge: { headSha: "c".repeat(40) } });
    expect(await runDependabotSweep(w.deps)).toEqual([
      { repo: "acme/demo", pr: 143, action: "skipped", code: "head_moved" },
    ]);
    expect(w.pulls.merge).not.toHaveBeenCalled();
  });

  it("builds the commit title from the parsed update", async () => {
    const w = world({ live: { title: "Bump hono from 4.13.13 to 4.13.16" } });
    await runDependabotSweep(w.deps);
    expect(w.pulls.merge.mock.calls[0]![3].title).toBe(
      "chore(deps): bump hono from 4.13.13 to 4.13.16 (#143)",
    );
  });

  it("reports a refused merge and leaves no comment", async () => {
    const w = world({ merge: "refused" });
    expect(await runDependabotSweep(w.deps)).toEqual([
      { repo: "acme/demo", pr: 143, action: "skipped", code: "merge_refused" },
    ]);
    expect(w.github.comment).not.toHaveBeenCalled();
  });

  it("keeps going after one pull request fails", async () => {
    const w = world({ prs: [pr({ number: 1 }), pr({ number: 2 })] });
    w.github.listCommits.mockRejectedValueOnce(new Error("boom"));
    expect(await runDependabotSweep(w.deps)).toEqual([
      { repo: "acme/demo", pr: 1, action: "skipped", code: "failed" },
      { repo: "acme/demo", pr: 2, action: "merged" },
    ]);
  });

  it("keeps going after one repository fails", async () => {
    const w = world({ projects: ["acme/broken", "acme/demo"] });
    w.github.listOpenPrs.mockRejectedValueOnce(new Error("boom"));
    expect(await runDependabotSweep(w.deps)).toEqual([
      { repo: "acme/demo", pr: 143, action: "merged" },
    ]);
    expect(w.logs.map((l) => l.event)).toContain("dependabot_repo_failed");
  });

  it("still counts the merge when the comment after it fails", async () => {
    const w = world();
    w.github.comment.mockRejectedValueOnce(new Error("boom"));
    expect((await runDependabotSweep(w.deps))[0]!.action).toBe("merged");
  });

  it("logs one line for each judged pull request", async () => {
    const w = world({ merge: "refused" });
    await runDependabotSweep(w.deps);
    expect(w.logs.find((l) => l.event === "dependabot_pr")).toEqual({
      event: "dependabot_pr",
      fields: {
        repo: "acme/demo",
        pr: 143,
        action: "skipped",
        code: "merge_refused",
      },
    });
  });

  it("logs one summary line", async () => {
    const w = world();
    await runDependabotSweep(w.deps);
    expect(w.logs.at(-1)).toEqual({
      event: "dependabot_sweep",
      fields: { repos: 1, merged: 1, needs_human: 0, wait: 0, skipped: 0 },
    });
  });
});
