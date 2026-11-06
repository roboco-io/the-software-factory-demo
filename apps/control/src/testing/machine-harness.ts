import { vi } from "vitest";
import { ActiveRunConflict, type RunRepo } from "../d1-repo";
import {
  RunMachine,
  type PublishInput,
  type ReviewSandboxPort,
  type SandboxPort,
} from "../run-machine";
import type { ReasonCode, RunInput, RunState } from "../run-types";
import type { TaskStatus } from "../sandbox-core";
import { createWorld, pullsFor, type PullsWorld } from "./pulls-world";

export const HEAD = "a".repeat(40);
export const OPERATOR = "3435720";

export const input: RunInput = {
  repo: "acme/demo",
  issueNumber: 7,
  title: "Add footer",
  body: "Please add it.",
  deliveryId: "delivery-1",
};

export const goodReport = {
  truncated: false,
  entries: [
    {
      pathB64: btoa("src/footer.ts"),
      status: "added",
      type: "file",
      mode: 0o100644,
      size: 2,
      contentB64: btoa("hi"),
    },
  ],
};

export const APPROVE = JSON.stringify({
  verdict: "approve",
  summary: "Matches the issue.",
  findings: [],
});
export const CHANGES = JSON.stringify({
  verdict: "changes_requested",
  summary: "Missing test.",
  findings: [{ file: "src/footer.ts", severity: "medium", message: "no test" }],
});

export interface World {
  now: number;
  alarm: number | null;
  store: Map<string, unknown>;
  events: {
    kind: string;
    from: RunState | null;
    to: RunState | null;
    code: ReasonCode | null;
  }[];
  states: RunState[];
  prNumbers: number[];
  destroyed: number;
  reviewDestroyed: number;
  sandboxCalls: string[];
  reviewCalls: string[];
  reviewIds: string[];
  prompts: string[];
  reviewPrompts: string[];
  dbActive: { id: string; createdAt: number } | null;
}

export interface BuildOptions {
  task?: () => TaskStatus;
  report?: () => unknown;
  clone?: () => { ok: boolean; baseSha?: string };
  publish?: (i: PublishInput) => Promise<{
    prNumber: number;
    prUrl: string;
    headSha?: string;
  }>;
  destroy?: () => Promise<void>;
  activeRuns?: number;
  failPutOnce?: boolean;
  /** The reviewer's final message. undefined means no usable message. */
  reviewText?: () => string | undefined;
  reviewTask?: () => TaskStatus;
  reviewClone?: () => { ok: boolean };
  reviewDestroy?: () => Promise<void>;
  /** Changes to the pull request world (files, policy, checks, reviews, ...). */
  pulls?: Partial<PullsWorld>;
  operatorIds?: string[];
  /** Use this repository (for example a real D1 one) instead of the in-memory fake. */
  repo?: RunRepo;
  /** Prefix for run ids, when several machines share one repository. */
  idPrefix?: string;
}

