import { DurableObject } from "cloudflare:workers";
import { isValidModel } from "./agent-command";
import type { ControlEnv } from "./env";
import type { SandboxPhase } from "./outbound-policy";
import { isValidRepo } from "./repo";
import {
  SandboxController,
  type ExecResult,
  type TaskStatus,
} from "./sandbox-core";

const INSTANCE_TYPE = "basic";
const INACTIVITY_TIMEOUT_MS = 25 * 60 * 1000;
const REPO_KEY = "repo";
const MODEL_KEY = "model";
const PHASE_KEY = "phase";
const RUN_ID_KEY = "runId";

/**
 * One container per sandbox id; the implement and the review phase use different
 * ids. The container starts without internet access: every HTTP and HTTPS request
 * goes to `Outbound`, which is bound to this sandbox's repository, model and phase.
 * No GitHub token and no LLM key is ever passed in.
 */
export class AgentSandbox extends DurableObject<ControlEnv> {
  private readonly container: NonNullable<DurableObjectState["container"]>;
  private readonly controller: SandboxController;
  private setup: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: ControlEnv) {
    super(ctx, env);
    if (!ctx.container) throw new Error("No container is configured");
    this.container = ctx.container;
    this.controller = new SandboxController({
      exec: async (command, options): Promise<ExecResult> => {
        if (options.background) {
          await this.container.exec(command, {
            cwd: options.cwd,
            env: options.env,
            stdout: "ignore",
            stderr: "ignore",
          });
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        const process = await this.container.exec(command, {
          cwd: options.cwd,
          env: options.env,
        });
        const output = await process.output();
        const decoder = new TextDecoder();
        return {
          exitCode: output.exitCode,
          stdout: decoder.decode(output.stdout),
          stderr: decoder.decode(output.stderr),
        };
      },
    });
    if (this.container.running) {
      void ctx.blockConcurrencyWhile(() =>
        this.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS),
      );
    }
  }

  /** Starts the implement-phase sandbox: it reaches Anthropic and the run's repository. */
  async start(repo: string, model: string, runId?: string): Promise<void> {
    await this.bind("implement", repo, model, runId);
  }

  /** Starts the review-phase sandbox: it reaches OpenAI and the run's repository. */
  async startReviewSandbox(
    repo: string,
    model: string,
    runId?: string,
  ): Promise<void> {
    await this.bind("review", repo, model, runId);
  }

  private async bind(
    phase: SandboxPhase,
    repo: string,
    model: string,
    runId?: string,
  ): Promise<void> {
    if (!isValidRepo(repo)) throw new Error("invalid repository name");
    if (!isValidModel(model)) throw new Error("invalid model name");
    const bound = this.ctx.storage.kv.get<string>(PHASE_KEY);
    if (bound !== undefined && bound !== phase)
      throw new Error("sandbox is bound to another phase");
    this.ctx.storage.kv.put(REPO_KEY, repo);
    this.ctx.storage.kv.put(MODEL_KEY, model);
    this.ctx.storage.kv.put(PHASE_KEY, phase);
    // Never keep a run id from an older start: an unmetered start must not bill the old run.
    if (runId !== undefined) this.ctx.storage.kv.put(RUN_ID_KEY, runId);
    else this.ctx.storage.kv.delete(RUN_ID_KEY);
    await this.ensureRunning();
  }

  private requirePhase(phase: SandboxPhase): void {
    // A sandbox started before phases existed has no phase and was an implement sandbox.
    const bound =
      this.ctx.storage.kv.get<SandboxPhase>(PHASE_KEY) ?? "implement";
    if (bound !== phase) throw new Error("sandbox is bound to another phase");
  }

  async clone(repo: string) {
    this.requirePhase("implement");
    await this.ensureRunning();
    if (repo !== this.ctx.storage.kv.get(REPO_KEY))
      throw new Error("repository is not bound to this run");
    return this.controller.clone(repo);
  }

  async startAgent(input: { prompt: string; model: string }) {
    this.requirePhase("implement");
    if (!isValidModel(input.model)) throw new Error("invalid model name");
    await this.ensureRunning();
    return this.controller.startAgent(input);
  }

  /** Review phase: checks out the pinned pull request head. */
  async cloneAt(repo: string, sha: string) {
    this.requirePhase("review");
    await this.ensureRunning();
    if (repo !== this.ctx.storage.kv.get(REPO_KEY))
      throw new Error("repository is not bound to this run");
    return this.controller.cloneAt(repo, sha);
  }

  async startReview(input: { prompt: string; model: string }) {
    this.requirePhase("review");
    if (input.model !== this.ctx.storage.kv.get(MODEL_KEY))
      throw new Error("model is not bound to this run");
    await this.ensureRunning();
    return this.controller.startReview(input);
  }

  async readReviewText(): Promise<string | undefined> {
    this.requirePhase("review");
    await this.ensureRunning();
    return this.controller.readReviewText();
  }

  async taskStatus(): Promise<TaskStatus> {
    if (!this.container.running) return { state: "lost" };
    return this.controller.readTaskStatus();
  }

  async collectChanges(baseSha: string): Promise<unknown> {
    this.requirePhase("implement");
    await this.ensureRunning();
    return this.controller.collectChanges(baseSha);
  }

  async destroy(): Promise<void> {
    if (this.container.running) await this.container.destroy();
    this.setup = undefined;
  }

  private async ensureRunning(): Promise<void> {
    if (this.setup === undefined || !this.container.running) {
      this.setup = this.setUp().catch((error: unknown) => {
        this.setup = undefined;
        throw error;
      });
    }
    await this.setup;
  }

  private async setUp(): Promise<void> {
    const repo = this.ctx.storage.kv.get<string>(REPO_KEY);
    const model = this.ctx.storage.kv.get<string>(MODEL_KEY);
    const phase =
      this.ctx.storage.kv.get<SandboxPhase>(PHASE_KEY) ?? "implement";
    const storedRunId = this.ctx.storage.kv.get<unknown>(RUN_ID_KEY);
    const runId =
      typeof storedRunId === "string" && storedRunId !== ""
        ? storedRunId
        : undefined;
    if (repo === undefined || model === undefined)
      throw new Error("sandbox has no repository or model bound");
    if (!this.container.running) {
      this.container.start({
        image: (this.container as unknown as { images: { agent: string } })
          .images.agent,
        instance: INSTANCE_TYPE,
        enableInternet: false,
      } as never);
    }
    try {
      const exportsObject = (
        this.ctx as unknown as {
          exports: {
            Outbound: (options: {
              props: {
                repo: string;
                model: string;
                phase: SandboxPhase;
                runId?: string;
              };
            }) => unknown;
          };
        }
      ).exports;
      const outbound = exportsObject.Outbound({
        props: {
          repo,
          model,
          phase,
          ...(runId !== undefined ? { runId } : {}),
        },
      });
      await this.container.interceptAllOutboundHttp(outbound as never);
      await this.container.interceptOutboundHttps("*", outbound as never);
      await this.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    } catch (error) {
      await this.container.destroy();
      throw error;
    }
  }
}
