import Anthropic from "@anthropic-ai/sdk";
import { logDiagnostic } from "./diagnostics";
import type { ClassifyResult, TriageClassifier } from "./triage-service";

/** Room for the model's reasoning and the short JSON answer. */
export const TRIAGE_MAX_TOKENS = 4000;
/** The webhook's background work must end well inside the Worker's limit after the response. */
export const TRIAGE_TIMEOUT_MS = 20_000;

/**
 * The triage model call (docs/guest-demo.md 4.2): one Messages request from the Worker,
 * with the Worker's own key. No retry: a failed call leaves the request to the administrator.
 */
export function createTriageClassifier(config: {
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
}): TriageClassifier {
  const client = new Anthropic({
    apiKey: config.apiKey,
    maxRetries: 0,
    timeout: TRIAGE_TIMEOUT_MS,
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
  });
  return {
    async classify({ system, user }): Promise<ClassifyResult> {
      let message: Anthropic.Message;
      try {
        message = await client.messages.create({
          model: config.model,
          max_tokens: TRIAGE_MAX_TOKENS,
          system,
          // A classification into a few policy clauses: the lowest effort is enough.
          output_config: { effort: "low" },
          messages: [{ role: "user", content: user }],
        });
      } catch (error) {
        // Only the HTTP status: an error message can repeat request text.
        logDiagnostic("triage_model_error", {
          status: error instanceof Anthropic.APIError ? (error.status ?? 0) : 0,
        });
        return { ok: false };
      }
      const usage = {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
      };
      if (message.stop_reason !== "end_turn") {
        logDiagnostic("triage_model_stopped", {
          stopReason: String(message.stop_reason).slice(0, 40),
        });
        return { ok: false, usage };
      }
      let text = "";
      for (const block of message.content)
        if (block.type === "text") text += block.text;
      return { ok: true, text, usage };
    },
  };
}