// Producer fakes. The seam check swaps real sandbox, publisher and GitHub client behind these ports.
export function build(over: BuildOptions = {}) {
  const w: World = {
    now: 1_000_000,
    alarm: null,
    store: new Map(),
    events: [],
    states: [],
    prNumbers: [],
    destroyed: 0,
    reviewDestroyed: 0,
    sandboxCalls: [],
    reviewCalls: [],
    reviewIds: [],
    prompts: [],
    reviewPrompts: [],
    dbActive: null,
  };
  const pullsWorld = createWorld(over.pulls);
  const repo: RunRepo = {
    async createRun(r, max) {
      if (w.dbActive !== null) throw new ActiveRunConflict();
      if ((over.activeRuns ?? 0) >= max) return "capacity_full";
      w.dbActive = { id: r.id, createdAt: r.ts };
      w.events.push({ kind: "created", from: null, to: "queued", code: null });
      w.states.push("queued");
      return "created";
    },
    async findActiveRun() {
      return w.dbActive === null ? null : { ...w.dbActive, state: "queued" };
    },
    async transition(t) {
      w.events.push({
        kind: "transition",
        from: t.from,
        to: t.to,
        code: t.code,
      });
      w.states.push(t.to);
      if (t.to === "failed" || t.to === "merged" || t.to === "needs_human")
        w.dbActive = null;
      if (t.prNumber !== undefined) w.prNumbers.push(t.prNumber);
    },
    async recordCleanup(e) {
      w.events.push({ kind: "cleanup", from: null, to: null, code: e.code });
    },
  };
  const sandbox: SandboxPort = {
    async start() {
      w.sandboxCalls.push("start");
    },
    async clone() {
      w.sandboxCalls.push("clone");
      return over.clone ? over.clone() : { ok: true, baseSha: "a".repeat(40) };
    },
    async startAgent(i) {
      w.sandboxCalls.push("startAgent");
      w.prompts.push(i.prompt);
      return "started";
    },
    async taskStatus() {
      return over.task ? over.task() : { state: "finished", exitCode: 0 };
    },
    async collectChanges() {
      w.sandboxCalls.push("collect");
      return over.report ? over.report() : goodReport;
    },
    async destroy() {
      if (over.destroy) await over.destroy();
      w.destroyed += 1;
    },
  };
  const reviewSandbox = (id: string): ReviewSandboxPort => {
    w.reviewIds.push(id);
    return {
      async start() {
        w.reviewCalls.push("start");
      },
      async cloneAt(_repo, sha) {
        w.reviewCalls.push(`cloneAt:${sha}`);
        return over.reviewClone ? over.reviewClone() : { ok: true };
      },
      async startReview(i) {
        w.reviewCalls.push("startReview");
        w.reviewPrompts.push(i.prompt);
        return "started";
      },
      async taskStatus() {
        return over.reviewTask
          ? over.reviewTask()
          : { state: "finished", exitCode: 0 };
      },
      async readReviewText() {
        return over.reviewText ? over.reviewText() : APPROVE;
      },
      async destroy() {
        if (over.reviewDestroy) await over.reviewDestroy();
        w.reviewDestroyed += 1;
      },
    };
  };
  const publish = vi.fn(
    over.publish ??
      (async () => ({
        prNumber: pullsWorld.prNumber,
        prUrl: `https://github.com/acme/demo/pull/${pullsWorld.prNumber}`,
        headSha: pullsWorld.pr.headSha,
      })),
  );
  let ids = 0;
  const machine = new RunMachine({
    storage: {
      async get<T>(k: string) {
        return w.store.get(k) as T | undefined;
      },
      async put(k, v) {
        if (over.failPutOnce === true) {
          over.failPutOnce = false;
          throw new Error("storage interrupted");
        }
        w.store.set(k, structuredClone(v));
      },
      async getAlarm() {
        return w.alarm;
      },
      async setAlarm(at) {
        w.alarm = at;
      },
      async deleteAlarm() {
        w.alarm = null;
      },
    },
    repo: over.repo ?? repo,
    sandbox: () => sandbox,
    reviewSandbox,
    publisher: {
      publish: async (i) => {
        const r = await publish(i);
        return { ...r, headSha: r.headSha ?? pullsWorld.pr.headSha };
      },
    },
    pulls: pullsFor(pullsWorld),
    operatorIds: over.operatorIds ?? [OPERATOR],
    model: "claude-sonnet-5-5",
    reviewModel: "gpt-5.4-nano",
    now: () => w.now,
    newId: () => `${over.idPrefix ?? ""}run${++ids}`,
  });
  async function drain(max = 100) {
    for (let i = 0; i < max && w.alarm !== null; i++) {
      w.now = Math.max(w.now, w.alarm);
      w.alarm = null;
      await machine.alarm();
    }
  }
  /** Runs one alarm at the time it was set for. */
  async function tick() {
    if (w.alarm === null) return false;
    w.now = Math.max(w.now, w.alarm);
    w.alarm = null;
    await machine.alarm();
    return true;
  }
  const storedRun = () => w.store.get("run") as Record<string, unknown>;
  return { w, machine, publish, drain, tick, pulls: pullsWorld, storedRun };
}
