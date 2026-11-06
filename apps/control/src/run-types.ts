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
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const EVENT_KINDS = ["created", "transition", "cleanup"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
