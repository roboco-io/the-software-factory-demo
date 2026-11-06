import { describe, expect, it } from "vitest";
import {
  decideMerge,
  operatorStanding,
  type CheckRun,
  type DecisionInput,
  type ReviewEntry,
} from "./decision";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const OPERATOR = "3435720";

const ACTIONS = 15368;
const pass = (name: string, appId: number | null = ACTIONS): CheckRun => ({
  name,
  status: "completed",
  conclusion: "success",
  appId,
});
const req = (name: string, appId = ACTIONS) => ({ name, appId });
const review = (
  userId: string,
  state: string,
  commitId: string | null = HEAD,
  userType = "User",
): ReviewEntry => ({ userId, userType, state, commitId });

function input(over: Partial<DecisionInput> = {}): DecisionInput {
  return {
    open: true,
    headSha: HEAD,
    reviewedSha: HEAD,
    verdict: "approve",
    tier: "T0",
    policy: {
      requiredChecks: [req("test"), req("lint")],
      autoMergeTiers: ["T0", "T1"],
    },
    checks: [pass("test"), pass("lint")],
    reviews: [],
    operatorIds: [OPERATOR],
    authorId: "99",
    ...over,
  };
}

describe("decideMerge", () => {
  it("merges a T0 change automatically when approved at the head and all checks pass", () => {
    expect(decideMerge(input())).toEqual({ action: "merge" });
  });

  it("head SHA swap: a changed head returns to needs_human even with perfect checks and approval", () => {
    expect(
      decideMerge(
        input({
          headSha: OLD,
          reviews: [review(OPERATOR, "APPROVED", HEAD)],
        }),
      ),
    ).toEqual({ action: "needs_human", code: "head_changed" });
  });

  it("goes to needs_human when the pull request is no longer open", () => {
    expect(decideMerge(input({ open: false }))).toEqual({
      action: "needs_human",
      code: "pr_closed",
    });
  });

  it("goes to needs_human when the reviewer asked for changes", () => {
    expect(decideMerge(input({ verdict: "changes_requested" }))).toEqual({
      action: "needs_human",
      code: "changes_requested",
    });
  });

  describe("required checks", () => {
    it("failed check: any conclusion other than success goes to needs_human", () => {
      for (const conclusion of [
        "failure",
        "cancelled",
        "timed_out",
        "action_required",
        "neutral",
        "skipped",
        "stale",
        null,
      ]) {
        expect(
          decideMerge(
            input({
              checks: [
                pass("test"),
                { name: "lint", status: "completed", conclusion, appId: 15368 },
              ],
            }),
          ),
          String(conclusion),
        ).toEqual({ action: "needs_human", code: "check_failed" });
      }
    });

    it("missing check: a required check that has not appeared yet waits", () => {
      expect(decideMerge(input({ checks: [pass("test")] }))).toEqual({
        action: "wait_checks",
      });
      expect(decideMerge(input({ checks: [] }))).toEqual({
        action: "wait_checks",
      });
    });

    it("pending check waits", () => {
      for (const status of ["queued", "in_progress", "waiting", "pending"]) {
        expect(
          decideMerge(
            input({
              checks: [
                pass("test"),
                { name: "lint", status, conclusion: null, appId: 15368 },
              ],
            }),
          ),
        ).toEqual({ action: "wait_checks" });
      }
    });

    it("a failure beats a pending check", () => {
      expect(
        decideMerge(
          input({
            checks: [
              {
                name: "test",
                status: "in_progress",
                conclusion: null,
                appId: 15368,
              },
              {
                name: "lint",
                status: "completed",
                conclusion: "failure",
                appId: 15368,
              },
            ],
          }),
        ),
      ).toEqual({ action: "needs_human", code: "check_failed" });
    });

    it("needs every run with a required name to succeed", () => {
      expect(
        decideMerge(
          input({
            checks: [
              pass("test"),
              pass("lint"),
              {
                name: "lint",
                status: "completed",
                conclusion: "failure",
                appId: 15368,
              },
            ],
          }),
        ),
      ).toEqual({ action: "needs_human", code: "check_failed" });
    });

    it("ignores checks that are not required, and matches names exactly", () => {
      expect(
        decideMerge(
          input({
            checks: [
              pass("test"),
              pass("lint"),
              {
                name: "optional",
                status: "completed",
                conclusion: "failure",
                appId: 15368,
              },
            ],
          }),
        ),
      ).toEqual({ action: "merge" });
      expect(
        decideMerge(input({ checks: [pass("test"), pass("Lint")] })),
      ).toEqual({ action: "wait_checks" });
    });

    it("a same-named run from another app counts as absent, whatever its result", () => {
      const other = 99999;
      expect(
        decideMerge(input({ checks: [pass("test"), pass("lint", other)] })),
      ).toEqual({ action: "wait_checks" });
      expect(
        decideMerge(input({ checks: [pass("test"), pass("lint", null)] })),
      ).toEqual({ action: "wait_checks" });
      // A failing run from another app cannot block, a passing one cannot satisfy.
      expect(
        decideMerge(
          input({
            checks: [
              pass("test"),
              pass("lint"),
              {
                name: "lint",
                status: "completed",
                conclusion: "failure",
                appId: other,
              },
            ],
          }),
        ),
      ).toEqual({ action: "merge" });
    });

    it("a per-check appId in the policy selects that app", () => {
      const policy = {
        requiredChecks: [req("test", 777), req("lint")],
        autoMergeTiers: ["T0" as const],
      };
      expect(
        decideMerge(input({ policy, checks: [pass("test"), pass("lint")] })),
      ).toEqual({ action: "wait_checks" });
      expect(
        decideMerge(
          input({ policy, checks: [pass("test", 777), pass("lint")] }),
        ),
      ).toEqual({ action: "merge" });
    });

    it("never merges when the policy lists no required check", () => {
      expect(
        decideMerge(
          input({ policy: { requiredChecks: [], autoMergeTiers: ["T0"] } }),
        ),
      ).toEqual({ action: "needs_human", code: "policy_invalid" });
    });
  });

  describe("tiers and approval", () => {
    it("T2 is not in autoMergeTiers: it waits for a person", () => {
      expect(decideMerge(input({ tier: "T2" }))).toEqual({
        action: "wait_approval",
      });
    });

    it("T3 policy abuse: T3 never auto-merges even when the policy lists it", () => {
      const abusive = {
        requiredChecks: [req("test"), req("lint")],
        autoMergeTiers: [
          "T0",
          "T1",
          "T2",
          "T3",
        ] as DecisionInput["policy"]["autoMergeTiers"],
      };
      expect(decideMerge(input({ tier: "T3", policy: abusive }))).toEqual({
        action: "wait_approval",
      });
      expect(
        decideMerge(
          input({
            tier: "T3",
            policy: abusive,
            reviews: [review(OPERATOR, "APPROVED")],
          }),
        ),
      ).toEqual({ action: "merge" });
    });

    it("non-operator approving review does not count", () => {
      expect(
        decideMerge(
          input({
            tier: "T2",
            reviews: [review("12345", "APPROVED"), review("99", "APPROVED")],
          }),
        ),
      ).toEqual({ action: "wait_approval" });
    });

    it("an approval from an operator at the head merges a tier that is not automatic", () => {
      expect(
        decideMerge(
          input({ tier: "T2", reviews: [review(OPERATOR, "APPROVED")] }),
        ),
      ).toEqual({ action: "merge" });
    });

    it("stale approval on an older SHA does not count", () => {
      expect(
        decideMerge(
          input({
            tier: "T2",
            reviews: [review(OPERATOR, "APPROVED", OLD)],
          }),
        ),
      ).toEqual({ action: "wait_approval" });
      expect(
        decideMerge(
          input({
            tier: "T2",
            reviews: [review(OPERATOR, "APPROVED", null)],
          }),
        ),
      ).toEqual({ action: "wait_approval" });
    });

    it("a later change request from an operator blocks, even for an automatic tier", () => {
      const reviews = [
        review(OPERATOR, "APPROVED"),
        review(OPERATOR, "CHANGES_REQUESTED"),
      ];
      expect(decideMerge(input({ tier: "T2", reviews }))).toEqual({
        action: "needs_human",
        code: "operator_changes_requested",
      });
      expect(decideMerge(input({ tier: "T0", reviews }))).toEqual({
        action: "needs_human",
        code: "operator_changes_requested",
      });
    });

    it("an approval after the change request lifts the block", () => {
      expect(
        decideMerge(
          input({
            tier: "T2",
            reviews: [
              review(OPERATOR, "CHANGES_REQUESTED", OLD),
              review(OPERATOR, "APPROVED"),
            ],
          }),
        ),
      ).toEqual({ action: "merge" });
    });

    it("ignores comments and dismissed reviews, and change requests from non-operators", () => {
      expect(
        decideMerge(
          input({
            tier: "T2",
            reviews: [
              review(OPERATOR, "APPROVED"),
              review(OPERATOR, "COMMENTED"),
              review("12345", "CHANGES_REQUESTED"),
            ],
          }),
        ),
      ).toEqual({ action: "merge" });
      expect(
        decideMerge(
          input({
            tier: "T2",
            reviews: [review(OPERATOR, "DISMISSED")],
          }),
        ),
      ).toEqual({ action: "wait_approval" });
    });

    it("the pull request author cannot approve its own pull request, even if listed as operator", () => {
      expect(
        decideMerge(
          input({
            tier: "T2",
            authorId: OPERATOR,
            reviews: [review(OPERATOR, "APPROVED")],
          }),
        ),
      ).toEqual({ action: "wait_approval" });
    });

    it("a bot account never counts as an operator", () => {
      expect(
        decideMerge(
          input({
            tier: "T2",
            reviews: [review(OPERATOR, "APPROVED", HEAD, "Bot")],
          }),
        ),
      ).toEqual({ action: "wait_approval" });
    });

    it("a failed check still stops a person-approved merge", () => {
      expect(
        decideMerge(
          input({
            tier: "T2",
            reviews: [review(OPERATOR, "APPROVED")],
            checks: [
              pass("test"),
              {
                name: "lint",
                status: "completed",
                conclusion: "failure",
                appId: 15368,
              },
            ],
          }),
        ),
      ).toEqual({ action: "needs_human", code: "check_failed" });
    });
  });
});

describe("operatorStanding", () => {
  it("reports approval at the head and blocking separately", () => {
    expect(
      operatorStanding([review(OPERATOR, "APPROVED")], {
        headSha: HEAD,
        operatorIds: [OPERATOR],
        authorId: null,
      }),
    ).toEqual({ approved: true, blocked: false });
  });
});
