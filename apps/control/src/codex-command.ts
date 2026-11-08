import {
  AGENT_TIMEOUT_SECONDS,
  PLACEHOLDER_API_KEY,
  TRUST_ENV,
  isValidModel,
} from "./agent-command";

/** Pinned. Its flags were read from `codex exec --help` of this version on 2026-11-08. */
export const CODEX_VERSION = "0.166.0";
/** Where Codex keeps its settings and state. Outside the repository, so the code cannot change them. */
export const CODEX_HOME = "/workspace/codex-home";

/**
 * Builds the Codex implementer command (stage 5: Anthropic reached its limit) as an argv
 * array. The prompt is one element after `--`. Codex's own sandbox and approvals are off:
 * the container is the sandbox and the egress handler decides what leaves it. The
 * environment holds only placeholder keys; the egress handler injects the real one.
 * Not yet run against the real service: the egress body rules (function tools only,
 * store false, output cap) may refuse some of Codex's requests.
 */
export function buildCodexCommand(input: { prompt: string; model: string }): {
  command: string[];
  env: Record<string, string>;
} {
  if (!isValidModel(input.model)) throw new Error("invalid model name");
  return {
    command: [
      "timeout",
      "--kill-after=15",
      String(AGENT_TIMEOUT_SECONDS),
      "codex",
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--ignore-rules",
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      input.model,
      "-c",
      'web_search="disabled"',
      "-c",
      "analytics.enabled=false",
      "-c",
      "feedback.enabled=false",
      "-c",
      "check_for_update_on_startup=false",
      "--",
      input.prompt,
    ],
    env: {
      ...TRUST_ENV,
      CODEX_API_KEY: PLACEHOLDER_API_KEY,
      OPENAI_API_KEY: PLACEHOLDER_API_KEY,
      CODEX_HOME,
    },
  };
}
