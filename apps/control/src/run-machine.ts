import { ActiveRunConflict, type RunRepo } from "./d1-repo";
import { validateChanges, type ValidChange } from "./changes";
import { decideMerge } from "./decision";
import { errorKind, logDiagnostic } from "./diagnostics";
import { neutralizeMentions } from "./neutralize-mentions";
import {
  classifyPullRequest,
  parsePolicy,
  type Policy,
  type Tier,
} from "./policy";
import { buildPrompt } from "./prompt";
import {
  ChecksPermissionMissing,
  type PullRequestInfo,
  type PullRequestPort,
} from "./pull-port";
import { buildReviewPrompt } from "./review-prompt";
import { parseVerdict, renderReviewComment } from "./review-verdict";
import { POST_PR_STATES, assertTransition, isTerminal } from "./run-state";
import type { ReasonCode, RunInput, RunState } from "./run-types";
import type { TaskStatus } from "./sandbox-core";

/** Time limit of one agent phase: the implement phase (queued to publishing) and the review phase (pr_opened and reviewing), each on its own. */
export const RUN_TIMEOUT_MS = 20 * 60 * 1000;
export const REVIEW_TIMEOUT_MS = 20 * 60 * 1000;
/** How long required checks may stay pending or absent before a person is asked. */
export const CHECKS_TIMEOUT_MS = 30 * 60 * 1000;
export const CHECKS_POLL_MS = 30 * 1000;
/** A person may take days to approve. The poll interval doubles up to the maximum. */
export const APPROVAL_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
export const APPROVAL_POLL_MIN_MS = 60 * 1000;
export const APPROVAL_POLL_MAX_MS = 15 * 60 * 1000;
export const POLL_MS = 15 * 1000;
export const RETRY_MS = 30 * 1000;
export const MAX_STEP_ATTEMPTS = 3;
/** Consecutive errors tolerated while waiting for approval (pauses grow from 30 s to 15 min). */
export const MAX_WAIT_ATTEMPTS = 12;
export const MAX_CLEANUP_ATTEMPTS = 5;
export const MAX_ACTIVE_RUNS = 2;
/** How long a freshly started agent may show no pid file before the run counts as lost. */
export const START_GRACE_MS = 60 * 1000;

export interface RunStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  setAlarm(at: number): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
}

export interface SandboxPort {
  start(repo: string, model: string): Promise<void>;
  clone(repo: string): Promise<{ ok: boolean; baseSha?: string }>;
  startAgent(input: {
    prompt: string;
    model: string;
  }): Promise<"started" | "busy">;
  taskStatus(): Promise<TaskStatus>;
  collectChanges(baseSha: string): Promise<unknown>;
  destroy(): Promise<void>;
}

/** The review sandbox: a fresh container (another sandbox id) that runs the reviewing engine read-only. */
export interface ReviewSandboxPort {
  start(repo: string, model: string): Promise<void>;
  /** Checks out exactly `sha`. */
  cloneAt(repo: string, sha: string): Promise<{ ok: boolean }>;
  startReview(input: {
    prompt: string;
    model: string;
  }): Promise<"started" | "busy">;
  taskStatus(): Promise<TaskStatus>;
  /** The text of the reviewer's final message, or undefined. */
  readReviewText(): Promise<string | undefined>;
  destroy(): Promise<void>;
}

/** Sandbox id of the review phase. It differs from the implement sandbox's id. */
export const reviewSandboxId = (runId: string) => `${runId}-review`;
const isReviewSandboxId = (id: string) => id.endsWith("-review");

export interface PublishInput {
  repo: string;
  issueNumber: number;
  runId: string;
  model: string;
  title: string;
  baseSha: string;
  changes: ValidChange[];
}

/** The publisher found something in the base tree that makes the change unsafe to publish. */
export class PublishRejected extends Error {
  constructor(readonly code: "symlink" | "submodule") {
    super(code);
    this.name = "PublishRejected";
  }
}

export interface PublisherPort {
  publish(
    input: PublishInput,
  ): Promise<{ prNumber: number; prUrl: string; headSha: string }>;
}

export interface MachineDeps {
  storage: RunStorage;
  repo: RunRepo;
  sandbox(runId: string): SandboxPort;
  reviewSandbox(sandboxId: string): ReviewSandboxPort;
  publisher: PublisherPort;
  pulls: PullRequestPort;
  /** Numeric GitHub user IDs whose approval counts. */
  operatorIds: readonly string[];
  model: string;
  reviewModel: string;
  now(): number;
  newId(): string;
}

