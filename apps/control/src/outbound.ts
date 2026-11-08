import { WorkerEntrypoint } from "cloudflare:workers";
import { D1RunRepo } from "./d1-repo";
import type { ControlEnv } from "./env";
import { prepareAnthropicRequest, prepareOpenAIRequest } from "./outbound-body";
import {
  acquireCallSlot,
  checkCallBudget,
  releaseCallSlot,
} from "./outbound-budget";
import {
  decideOutbound,
  injectAnthropicKey,
  injectOpenAIKey,
  selectKey,
  type SandboxPhase,
} from "./outbound-policy";
import { providerOf } from "./pricing";
import { meterResponse, type Usage } from "./usage-meter";

/**
 * Stage 5. What a successful call counts as when its usage cannot be read: a large prompt and
 * the most output the egress allows. The budget would rather count too much than nothing.
 */
export const UNMETERED_USAGE: Usage = {
  inputTokens: 100000,
  outputTokens: 16000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

interface OutboundProps {
  /** The one repository this run may read. */
  repo?: string;
  /** The one model this run may call. */
  model?: string;
  /** The sandbox phase: it decides which LLM provider, if any, is reachable. */
  phase?: SandboxPhase;
  /** The run that pays for this sandbox's model calls. Set by the control plane, never by the agent. */
  runId?: string;
}

/**
 * Every HTTP and HTTPS request from the agent container arrives here. The policy
 * is deny by default; the provider key is added here and never enters the container.
 * The implement sandbox reaches only Anthropic, the review sandbox only OpenAI.
 */
export class Outbound extends WorkerEntrypoint<ControlEnv, OutboundProps> {
  async fetch(request: Request): Promise<Response> {
    const boundModel = this.ctx.props?.model;
    const decision = decideOutbound(
      { method: request.method, url: request.url },
      {
        repo: this.ctx.props?.repo,
        phase: this.ctx.props?.phase,
        // The bound model's provider is the only one this sandbox reaches.
        provider:
          boundModel === undefined
            ? undefined
            : (providerOf(boundModel) ?? undefined),
      },
    );
    const url = new URL(request.url);
    // Log method, host and path only: never the query, headers or bodies.
    console.log(
      `outbound ${decision.allow ? "allow" : "deny"} ${request.method} ${url.hostname}${url.pathname}`,
    );
    if (!decision.allow)
      return new Response(`DENIED: ${decision.reason}\n`, { status: 403 });

    if (decision.target === "anthropic" || decision.target === "openai") {
      const key = selectKey(decision.target, this.env);
      if (!key)
        return new Response("DENIED: key_unavailable\n", { status: 503 });
      const model = boundModel;
      const budget = await this.checkBudget(model);
      if (budget !== null) return budget;
      const slot = await this.takeSlot();
      if (slot instanceof Response) return slot;
      const release = () =>
        releaseCallSlot(this.env, slot).catch((error: unknown) => {
          // A slot that is not freed stops counting after INFLIGHT_STALE_MS.
          console.log(`outbound slot-release-failed ${errorKind(error)}`);
        });
      try {
        const prepared =
          decision.target === "anthropic"
            ? await prepareAnthropicRequest(request, { model })
            : await prepareOpenAIRequest(request, { model });
        if (!prepared.ok) {
          console.log(`outbound deny-body ${prepared.reason}`);
          await release();
          return new Response(`DENIED: ${prepared.reason}\n`, {
            status: prepared.status,
          });
        }
        const headers =
          decision.target === "anthropic"
            ? injectAnthropicKey(prepared.request.headers, key)
            : injectOpenAIKey(prepared.request.headers, key);
        // Return the upstream response unread so streaming stays intact.
        const upstream = await fetch(
          new Request(prepared.request, { headers, redirect: "manual" }),
        );
        return this.meter(upstream, decision.target, release);
      } catch (error) {
        await release();
        throw error;
      }
    }
    return fetch(new Request(request, { redirect: "manual" }));
  }

  /**
   * Refuses the call when the run or the account has reached its limit (stage 5).
   * Returns null when the call may go. Spend is recorded after each response, so the
   * calls already in flight can overshoot the limit by their own cost.
   */
  private async checkBudget(
    model: string | undefined,
  ): Promise<Response | null> {
    const runId = this.ctx.props?.runId;
    if (!runId || !model)
      return new Response("DENIED: no_run_bound\n", { status: 403 });
    try {
      const phase = this.ctx.props?.phase ?? "implement";
      const check = await checkCallBudget(this.env, runId, model, phase);
      if (check.allow) return null;
      console.log(`outbound deny-budget ${check.reason}`);
      return new Response(`DENIED: ${check.reason}\n`, { status: 402 });
    } catch (error) {
      // Without the spend the limit cannot be kept: fail closed.
      console.log(`outbound budget-check-failed ${errorKind(error)}`);
      return new Response("DENIED: budget_unavailable\n", { status: 503 });
    }
  }

  /** Takes one of the run's in-flight slots, or answers 429 (or 503 when D1 cannot be read). */
  private async takeSlot(): Promise<number | Response> {
    const runId = this.ctx.props?.runId;
    if (!runId) return new Response("DENIED: no_run_bound\n", { status: 403 });
    try {
      const slot = await acquireCallSlot(this.env, runId);
      if (slot !== null) return slot;
      console.log("outbound deny-budget too_many_calls_in_flight");
      return new Response("DENIED: too_many_calls_in_flight\n", {
        status: 429,
      });
    } catch (error) {
      console.log(`outbound budget-check-failed ${errorKind(error)}`);
      return new Response("DENIED: budget_unavailable\n", { status: 503 });
    }
  }

  /**
   * Meters a model response for the run and frees its in-flight slot when the response ends.
   * A metering or recording failure never changes the response.
   */
  private meter(
    upstream: Response,
    target: "anthropic" | "openai",
    release: () => Promise<void>,
  ): Response {
    const { runId, phase, model } = this.ctx.props ?? {};
    if (!runId || !phase || !model || !this.env.DB) {
      void release();
      return upstream;
    }
    try {
      const repo = new D1RunRepo(this.env.DB);
      const record = async (u: Usage) => {
        const row = { runId, phase, model, ...u, ts: Date.now() };
        // The budget counts these rows: try twice before giving up.
        for (let attempt = 1; ; attempt++) {
          try {
            await repo.recordUsage(row);
            return;
          } catch (error) {
            // Log the error kind only: never a message, which could carry content.
            console.log(`outbound usage-record-failed ${errorKind(error)}`);
            if (attempt >= 2) return;
          }
        }
      };
      const { response, done } = meterResponse(upstream, target, record, () => {
        console.log("outbound usage-unreadable");
        return record(UNMETERED_USAGE);
      });
      try {
        this.ctx.waitUntil(done.finally(release));
      } catch (error) {
        // The upstream body is already tee'd: always return the metered response, never the locked one.
        console.log(`outbound usage-meter-failed ${errorKind(error)}`);
        void release();
      }
      return response;
    } catch (error) {
      console.log(`outbound usage-meter-failed ${errorKind(error)}`);
      void release();
      return upstream;
    }
  }
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
