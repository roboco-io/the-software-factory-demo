import { DurableObject } from "cloudflare:workers";
import { parseList, resolveModel, resolveReviewModel } from "./config";
import { D1RunRepo } from "./d1-repo";
import type { ControlEnv } from "./env";
import { createPublisher } from "./github-publisher";
import { createPullClient } from "./github-pulls";
import type { PullRequestPort } from "./pull-port";
import {
  RunMachine,
  type PublisherPort,
  type ReviewSandboxPort,
  type SandboxPort,
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
        start: (repo, model) => stub.start(repo, model),
        clone: (repo) => stub.clone(repo),
        startAgent: (input) => stub.startAgent(input),
        taskStatus: () => stub.taskStatus() as Promise<TaskStatus>,
        collectChanges: (baseSha) =>
          stub.collectChanges(baseSha) as Promise<unknown>,
        destroy: () => stub.destroy(),
      };
    };
    const reviewSandboxPort = (sandboxId: string): ReviewSandboxPort => {
      const stub = env.SANDBOX.getByName(sandboxId);
      return {
        start: (repo, model) => stub.startReviewSandbox(repo, model),
        cloneAt: (repo, sha) => stub.cloneAt(repo, sha),
        startReview: (input) => stub.startReview(input),
        taskStatus: () => stub.taskStatus() as Promise<TaskStatus>,
        readReviewText: () => stub.readReviewText(),
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
      now: () => Date.now(),
      newId: () => crypto.randomUUID().replace(/-/g, "").slice(0, 12),
    });
  }

  start(input: RunInput) {
    return this.ctx.blockConcurrencyWhile(() => this.machine.start(input));
  }

  async alarm(): Promise<void> {
    await this.machine.alarm();
  }
}