export type StartResult =
  | { outcome: "started" | "duplicate" | "already_done"; runId: string }
  | { outcome: "capacity_full" };

interface StoredRun {
  id: string;
  repo: string;
  issueNumber: number;
  state: RunState;
  createdAt: number;
  deliveryId: string;
  title: string;
  body: string;
  baseSha?: string;
  agentStarted: boolean;
  agentStartedAt?: number;
  attempts: number;
  /** Sandbox ids that may still be running. */
  live: string[];
  /** Failed destroy attempts for the sandbox being released. */
  cleanupAttempts: number;
  /** Old runs stored this instead of `live`. */
  cleaned?: boolean;
  prNumber?: number;
  /** The pull request head the factory created. Every review, check and merge is pinned to it. */
  headSha?: string;
  /** Start of the review phase. */
  reviewPhaseStartedAt?: number;
  reviewStarted?: boolean;
  reviewTaskStartedAt?: number;
  commentPosted?: boolean;
  /** The head SHA the reviewer approved. */
  approvedSha?: string;
  checksStartedAt?: number;
  approvalStartedAt?: number;
  approvalPolls?: number;
  mergeAttempted?: boolean;
}

/** A failure with a fixed code that must not be retried. */
class StepFailure extends Error {
  constructor(readonly code: ReasonCode) {
    super(code);
  }
}

const KEY = "run";

/** The exit codes `timeout` uses when it stops a command. */
const isTimeoutExit = (code: number) => code === 124 || code === 137;

export class RunMachine {
  constructor(private readonly deps: MachineDeps) {}

  private async load(): Promise<StoredRun | undefined> {
    const run = await this.deps.storage.get<StoredRun>(KEY);
    if (run !== undefined && run.live === undefined) {
      // A run stored before stage 3: its implement sandbox is alive unless it was cleaned.
      run.live = run.cleaned === true ? [] : [run.id];
    }
    return run;
  }

  private save(run: StoredRun) {
    return this.deps.storage.put(KEY, run);
  }

  async start(input: RunInput): Promise<StartResult> {
    const existing = await this.load();
    if (existing !== undefined) {
      if (!isTerminal(existing.state)) {
        // Re-delivery after a crash between saving the run and setting the alarm.
        if ((await this.deps.storage.getAlarm()) === null) {
          await this.deps.storage.setAlarm(this.deps.now());
        }
        return { outcome: "duplicate", runId: existing.id };
      }
      if (existing.deliveryId === input.deliveryId) {
        return { outcome: "duplicate", runId: existing.id };
      }
      // The pull request exists and is merged or waits for a person: do not open a second one.
      if (existing.state === "merged" || existing.state === "needs_human")
        return { outcome: "already_done", runId: existing.id };
    }
    const now = this.deps.now();
    const run: StoredRun = {
      id: this.deps.newId(),
      repo: input.repo,
      issueNumber: input.issueNumber,
      state: "queued",
      createdAt: now,
      deliveryId: input.deliveryId,
      title: input.title,
      body: input.body,
      agentStarted: false,
      attempts: 0,
      live: [],
      cleanupAttempts: 0,
    };
    try {
      const created = await this.deps.repo.createRun(
        {
          id: run.id,
          repo: run.repo,
          issueNumber: run.issueNumber,
          ts: now,
        },
        MAX_ACTIVE_RUNS,
      );
      if (created === "capacity_full") return { outcome: "capacity_full" };
    } catch (error) {
      if (!(error instanceof ActiveRunConflict)) throw error;
      // An earlier attempt created the run in D1 but never saved it here: adopt it.
      const active = await this.deps.repo.findActiveRun(
        input.repo,
        input.issueNumber,
      );
      if (active === null) throw error;
      run.id = active.id;
      run.createdAt = active.createdAt;
      run.state = active.state;
    }
    await this.save(run);
    await this.deps.storage.setAlarm(now);
    return { outcome: "started", runId: run.id };
  }

