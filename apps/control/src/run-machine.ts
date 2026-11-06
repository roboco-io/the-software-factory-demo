import { ActiveRunConflict, type RunRepo } from "./d1-repo";
import { validateChanges, type ValidChange } from "./changes";
import { errorKind, logDiagnostic } from "./diagnostics";
import { buildPrompt } from "./prompt";
import { assertTransition, isTerminal } from "./run-state";
import type { ReasonCode, RunInput, RunState } from "./run-types";
import type { TaskStatus } from "./sandbox-core";

export const RUN_TIMEOUT_MS = 20 * 60 * 1000;
export const POLL_MS = 15 * 1000;
export const RETRY_MS = 30 * 1000;
export const MAX_STEP_ATTEMPTS = 3;
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
  publish(input: PublishInput): Promise<{ prNumber: number; prUrl: string }>;
}

export interface MachineDeps {
  storage: RunStorage;
  repo: RunRepo;
  sandbox(runId: string): SandboxPort;
  publisher: PublisherPort;
  model: string;
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
  cleaned: boolean;
  cleanupAttempts: number;
}

/** A failure with a fixed code that must not be retried. */
class StepFailure extends Error {
  constructor(readonly code: ReasonCode) {
    super(code);
  }
}

const KEY = "run";

export class RunMachine {
  constructor(private readonly deps: MachineDeps) {}

  private load() {
    return this.deps.storage.get<StoredRun>(KEY);
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
      if (existing.state === "pr_opened")
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
      cleaned: false,
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
      await this.cleanup(run);
      return;
    }
    const now = this.deps.now();
    if (now - run.createdAt > RUN_TIMEOUT_MS) {
      await this.fail(run, "timeout");
      return;
    }
    try {
      await this.step(run);
    } catch (error) {
      if (error instanceof StepFailure) {
        await this.fail(run, error.code);
        return;
      }
      run.attempts += 1;
      logDiagnostic("run_step_error", {
        runId: run.id,
        state: run.state,
        attempt: run.attempts,
        error: errorKind(error),
      });
      if (run.attempts >= MAX_STEP_ATTEMPTS) {
        await this.fail(
          run,
          run.state === "publishing" ? "publish_failed" : "internal_error",
        );
        return;
      }
      await this.save(run);
      await this.deps.storage.setAlarm(this.deps.now() + RETRY_MS);
    }
  }

  private async step(run: StoredRun): Promise<void> {
    const sandbox = this.deps.sandbox(run.id);
    switch (run.state) {
      case "queued":
        await this.transition(run, "cloning", null);
        await this.deps.storage.setAlarm(this.deps.now());
        return;
      case "cloning": {
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
        const status = await sandbox.taskStatus();
        if (status.state === "running") {
          await this.deps.storage.setAlarm(this.deps.now() + POLL_MS);
          return;
        }
        // Right after the start the pid file may not exist yet: wait, but only briefly.
        if (status.state === "starting" || status.state === "none") {
          const since = run.agentStartedAt ?? run.createdAt;
          if (this.deps.now() - since > START_GRACE_MS) {
            throw new StepFailure("sandbox_lost");
          }
          await this.deps.storage.setAlarm(this.deps.now() + 5_000);
          return;
        }
        if (status.state === "finished") {
          if (status.exitCode === 0) {
            await this.transition(run, "publishing", null);
            await this.deps.storage.setAlarm(this.deps.now());
            return;
          }
          throw new StepFailure(
            status.exitCode === 124 || status.exitCode === 137
              ? "agent_timeout"
              : "agent_failed",
          );
        }
        throw new StepFailure("sandbox_lost");
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
        await this.transition(run, "pr_opened", null, pr.prNumber);
        await this.cleanup(run);
        return;
      }
      default:
        throw new Error("unreachable state");
    }
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
  }

  private async fail(run: StoredRun, code: ReasonCode): Promise<void> {
    await this.transition(run, "failed", code);
    await this.cleanup(run);
  }

  /** Destroys the sandbox. Runs after every terminal state; retried by the alarm if it fails. */
  private async cleanup(run: StoredRun): Promise<void> {
    if (run.cleaned) {
      await this.deps.storage.deleteAlarm();
      return;
    }
    try {
      await this.deps.sandbox(run.id).destroy();
      await this.deps.repo.recordCleanup({
        runId: run.id,
        ts: this.deps.now(),
        code: null,
      });
    } catch {
      run.cleanupAttempts += 1;
      if (run.cleanupAttempts < MAX_CLEANUP_ATTEMPTS) {
        await this.save(run);
        await this.deps.storage.setAlarm(this.deps.now() + RETRY_MS);
        return;
      }
      await this.deps.repo.recordCleanup({
        runId: run.id,
        ts: this.deps.now(),
        code: "cleanup_failed",
      });
    }
    run.cleaned = true;
    await this.save(run);
    await this.deps.storage.deleteAlarm();
  }
}
