import { WorkerEntrypoint } from "cloudflare:workers";
import type { ControlEnv } from "./env";
import { prepareAnthropicRequest, prepareOpenAIRequest } from "./outbound-body";
import {
  decideOutbound,
  injectAnthropicKey,
  injectOpenAIKey,
  selectKey,
  type SandboxPhase,
} from "./outbound-policy";

interface OutboundProps {
  /** The one repository this run may read. */
  repo?: string;
  /** The one model this run may call. */
  model?: string;
  /** The sandbox phase: it decides which LLM provider, if any, is reachable. */
  phase?: SandboxPhase;
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
      return fetch(
        new Request(prepared.request, { headers, redirect: "manual" }),
      );
    }
    return fetch(new Request(request, { redirect: "manual" }));
  }
}