  async alarm(): Promise<void> {
    const run = await this.load();
    if (run === undefined) return;
    if (isTerminal(run.state)) {
      await this.settleTerminal(run);
      return;
    }
    await this.releaseUnneeded(run);
    const now = this.deps.now();
    const limit = this.limitOf(run);
    if (now - limit.since > limit.ms) {
      await this.fail(run, limit.code);
      return;
    }
    try {
      await this.step(run);
      // A good step ends a run of transient errors: failures only count when they follow each other.
      if (run.attempts !== 0 && !isTerminal(run.state)) {
        run.attempts = 0;
        await this.save(run);
      }
    } catch (error) {
      if (error instanceof StepFailure) {
        await this.fail(run, error.code);
        return;
      }
      if (error instanceof ChecksPermissionMissing) {
        await this.fail(run, "checks_permission_missing");
        return;
      }
      run.attempts += 1;
      logDiagnostic("run_step_error", {
        runId: run.id,
        state: run.state,
        attempt: run.attempts,
        error: errorKind(error),
      });
      // The long approval wait tolerates more consecutive errors, with growing pauses.
      const waiting = run.state === "awaiting_approval";
      if (run.attempts >= (waiting ? MAX_WAIT_ATTEMPTS : MAX_STEP_ATTEMPTS)) {
        await this.fail(
          run,
          run.state === "publishing" ? "publish_failed" : "internal_error",
        );
        return;
      }
      await this.save(run);
      const pause = waiting
        ? Math.min(
            RETRY_MS * 2 ** Math.min(run.attempts - 1, 20),
            APPROVAL_POLL_MAX_MS,
          )
        : RETRY_MS;
      await this.setAlarm(run, this.deps.now() + pause);
    }
  }

  /** The clock that applies to the run's current state, and the code when it runs out. */
  private limitOf(run: StoredRun): {
    since: number;
    ms: number;
    code: ReasonCode;
  } {
    switch (run.state) {
      case "pr_opened":
      case "reviewing":
        return {
          since: run.reviewPhaseStartedAt ?? run.createdAt,
          ms: REVIEW_TIMEOUT_MS,
          code: "timeout",
        };
      case "awaiting_checks":
        return {
          since: run.checksStartedAt ?? run.createdAt,
          ms: CHECKS_TIMEOUT_MS,
          code: "checks_timeout",
        };
      case "awaiting_approval":
        return {
          since: run.approvalStartedAt ?? run.createdAt,
          ms: APPROVAL_TIMEOUT_MS,
          code: "approval_timeout",
        };
      default:
        return { since: run.createdAt, ms: RUN_TIMEOUT_MS, code: "timeout" };
    }
  }

  /** What the sandbox is doing: waits and shorter polls, or the exit code once it ended. */
  private async taskOutcome(
    port: { taskStatus(): Promise<TaskStatus> },
    since: number,
  ): Promise<
    { kind: "wait"; delayMs: number } | { kind: "done"; exitCode: number }
  > {
    const status = await port.taskStatus();
    if (status.state === "running") return { kind: "wait", delayMs: POLL_MS };
    // Right after the start the pid file may not exist yet: wait, but only briefly.
    if (status.state === "starting" || status.state === "none") {
      if (this.deps.now() - since > START_GRACE_MS) {
        throw new StepFailure("sandbox_lost");
      }
      return { kind: "wait", delayMs: 5_000 };
    }
    if (status.state === "finished")
      return { kind: "done", exitCode: status.exitCode };
    throw new StepFailure("sandbox_lost");
  }

