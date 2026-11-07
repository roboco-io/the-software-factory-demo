import { WorkerEntrypoint } from "cloudflare:workers";
import { D1RunRepo } from "./d1-repo";
import type { ControlEnv } from "./env";
import { prepareAnthropicRequest, prepareOpenAIRequest } from "./outbound-body";
import {
  decideOutbound,
  injectAnthropicKey,
  injectOpenAIKey,
  selectKey,
  type SandboxPhase,
} from "./outbound-policy";
import { meterResponse } from "./usage-meter";

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
    const decision = decideOutbound(
      { method: request.method, url: request.url },
      { repo: this.ctx.props?.repo, phase: this.ctx.props?.phase },
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
      const model = this.ctx.props?.model;
      const prepared =
        decision.target === "anthropic"
          ? await prepareAnthropicRequest(request, { model })
          : await prepareOpenAIRequest(request, { model });
      if (!prepared.ok) {
        console.log(`outbound deny-body ${prepared.reason}`);
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
      return this.meter(upstream, decision.target);
    }
    return fetch(new Request(request, { redirect: "manual" }));
  }

  /** Meters a model response for the run. A metering or recording failure never changes the response. */
  private meter(upstream: Response, target: "anthropic" | "openai"): Response {
    const { runId, phase, model } = this.ctx.props ?? {};
    if (!runId || !phase || !model || !this.env.DB) return upstream;
    try {
      const repo = new D1RunRepo(this.env.DB);
      const { response, done } = meterResponse(upstream, target, async (u) => {
        try {
          await repo.recordUsage({ runId, phase, model, ...u, ts: Date.now() });
        } catch (error) {
          // Log the error kind only: never a message, which could carry content.
          console.log(`outbound usage-record-failed ${errorKind(error)}`);
        }
      });
      try {
        this.ctx.waitUntil(done);
      } catch (error) {
        // The upstream body is already tee'd: always return the metered response, never the locked one.
        console.log(`outbound usage-meter-failed ${errorKind(error)}`);
      }
      return response;
    } catch (error) {
      console.log(`outbound usage-meter-failed ${errorKind(error)}`);
      return upstream;
    }
  }
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
