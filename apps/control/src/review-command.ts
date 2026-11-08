import { PLACEHOLDER_API_KEY, TRUST_ENV, isValidModel } from "./agent-command";
import { OPENAI_MAX_OUTPUT_TOKENS } from "./outbound-body";
import { providerOf } from "./pricing";

/** The pi provider of a reviewer model. Models without a price entry stay on OpenAI, as before stage 5. */
const piProvider = (model: string) => providerOf(model) ?? "openai";

export const PI_VERSION = "1.5.0";
export const REVIEW_TIMEOUT_SECONDS = 15 * 60;
/** Where pi reads its settings. Outside the repository, so the reviewed code cannot change them. */
export const PI_AGENT_DIR = "/workspace/pi-agent";
export const PI_MODELS_PATH = `${PI_AGENT_DIR}/models.json`;
export const REVIEW_TOOLS = "read,ls,grep,find";

/**
 * pi asks for the model's full output size (128000 for gpt-5.4-nano). The egress
 * rejects more than 16000, so the sandbox's pi settings lower it to the same limit.
 */
export function piModelsConfig(model: string): string {
  return JSON.stringify({
    providers: {
      [piProvider(model)]: {
        modelOverrides: { [model]: { maxTokens: OPENAI_MAX_OUTPUT_TOKENS } },
      },
    },
  });
}

/**
 * Builds the reviewer command as an argv array. The prompt is one element after `--`.
 * Read-only tools only; no session, extension, MCP, skill, prompt-template or
 * context-file loading, so nothing in the reviewed repository can add behavior.
 */
export function buildReviewCommand(input: { prompt: string; model: string }): {
  command: string[];
  env: Record<string, string>;
} {
  if (!isValidModel(input.model)) throw new Error("invalid model name");
  const provider = piProvider(input.model);
  return {
    command: [
      "timeout",
      "--kill-after=15",
      String(REVIEW_TIMEOUT_SECONDS),
      "pi",
      "--provider",
      provider,
      "--model",
      input.model,
      "--tools",
      REVIEW_TOOLS,
      "--no-session",
      "--no-extensions",
      "--no-mcp",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--mode",
      "json",
      "--",
      input.prompt,
    ],
    env: {
      ...TRUST_ENV,
      ...(provider === "anthropic"
        ? { ANTHROPIC_API_KEY: PLACEHOLDER_API_KEY }
        : { OPENAI_API_KEY: PLACEHOLDER_API_KEY }),
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      PI_CODING_AGENT_DIR: PI_AGENT_DIR,
    },
  };
}