  private async step(run: StoredRun): Promise<void> {
    const sandbox = this.deps.sandbox(run.id);
    switch (run.state) {
      case "queued":
        await this.transition(run, "cloning", null);
        await this.deps.storage.setAlarm(this.deps.now());
        return;
      case "cloning": {
        this.markLive(run, run.id);
        await this.save(run);
        await sandbox.start(run.repo, this.deps.model);
        const cloned = await sandbox.clone(run.repo);
        if (!cloned.ok || cloned.baseSha === undefined)
          throw new StepFailure("clone_failed");
        run.baseSha = cloned.baseSha;
        await this.transition(run, "implementing", null);
        await this.deps.storage.setAlarm(this.deps.now());
        return;
      }
      case "implementing": {
        if (!run.agentStarted) {
          await sandbox.startAgent({
            prompt: buildPrompt({
              repo: run.repo,
              issueNumber: run.issueNumber,
              title: run.title,
              body: run.body,
            }),
            model: this.deps.model,
          });
          run.agentStarted = true;
          run.agentStartedAt = this.deps.now();
          await this.save(run);
        }
        const outcome = await this.taskOutcome(
          sandbox,
          run.agentStartedAt ?? run.createdAt,
        );
        if (outcome.kind === "wait") {
          await this.deps.storage.setAlarm(this.deps.now() + outcome.delayMs);
          return;
        }
        if (outcome.exitCode === 0) {
          await this.transition(run, "publishing", null);
          await this.deps.storage.setAlarm(this.deps.now());
          return;
        }
        throw new StepFailure(
          isTimeoutExit(outcome.exitCode) ? "agent_timeout" : "agent_failed",
        );
      }
      case "publishing": {
        if (run.baseSha === undefined) throw new StepFailure("internal_error");
        let report: unknown;
        try {
          report = await sandbox.collectChanges(run.baseSha);
        } catch (error) {
          logDiagnostic("collect_changes_failed", {
            runId: run.id,
            error: errorKind(error),
          });
          throw new StepFailure("sandbox_lost");
        }
        const checked = validateChanges(report);
        if (!checked.ok) throw new StepFailure(checked.code);
        let pr;
        try {
          pr = await this.deps.publisher.publish({
            repo: run.repo,
            issueNumber: run.issueNumber,
            runId: run.id,
            model: this.deps.model,
            title: run.title,
            baseSha: run.baseSha,
            changes: checked.changes,
          });
        } catch (error) {
          if (error instanceof PublishRejected)
            throw new StepFailure(error.code);
          throw error;
        }
        run.prNumber = pr.prNumber;
        run.headSha = pr.headSha;
        run.reviewPhaseStartedAt = this.deps.now();
        await this.transition(run, "pr_opened", null, pr.prNumber);
        await this.deps.storage.setAlarm(this.deps.now());
        return;
      }
      case "pr_opened": {
        // Check the policy and the file list before any money goes to the reviewer.
        const pr = await this.openPullRequest(run);
        await this.evaluate(run, pr);
        await this.transition(run, "reviewing", null);
        await this.deps.storage.setAlarm(this.deps.now());
        return;
      }
      case "reviewing":
        await this.review(run);
        return;
      case "awaiting_checks":
      case "awaiting_approval":
        await this.gate(run);
        return;
      default:
        throw new Error("unreachable state");
    }
  }

  /** Fetches the pull request and stops the run when it is closed or its head is not the pinned commit. */
  private async openPullRequest(run: StoredRun): Promise<PullRequestInfo> {
    if (run.prNumber === undefined || run.headSha === undefined)
      throw new StepFailure("legacy_run");
    const pr = await this.deps.pulls.getPullRequest(run.repo, run.prNumber);
    if (pr.state !== "open" || pr.merged) {
      // A merge this machine started whose result was lost is still its merge.
      if (
        pr.merged &&
        run.mergeAttempted === true &&
        pr.headSha === run.headSha
      )
        return pr;
      // A person merged it. No action is left, so the record must not read as a closed pull request.
      throw new StepFailure(pr.merged ? "merged_outside_factory" : "pr_closed");
    }
    if (pr.headSha !== run.headSha) throw new StepFailure("head_changed");
    return pr;
  }

  /** Reads the policy from the default branch and classifies the pull request by its actual changed files. */
  private async evaluate(
    run: StoredRun,
    pr: PullRequestInfo,
  ): Promise<{ policy: Policy; tier: Tier }> {
    if (run.prNumber === undefined) throw new StepFailure("legacy_run");
    if (pr.baseRef !== pr.defaultBranch)
      throw new StepFailure("base_not_default");
    const file = await this.deps.pulls.readPolicy(run.repo, pr.defaultBranch);
    if (file.kind === "missing") throw new StepFailure("policy_missing");
    const parsed = parsePolicy(file.text);
    if (!parsed.ok) throw new StepFailure("policy_invalid");
    const listed = await this.deps.pulls.listFiles(
      run.repo,
      run.prNumber,
      pr.changedFiles,
    );
    if (listed.truncated) throw new StepFailure("files_truncated");
    return {
      policy: parsed.policy,
      tier: classifyPullRequest(listed.files, parsed.policy),
    };
  }

