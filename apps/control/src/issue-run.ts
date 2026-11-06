import { DurableObject } from "cloudflare:workers";
import { resolveModel } from "./config";
import { D1RunRepo } from "./d1-repo";
import type { ControlEnv } from "./env";
import { createPublisher } from "./github-publisher";
import {
  RunMachine,
  type PublisherPort,
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
      publisher,
      model: resolveModel(env.IMPLEMENT_MODEL),
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
