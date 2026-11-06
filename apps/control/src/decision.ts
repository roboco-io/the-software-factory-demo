import type { Policy, RequiredCheck, Tier } from "./policy";
import type { ReasonCode } from "./run-types";

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  /** The GitHub App that created the run, when GitHub says. */
  appId: number | null;
}

export interface ReviewEntry {
  userId: string;
  userType: string;
  state: string;
  commitId: string | null;
}

export interface DecisionInput {
  /** The pull request is still open and unmerged. */
  open: boolean;
  /** The head SHA right now. */
  headSha: string;
  /** The head SHA the reviewer saw. */
  reviewedSha: string;
  verdict: "approve" | "changes_requested";
  tier: Tier;
  policy: Pick<Policy, "requiredChecks" | "autoMergeTiers">;
  /** Check runs for `headSha`. */
  checks: readonly CheckRun[];
  /** Pull request reviews, oldest first. */
  reviews: readonly ReviewEntry[];
  /** Numeric GitHub user IDs of operators. */
  operatorIds: readonly string[];
  /** Numeric ID of the pull request author, when known. */
  authorId: string | null;
}

export type Decision =
  | { action: "merge" }
  | { action: "wait_checks" }
  | { action: "wait_approval" }
  | { action: "needs_human"; code: ReasonCode };

/** Tiers that must never merge without a person, whatever the policy file says. */
const NEVER_AUTOMATIC: readonly Tier[] = ["T3"];

type CheckState = "success" | "failed" | "pending";

function checkState(
  required: RequiredCheck,
  checks: readonly CheckRun[],
): CheckState {
  // A run from another app is not this check: it can neither satisfy nor block it.
  const runs = checks.filter(
    (c) => c.name === required.name && c.appId === required.appId,
  );
  if (runs.length === 0) return "pending";
  let pending = false;
  for (const run of runs) {
    if (run.status !== "completed") pending = true;
    else if (run.conclusion !== "success") return "failed";
  }
  return pending ? "pending" : "success";
}

/**
 * What the operators think of the head. Each operator counts by the latest review
 * that is not a plain comment. An approval counts only for the exact head SHA; a
 * change request counts for any SHA until the same operator replaces it.
 */
export function operatorStanding(
  reviews: readonly ReviewEntry[],
  context: {
    headSha: string;
    operatorIds: readonly string[];
    authorId: string | null;
  },
): { approved: boolean; blocked: boolean } {
  const latest = new Map<string, ReviewEntry>();
  for (const review of reviews) {
    if (review.userType !== "User") continue;
    if (!context.operatorIds.includes(review.userId)) continue;
    if (review.userId === context.authorId) continue;
    if (review.state === "COMMENTED" || review.state === "PENDING") continue;
    latest.set(review.userId, review);
  }
  let approved = false;
  let blocked = false;
  for (const review of latest.values()) {
    if (review.state === "CHANGES_REQUESTED") blocked = true;
    if (review.state === "APPROVED" && review.commitId === context.headSha)
      approved = true;
  }
  return { approved, blocked };
}

/**
 * The merge decision. Pure: the caller fetched every input from GitHub for the
 * current head. Nothing here reads reviewer prose; only the validated verdict counts.
 */
export function decideMerge(input: DecisionInput): Decision {
  const stop = (code: ReasonCode): Decision => ({
    action: "needs_human",
    code,
  });
  if (!input.open) return stop("pr_closed");
  if (input.headSha !== input.reviewedSha) return stop("head_changed");
  if (input.verdict !== "approve") return stop("changes_requested");
  if (input.policy.requiredChecks.length === 0) return stop("policy_invalid");

  const states = input.policy.requiredChecks.map((required) =>
    checkState(required, input.checks),
  );
  if (states.includes("failed")) return stop("check_failed");
  if (states.includes("pending")) return { action: "wait_checks" };

  const standing = operatorStanding(input.reviews, {
    headSha: input.headSha,
    operatorIds: input.operatorIds,
    authorId: input.authorId,
  });
  if (standing.blocked) return stop("operator_changes_requested");

  const automatic =
    !NEVER_AUTOMATIC.includes(input.tier) &&
    input.policy.autoMergeTiers.includes(input.tier);
  if (automatic || standing.approved) return { action: "merge" };
  return { action: "wait_approval" };
}