  private async review(run: StoredRun): Promise<void> {
    const rid = reviewSandboxId(run.id);
    const sandbox = this.deps.reviewSandbox(rid);
    const model = this.deps.reviewModel;
    if (run.headSha === undefined || run.prNumber === undefined)
      throw new StepFailure("legacy_run");
    if (run.reviewStarted !== true) {
      await this.openPullRequest(run);
      if (run.baseSha === undefined) throw new StepFailure("internal_error");
      const diff = await this.deps.pulls.getDiff(
        run.repo,
        run.baseSha,
        run.headSha,
      );
      const prompt = buildReviewPrompt({
        repo: run.repo,
        issueNumber: run.issueNumber,
        title: run.title,
        body: run.body,
        headSha: run.headSha,
        diff,
      });
      if (!prompt.ok) throw new StepFailure(prompt.code);
      this.markLive(run, rid);
      await this.save(run);
      await sandbox.start(run.repo, model);
      const cloned = await sandbox.cloneAt(run.repo, run.headSha);
      if (!cloned.ok) throw new StepFailure("clone_failed");
      await sandbox.startReview({ prompt: prompt.prompt, model });
      run.reviewStarted = true;
      run.reviewTaskStartedAt = this.deps.now();
      await this.save(run);
    }
    const outcome = await this.taskOutcome(
      sandbox,
      run.reviewTaskStartedAt ?? run.createdAt,
    );
    if (outcome.kind === "wait") {
      await this.deps.storage.setAlarm(this.deps.now() + outcome.delayMs);
      return;
    }
    if (outcome.exitCode !== 0) {
      throw new StepFailure(
        isTimeoutExit(outcome.exitCode) ? "agent_timeout" : "review_failed",
      );
    }
    // Only the schema-valid verdict counts. Anything else is "no verdict".
    const text = await sandbox.readReviewText();
    const parsed = text === undefined ? undefined : parseVerdict(text);
    if (parsed === undefined || !parsed.ok)
      throw new StepFailure("review_invalid");
    // The comment and the verdict are for the commit that was reviewed: it must still be the head.
    await this.openPullRequest(run);
    if (run.commentPosted !== true) {
      await this.deps.pulls.postReview(
        run.repo,
        run.prNumber,
        run.headSha,
        renderReviewComment(parsed.verdict, { model, headSha: run.headSha }),
      );
      run.commentPosted = true;
      await this.save(run);
    }
    // No automatic fix loop at this stage: a person decides what to do with requested changes.
    if (parsed.verdict.verdict !== "approve")
      throw new StepFailure("changes_requested");
    run.approvedSha = run.headSha;
    run.checksStartedAt = this.deps.now();
    await this.transition(run, "awaiting_checks", null);
    await this.deps.storage.setAlarm(this.deps.now());
  }

  /** awaiting_checks and awaiting_approval: decide from fresh GitHub data whether the pull request may merge. */
  private async gate(run: StoredRun): Promise<void> {
    if (run.prNumber === undefined || run.headSha === undefined)
      throw new StepFailure("legacy_run");
    const pr = await this.openPullRequest(run);
    if (pr.merged) {
      await this.transition(run, "merged", null);
      await this.deps.storage.deleteAlarm();
      return;
    }
    const { policy, tier } = await this.evaluate(run, pr);
    const checks = await this.deps.pulls.listChecks(run.repo, run.headSha);
    const reviews = await this.deps.pulls.listReviews(run.repo, run.prNumber);
    const decision =
      run.approvedSha === undefined
        ? ({ action: "needs_human", code: "review_invalid" } as const)
        : decideMerge({
            open: pr.state === "open" && !pr.merged,
            headSha: pr.headSha,
            reviewedSha: run.approvedSha,
            verdict: "approve",
            tier,
            policy,
            checks,
            reviews,
            operatorIds: this.deps.operatorIds,
            authorId: pr.authorId,
          });
    logDiagnostic("merge_decision", {
      runId: run.id,
      state: run.state,
      action: decision.action,
      tier,
    });
    switch (decision.action) {
      case "needs_human":
        throw new StepFailure(decision.code);
      case "wait_checks":
        if (run.state === "awaiting_checks") {
          await this.setAlarm(run, this.deps.now() + CHECKS_POLL_MS);
        } else {
          await this.scheduleApprovalPoll(run);
        }
        return;
      case "wait_approval":
        if (run.state === "awaiting_checks") {
          run.approvalStartedAt = this.deps.now();
          run.approvalPolls = 0;
          await this.transition(run, "awaiting_approval", null);
        }
        await this.scheduleApprovalPoll(run);
        return;
      case "merge": {
        run.mergeAttempted = true;
        await this.save(run);
        const result = await this.deps.pulls.merge(
          run.repo,
          run.prNumber,
          run.headSha,
          {
            title:
              `Factory: issue #${run.issueNumber} ${neutralizeMentions(run.title).slice(0, 80)}`.trim(),
            body: `Merged by the software factory after an approving review at this commit and passing required checks. Run ${run.id}.`,
          },
        );
        if (result === "refused") throw new StepFailure("merge_refused");
        if (result === "conflict") throw new StepFailure("merge_conflict");
        await this.transition(run, "merged", null);
        await this.deps.storage.deleteAlarm();
        return;
      }
    }
  }

