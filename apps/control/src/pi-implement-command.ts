import {
  AGENT_TIMEOUT_SECONDS,
  PLACEHOLDER_API_KEY,
  TRUST_ENV,
  isValidModel,
} from "./agent-command";
import { PI_AGENT_DIR } from "./review-command";

/** The coding tools of pi 1.5.0 (its defaults, named so a new default cannot slip in). */
export const IMPLEMENT_TOOLS = "read,bash,edit,write";
/** The thinking level of the pi x gpt-6.1-terra benchmark run (EXP-057). */
export const IMPLEMENT_THINKING = "medium";

/**
 * Appended to pi's system prompt. pi's own prompt has no autonomy section, so without it
 * pi ends its turn after one part of the work. Taken word for word from the benchmark
 * (roboco-io/coding-agent-benchmark, experiments/057-pi-gpt61-terra-persist/persistence.md).
 */
export const PERSISTENCE_PROMPT = `# Autonomy and persistence

You are running non-interactively. No user will read or answer anything until you end your turn, and ending your turn ends this session.

Bias towards action and carry the user's intended task to completion. Persist until the task's stated completion criteria are fully met and verified, all within this single turn. Do not end your turn after finishing one part of the work: when a part is done, continue with the next remaining part. Do not end your turn to report progress or partial results. End your turn only when every completion criterion has been met and verified, or when you are blocked by something you cannot resolve yourself.`;

/**
 * Builds the fallback implementer command (stage 5: Anthropic reached its limit) as an
 * argv array: pi on OpenAI, set up as in the benchmark run. The prompt is one element
 * after `--`. Nothing is loaded from the repository (context files, skills, extensions,
 * prompt templates, project settings) or from MCP. The environment holds only a
 * placeholder key; the egress handler injects the real one.
 */
export function buildPiImplementCommand(input: {
  prompt: string;
  model: string;
}): { command: string[]; env: Record<string, string> } {
  if (!isValidModel(input.model)) throw new Error("invalid model name");
  return {
    command: [
      "timeout",
      "--kill-after=15",
      String(AGENT_TIMEOUT_SECONDS),
      "pi",
      "--provider",
      "openai",
      "--model",
      input.model,
      "--thinking",
      IMPLEMENT_THINKING,
      "--tools",
      IMPLEMENT_TOOLS,
      "--no-session",
      "--no-extensions",
      "--no-mcp",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-approve",
      "--append-system-prompt",
      PERSISTENCE_PROMPT,
      "--mode",
      "json",
      "--",
      input.prompt,
    ],
    env: {
      ...TRUST_ENV,
      OPENAI_API_KEY: PLACEHOLDER_API_KEY,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      PI_CODING_AGENT_DIR: PI_AGENT_DIR,
    },
  };
}
