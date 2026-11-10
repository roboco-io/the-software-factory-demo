import { DurableObject } from "cloudflare:workers";
import { loadBudgetConfig } from "./budget";
import { BudgetService } from "./budget-service";
import {
  DEFAULT_ANTHROPIC_REVIEW_MODEL,
  DEFAULT_FACTORY_REPO,
  DEFAULT_FALLBACK_IMPLEMENT_MODEL,
  parseList,
  resolveModel,
  resolveReviewModel,
} from "./config";
import { D1BudgetRepo } from "./d1-budget";
import { D1RunRepo } from "./d1-repo";
import { createIssueCreator } from "./github-issues";
import { isValidRepo } from "./repo";
import type { ControlEnv } from "./env";
import { createPublisher } from "./github-publisher";
import { createPullClient } from "./github-pulls";
import type { PullRequestPort } from "./pull-port";
import {
  RunMachine,
  type PublisherPort,
  type ReviewSandboxPort,
  type SandboxPort,
  type StopResult,
} from "./run-machine";
import type { RunInput } from "./run-types";
import type { TaskStatus } from "./sandbox-core";

/** One Durable Object per repository and issue. It serializes the run's state changes. */
export class IssueRun extends DurableObject<ControlEnv> {
  private readonly machine: RunMachine;

  constructor(ctx: DurableObjectState, env: ControlEnv) {
    super(ctx, env);
    const sandboxPort = (runId: string): SandboxPort => {
      const stub = env.SANDBOX.getByName(runId);
      return {
        start: (repo, model) => stub.start(repo, model, runId),
        clone: (repo) => stub.clone(repo),
        startAgent: (input) => stub.startAgent(input),
        taskStatus: () => stub.taskStatus() as Promise<TaskStatus>,
        failureOutput: () => stub.failureOutput(),
        collectChanges: (baseSha) =>
          stub.collectChanges(baseSha) as Promise<unknown>,
        destroy: () => stub.destroy(),
      };
    };
    const reviewSandboxPort = (sandboxId: string): ReviewSandboxPort => {
      const stub = env.SANDBOX.getByName(sandboxId);
      return {
        start: (repo, model) =>
          stub.startReviewSandbox(
            repo,
            model,
            sandboxId.replace(/-review$/, ""),
          ),
        cloneAt: (repo, sha) => stub.cloneAt(repo, sha),
        startReview: (input) => stub.startReview(input),
        taskStatus: () => stub.taskStatus() as Promise<TaskStatus>,
        readReviewText: () => stub.readReviewText(),
        failureOutput: () => stub.failureOutput(),
        destroy: () => stub.destroy(),
      };
    };
    let pullClient: PullRequestPort | undefined;
    const client = (): PullRequestPort => {
      if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY)
        throw new Error("GitHub App is not configured");
      pullClient ??= createPullClient({
        appId: env.GITHUB_APP_ID,
        privateKeyPem: env.GITHUB_APP_PRIVATE_KEY,
      });
      return pullClient;
    };
    // Resolved on each call, so a missing configuration fails the step (and is retried) instead of the constructor.
    const pulls: PullRequestPort = {
      getPullRequest: (...a) => client().getPullRequest(...a),
      listFiles: (...a) => client().listFiles(...a),
      readPolicy: (...a) => client().readPolicy(...a),
      getDiff: (...a) => client().getDiff(...a),
      listChecks: (...a) => client().listChecks(...a),
      listReviews: (...a) => client().listReviews(...a),
      postReview: (...a) => client().postReview(...a),
      merge: (...a) => client().merge(...a),
    };
    const publisher: PublisherPort = {
      publish: (input) => {
        if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
          return Promise.reject(new Error("GitHub App is not configured"));
        }
        return createPublisher({
          appId: env.GITHUB_APP_ID,
          privateKeyPem: env.GITHUB_APP_PRIVATE_KEY,
        }).publish(input);
      },
    };
    const factoryRepo = env.FACTORY_REPO?.trim() ?? "";
    const budgetRepo = new D1BudgetRepo(env.DB);
    const budget = new BudgetService({
      repo: budgetRepo,
      config: () => loadBudgetConfig(env, budgetRepo),
      now: () => Date.now(),
      factoryRepo: isValidRepo(factoryRepo)
        ? factoryRepo
        : DEFAULT_FACTORY_REPO,
      issues: {
        createIssue: (...a) => {
          if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY)
            return Promise.reject(new Error("GitHub App is not configured"));
          return createIssueCreator({
            appId: env.GITHUB_APP_ID,
            privateKeyPem: env.GITHUB_APP_PRIVATE_KEY,
          }).createIssue(...a);
        },
      },
    });
    this.machine = new RunMachine({
      storage: {
        get: <T>(key: string) => ctx.storage.get<T>(key),
        put: (key, value) => ctx.storage.put(key, value),
        setAlarm: (at) => ctx.storage.setAlarm(at),
        getAlarm: () => ctx.storage.getAlarm(),
        deleteAlarm: () => ctx.storage.deleteAlarm(),
      },
      repo: new D1RunRepo(env.DB),
      sandbox: sandboxPort,
      reviewSandbox: reviewSandboxPort,
      publisher,
      pulls,
      operatorIds: parseList(env.OPERATOR_IDS),
      model: resolveModel(env.IMPLEMENT_MODEL),
      reviewModel: resolveReviewModel(env.REVIEW_MODEL),
      fallbackModel: resolveModel(
        env.FALLBACK_IMPLEMENT_MODEL,
        DEFAULT_FALLBACK_IMPLEMENT_MODEL,
      ),
      anthropicReviewModel: resolveModel(
        env.ANTHROPIC_REVIEW_MODEL,
        DEFAULT_ANTHROPIC_REVIEW_MODEL,
      ),
      budget,
      now: () => Date.now(),
      newId: () => crypto.randomUUID().replace(/-/g, "").slice(0, 12),
    });
  }

  start(input: RunInput) {
    return this.ctx.blockConcurrencyWhile(() => this.machine.start(input));
  }

  /** Records a request to stop the run with this id. The next alarm tick applies it. */
  stop(runId: string): Promise<StopResult> {
    return this.ctx.blockConcurrencyWhile(() => this.machine.stop(runId));
  }

  async alarm(): Promise<void> {
    await this.machine.alarm();
  }
}
