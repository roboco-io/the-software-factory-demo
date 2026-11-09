/**
 * Labels why an agent (implementer or reviewer) exited non-zero. The agent's output is
 * untrusted and may hold the prompt, code or keys, so it is matched against fixed patterns
 * here and never logged: only the label (and an egress reason token of our own) leaves.
 */
export interface AgentFailure {
  kind: string;
  /** The egress handler's reason token, when the agent printed one of its refusals. */
  detail?: string;
}

const RULES: ReadonlyArray<[string, RegExp]> = [
  [
    "agent_home_missing",
    /CODEX_HOME points to|codex home|PI_CODING_AGENT_DIR/i,
  ],
  ["budget_denied", /\b402\b|payment required|budget_exceeded/i],
  [
    "auth_rejected",
    /\b401\b|unauthori[sz]ed|incorrect api key|invalid api key/i,
  ],
  ["rate_limited", /\b429\b|too many requests|rate limit/i],
  ["model_not_found", /model\b.{0,80}\b(not found|does not exist)|\b404\b/i],
  ["permission_denied", /EACCES|EPERM|permission denied/i],
  [
    "network_error",
    /certificate|\bTLS\b|\bSSL\b|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|socket hang up/i,
  ],
];

/** Reason tokens of the egress handler: lower case words joined by underscores. */
const EGRESS_REASON = /DENIED: ([a-z][a-z_]{0,47})(?![A-Za-z0-9_\-/.:])/;

export function classifyAgentFailure(
  exitCode: number,
  output: { stderr: string; stdout: string },
): AgentFailure {
  if (exitCode === 127) return { kind: "command_not_found" };
  if (exitCode === 126) return { kind: "not_executable" };
  const text = `${output.stderr}\n${output.stdout}`;
  if (text.trim() === "") return { kind: "no_output" };
  if (/DENIED: /.test(text)) {
    const reason = EGRESS_REASON.exec(text)?.[1];
    return reason === undefined
      ? { kind: "egress_denied" }
      : { kind: "egress_denied", detail: reason };
  }
  for (const [kind, pattern] of RULES) if (pattern.test(text)) return { kind };
  return { kind: "unknown" };
}
