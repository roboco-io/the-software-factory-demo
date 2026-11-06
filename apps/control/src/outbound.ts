import { WorkerEntrypoint } from "cloudflare:workers";
import type { ControlEnv } from "./env";
import { prepareAnthropicRequest } from "./outbound-body";
import { decideOutbound, injectAnthropicKey } from "./outbound-policy";

interface OutboundProps {
  /** The one repository this run may read. */
  repo?: string;
  /** The one model this run may call. */
  model?: string;
}

/**
 * Every HTTP and HTTPS request from the agent container arrives here. The policy
 * is deny by default; the Anthropic key is added here and never enters the container.
 */
export class Outbound extends WorkerEntrypoint<ControlEnv, OutboundProps> {
  async fetch(request: Request): Promise<Response> {
    const decision = decideOutbound(
      { method: request.method, url: request.url },
      { repo: this.ctx.props?.repo },
    );
    const url = new URL(request.url);
    // Log method, host and path only: never the query, headers or bodies.
    console.log(
      `outbound ${decision.allow ? "allow" : "deny"} ${request.method} ${url.hostname}${url.pathname}`,
    );
    if (!decision.allow)
      return new Response(`DENIED: ${decision.reason}\n`, { status: 403 });

    if (decision.target === "anthropic") {
      const key = this.env.ANTHROPIC_API_KEY;
      if (!key)
        return new Response("DENIED: key_unavailable\n", { status: 503 });
      const prepared = await prepareAnthropicRequest(request, {
        model: this.ctx.props?.model,
      });
      if (!prepared.ok) {
        console.log(`outbound deny-body ${prepared.reason}`);
        return new Response(`DENIED: ${prepared.reason}\n`, {
          status: prepared.status,
        });
      }
      // Return the upstream response unread so streaming stays intact.
      return fetch(
        new Request(prepared.request, {
          headers: injectAnthropicKey(prepared.request.headers, key),
          redirect: "manual",
        }),
      );
    }
    return fetch(new Request(request, { redirect: "manual" }));
  }
}