  private async scheduleApprovalPoll(run: StoredRun): Promise<void> {
    const polls = run.approvalPolls ?? 0;
    const delay = Math.min(
      APPROVAL_POLL_MIN_MS * 2 ** Math.min(polls, 20),
      APPROVAL_POLL_MAX_MS,
    );
    run.approvalPolls = polls + 1;
    await this.save(run);
    await this.setAlarm(run, this.deps.now() + delay);
  }

  /** Sets the alarm, but not later than the next retry of a sandbox that could not be destroyed. */
  private async setAlarm(run: StoredRun, at: number): Promise<void> {
    const stuck = run.live.some(
      (id) => !this.neededSandboxes(run).includes(id),
    );
    await this.deps.storage.setAlarm(
      stuck ? Math.min(at, this.deps.now() + RETRY_MS) : at,
    );
  }

  private markLive(run: StoredRun, id: string): void {
    if (!run.live.includes(id)) run.live.push(id);
  }

  private async transition(
    run: StoredRun,
    to: RunState,
    code: ReasonCode | null,
    prNumber?: number,
  ): Promise<void> {
    assertTransition(run.state, to);
    await this.deps.repo.transition({
      runId: run.id,
      from: run.state,
      to,
      code,
      ts: this.deps.now(),
      ...(prNumber === undefined ? {} : { prNumber }),
    });
    run.state = to;
    run.attempts = 0;
    await this.save(run);
    await this.releaseUnneeded(run);
  }

  /** After the pull request exists a stop means a person must look; before it, the run failed. */
  private async fail(run: StoredRun, code: ReasonCode): Promise<void> {
    await this.transition(
      run,
      POST_PR_STATES.includes(run.state) ? "needs_human" : "failed",
      code,
    );
    await this.settleTerminal(run);
  }

  /** The sandboxes the run's current state still uses. */
  private neededSandboxes(run: StoredRun): string[] {
    switch (run.state) {
      case "queued":
      case "cloning":
      case "implementing":
      case "publishing":
        return [run.id];
      case "reviewing":
        return [reviewSandboxId(run.id)];
      default:
        return [];
    }
  }

  /**
   * Destroys the sandboxes that are no longer needed: the implement sandbox once the
   * pull request is open, the review sandbox once the review is over, all after a stop.
   * A failed destroy is retried by the alarm; after the last try it is recorded.
   */
  private async releaseUnneeded(run: StoredRun): Promise<void> {
    const needed = this.neededSandboxes(run);
    const stale = run.live.filter((id) => !needed.includes(id));
    if (stale.length === 0) return;
    for (const id of stale) {
      try {
        if (isReviewSandboxId(id)) await this.deps.reviewSandbox(id).destroy();
        else await this.deps.sandbox(id).destroy();
        await this.deps.repo.recordCleanup({
          runId: run.id,
          ts: this.deps.now(),
          code: null,
        });
      } catch {
        run.cleanupAttempts += 1;
        if (run.cleanupAttempts < MAX_CLEANUP_ATTEMPTS) break;
        await this.deps.repo.recordCleanup({
          runId: run.id,
          ts: this.deps.now(),
          code: "cleanup_failed",
        });
      }
      run.live = run.live.filter((x) => x !== id);
      run.cleanupAttempts = 0;
    }
    await this.save(run);
  }

  /** In a terminal state: releases what is left, then stops the alarm or schedules the retry. */
  private async settleTerminal(run: StoredRun): Promise<void> {
    await this.releaseUnneeded(run);
    if (run.live.length === 0) await this.deps.storage.deleteAlarm();
    else await this.deps.storage.setAlarm(this.deps.now() + RETRY_MS);
  }
}
