export const AGENT_TIMEOUT_SECONDS = 15 * 60;
export const AGENT_MAX_TURNS = 40;
export const AGENT_MAX_BUDGET_USD = "2";
export const CLAUDE_CODE_VERSION = "2.1.318";
export const PLACEHOLDER_API_KEY = "placeholder-injected-by-outbound";

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The container CA is not in the system store. Tools need it by path. */
const CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
export const TRUST_ENV: Readonly<Record<string, string>> = {
  NODE_EXTRA_CA_CERTS: CA_PATH,
  GIT_SSL_CAINFO: CA_PATH,
  CURL_CA_BUNDLE: CA_PATH,
  SSL_CERT_FILE: CA_PATH,
  GIT_TERMINAL_PROMPT: "0",
};

export function isValidModel(model: string): boolean {
  return MODEL_PATTERN.test(model);
}

/**
 * Builds the agent command as an argv array. The prompt is one array element after
 * `--`, so it is never parsed by a shell. The environment holds only a placeholder
 * key: the outbound handler injects the real one.
 */
export function buildAgentCommand(input: { prompt: string; model: string }): {
  command: string[];
  env: Record<string, string>;
} {
  if (!isValidModel(input.model)) throw new Error("invalid model name");
  return {
    command: [
      "timeout",
      "--kill-after=15",
      String(AGENT_TIMEOUT_SECONDS),
      "claude",
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--no-session-persistence",
      "--max-turns",
      String(AGENT_MAX_TURNS),
      "--max-budget-usd",
      AGENT_MAX_BUDGET_USD,
      "--model",
      input.model,
      "--",
      input.prompt,
    ],
    env: {
      ...TRUST_ENV,
      ANTHROPIC_API_KEY: PLACEHOLDER_API_KEY,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      DISABLE_AUTOUPDATER: "1",
      IS_SANDBOX: "1",
      // Outbound only lets the run's model through, so background calls use it too.
      ANTHROPIC_SMALL_FAST_MODEL: input.model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: input.model,
      // Outbound rejects max_tokens above 16000.
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "16000",
    },
  };
}
