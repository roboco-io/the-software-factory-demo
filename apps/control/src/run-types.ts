import { REJECT_CODES } from "./changes";

export interface RunInput {
  repo: string;
  issueNumber: number;
  title: string;
  body: string;
  deliveryId: string;
}

export const STATES = [
  "queued",
  "cloning",
  "implementing",
  "publishing",
  "pr_opened",
  "reviewing",
  "awaiting_checks",
  "awaiting_approval",
  "merged",
  "needs_human",
  "failed",
] as const;
export type RunState = (typeof STATES)[number];

/** Fixed reason codes. Events carry only these, never free text. */
export const REASON_CODES = [
  ...REJECT_CODES,
  "timeout",
  "agent_failed",
  "agent_timeout",
  "sandbox_lost",
  "clone_failed",
  "publish_failed",
  "internal_error",
  "cleanup_failed",
  // Review and merge (stage 3).
  "legacy_run",
  "pr_closed",
  "merged_outside_factory",
  "base_not_default",
  "head_changed",
  "policy_missing",
  "policy_invalid",
  "files_truncated",
  "diff_too_large",
  "review_failed",
  "review_invalid",
  "changes_requested",
  "check_failed",
  "checks_timeout",
  "checks_permission_missing",
  "operator_changes_requested",
  "approval_timeout",
  "merge_refused",
  "merge_conflict",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const EVENT_KINDS = ["created", "transition", "cleanup"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
