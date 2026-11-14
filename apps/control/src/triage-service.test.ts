import { describe, expect, it, vi } from "vitest";
import { parseGuestPolicy } from "./guest-policy";
import type { TriageRecord } from "./d1-triage";
import type { RunInput } from "./run-types";
import {
  bodyDigest,
  runTriage,
  type GuestIssue,
  type TriageDeps,
} from "./triage-service";

const NOW = Date.UTC(2026, 10, 14, 12);
const DAY = 24 * 60 * 60 * 1000;

const POLICY_YAML = `
version: 1
eligibility:
  minAccountAgeDays: 30
limits:
  perAccountPerDay: 2
  dailyUsd: 5
  maxBodyChars: 4000
allowed:
  - code: ui_text_style
    description: 화면 문구와 스타일.
forbidden:
  - code: auth
    description: 로그인과 권한.
escalate:
  - code: too_large
    description: 큰 요청.
`;

const FORM = [
  "### 요청 종류",
  "",
  "화면 문구·스타일",
  "",
  "### 무엇을 바꾸고 싶나요?",
  "",
  "버튼 문구를 바꿔 주세요.",
  "",
  "### 어떻게 되면 완료인가요?",
  "",
  "- 버튼 문구가 '다음 글 보기'다.",
  "",
  "### 확인",
  "",
  "- [x] 이해했습니다.",
].join("\n");

const issue = (over: Partial<GuestIssue> = {}): GuestIssue => ({
  repo: "acme/demo",
  issueNumber: 7,
  title: "[데모] 버튼 문구",
  body: FORM,
  labels: ["demo:guest"],
  author: { id: 555, login: "zed-author", type: "User" },
  deliveryId: "d-1",
  ...over,
});

const ACCEPT = JSON.stringify({
  decision: "accept",
  category: "ui_text_style",
  reasonCode: "allowed",
  summary: "버튼 문구를 바꾼다.",
  acceptance: ["버튼 문구가 '다음 글 보기'다."],
});
const REJECT = JSON.stringify({
  decision: "reject",
  category: "forbidden",
  reasonCode: "auth",
  summary: "로그인을 없애 달라는 요청 @admin https://evil.test",
  acceptance: [],
});
const ESCALATE = JSON.stringify({
  decision: "escalate",
  category: "out_of_scope",
  reasonCode: "too_large",
  summary: "새 페이지가 필요하다.",
  acceptance: [],
});

const USAGE = {
  inputTokens: 900,
  outputTokens: 80,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

function world(over: Partial<TriageDeps> = {}, answer: string = ACCEPT) {
  const records: TriageRecord[] = [];
  const usage: unknown[] = [];
  const github = {
    readGuestPolicy: vi.fn(async () => ({
      kind: "ok" as const,
      text: POLICY_YAML,
    })),
    userCreatedAt: vi.fn(async (): Promise<number | null> => NOW - 400 * DAY),
    addLabel: vi.fn<(r: string, n: number, l: string) => Promise<void>>(
      async () => {},
    ),
    comment: vi.fn<(r: string, n: number, b: string) => Promise<void>>(
      async () => {},
    ),
    closeNotPlanned: vi.fn<(r: string, n: number) => Promise<void>>(
      async () => {},
    ),
  };
  const model = {
    classify: vi.fn<TriageDeps["classifier"]["classify"]>(async () => ({
      ok: true as const,
      text: answer,
      usage: USAGE,
    })),
  };
  const start = vi.fn<(i: RunInput) => Promise<unknown>>(async () => ({
    outcome: "started",
    runId: "run9",
  }));
  const deps: TriageDeps = {
    now: () => NOW,
    model: "claude-haiku-5-5",
    portalOrigin: "https://factory.test",
    triage: {
      exists: async (repo, n) =>
        records.some((r) => r.repo === repo && r.issueNumber === n),
      record: async (r) => {
        if (
          records.some(
            (x) => x.repo === r.repo && x.issueNumber === r.issueNumber,
          )
        )
          return false;
        records.push(r);
        return true;
      },
      countByAuthorSince: async (authorId, since) =>
        records.filter((r) => r.authorId === authorId && r.createdAt >= since)
          .length,
      dailySpendUsd: async () => 0,
      recordUsage: async (u) => void usage.push(u),
    },
    github,
    classifier: model,
    modelBudgetOk: async () => true,
    starter: { start },
    ...over,
  };
  return { deps, records, usage, github, model, start };
}

describe("guest triage", () => {
  it("accepts: starts a run from the triaged snapshot and tells the guest", async () => {
    const w = world();
    const result = await runTriage(issue(), w.deps);
    expect(result).toEqual({ outcome: "accepted", runId: "run9" });
    expect(w.start).toHaveBeenCalledTimes(1);
    const input = w.start.mock.calls[0]![0];
    expect(input).toMatchObject({
      repo: "acme/demo",
      issueNumber: 7,
      title: "[데모] 버튼 문구",
      deliveryId: "d-1",
    });
    expect(input.body.startsWith(FORM)).toBe(true);
    expect(input.body).toContain("버튼 문구가 '다음 글 보기'다.");
    expect(w.records).toEqual([
      {
        repo: "acme/demo",
        issueNumber: 7,
        authorId: "555",
        decision: "accepted",
        category: "ui_text_style",
        reasonCode: "allowed",
        model: "claude-haiku-5-5",
        bodySha256: await bodyDigest("[데모] 버튼 문구", FORM),
        runId: "run9",
        createdAt: NOW,
      },
    ]);
    expect(w.github.addLabel).toHaveBeenCalledWith(
      "acme/demo",
      7,
      "demo:accepted",
    );
    const comment = w.github.comment.mock.calls[0]![2];
    expect(comment).toContain("https://factory.test/runs/run9");
    expect(comment).toContain("버튼 문구를 바꾼다.");
    expect(w.github.closeNotPlanned).not.toHaveBeenCalled();
    expect(w.usage).toEqual([
      {
        repo: "acme/demo",
        issueNumber: 7,
        model: "claude-haiku-5-5",
        usage: USAGE,
        ts: NOW,
      },
    ]);
  });

  it("gives the model the policy and the issue as data, never the author's name", async () => {
    const w = world();
    await runTriage(issue(), w.deps);
    const call = w.model.classify.mock.calls[0]![0];
    expect(call.system).toContain(POLICY_YAML);
    expect(call.user).toContain(JSON.stringify(FORM));
    expect(call.user).not.toContain("zed-author");
  });

  it("rejects by the model: fixed text only, closed as not planned, no run", async () => {
    const w = world({}, REJECT);
    expect(await runTriage(issue(), w.deps)).toEqual({
      outcome: "rejected",
      code: "auth",
    });
    expect(w.start).not.toHaveBeenCalled();
    expect(w.records[0]).toMatchObject({
      decision: "rejected",
      category: "forbidden",
      reasonCode: "auth",
      runId: null,
    });
    expect(w.github.addLabel).toHaveBeenCalledWith(
      "acme/demo",
      7,
      "demo:rejected",
    );
    expect(w.github.closeNotPlanned).toHaveBeenCalledWith("acme/demo", 7);
    const comment = w.github.comment.mock.calls[0]![2];
    expect(comment).toContain("`auth`");
    // The model's words never come back in a rejection.
    expect(comment).not.toContain("evil.test");
    expect(comment).not.toContain("로그인을 없애");
  });

  it("escalates: label and fixed comment, the issue stays open", async () => {
    const w = world({}, ESCALATE);
    expect(await runTriage(issue(), w.deps)).toEqual({
      outcome: "needs_admin",
      code: "too_large",
    });
    expect(w.records[0]).toMatchObject({
      decision: "needs_admin",
      reasonCode: "too_large",
    });
    expect(w.github.addLabel).toHaveBeenCalledWith(
      "acme/demo",
      7,
      "demo:needs-admin",
    );
    expect(w.github.closeNotPlanned).not.toHaveBeenCalled();
    expect(w.start).not.toHaveBeenCalled();
  });

  it.each([
    ["not JSON", "I think this is fine."],
    [
      "accept with a forbidden category",
      ACCEPT.replace("ui_text_style", "forbidden"),
    ],
  ])(
    "leaves an answer that fails the check to the administrator: %s",
    async (_n, raw) => {
      const w = world({}, raw);
      expect(await runTriage(issue(), w.deps)).toEqual({
        outcome: "needs_admin",
        code: "triage_invalid",
      });
      expect(w.start).not.toHaveBeenCalled();
      // The call was made, so its tokens are still counted.
      expect(w.usage).toHaveLength(1);
    },
  );

  it("leaves the request to the administrator when the model call fails or has no budget", async () => {
    const failed = world({
      classifier: { classify: async () => ({ ok: false as const }) },
    });
    expect(await runTriage(issue(), failed.deps)).toEqual({
      outcome: "needs_admin",
      code: "triage_unavailable",
    });
    const noBudget = world({ modelBudgetOk: async () => false });
    expect(await runTriage(issue(), noBudget.deps)).toEqual({
      outcome: "needs_admin",
      code: "triage_unavailable",
    });
    expect(noBudget.model.classify).not.toHaveBeenCalled();
  });

  it.each([
    [
      "account_too_new",
      (w: ReturnType<typeof world>) =>
        w.github.userCreatedAt.mockResolvedValue(NOW - 5 * DAY),
      issue(),
    ],
    [
      "account_too_new",
      (w: ReturnType<typeof world>) =>
        w.github.userCreatedAt.mockResolvedValue(null),
      issue(),
    ],
    [
      "quota_account",
      (w: ReturnType<typeof world>) => {
        for (const n of [1, 2])
          w.records.push({
            repo: "acme/demo",
            issueNumber: n,
            authorId: "555",
            decision: "rejected",
            category: null,
            reasonCode: "bad_form",
            model: null,
            bodySha256: "x",
            runId: null,
            createdAt: NOW - 1000,
          });
      },
      issue(),
    ],
    [
      "quota_daily",
      (w: ReturnType<typeof world>) => {
        w.deps.triage.dailySpendUsd = async () => 5;
      },
      issue(),
    ],
    [
      "quota_daily",
      (w: ReturnType<typeof world>) => {
        w.deps.triage.dailySpendUsd = async () => null;
      },
      issue(),
    ],
    ["bad_form", () => {}, issue({ body: "그냥 해 주세요" })],
  ] as const)(
    "pre-check rejects with %s and never calls the model",
    async (code, arrange, input) => {
      const w = world();
      arrange(w);
      expect(await runTriage(input, w.deps)).toEqual({
        outcome: "rejected",
        code,
      });
      expect(w.model.classify).not.toHaveBeenCalled();
      expect(w.start).not.toHaveBeenCalled();
      expect(w.github.closeNotPlanned).toHaveBeenCalledTimes(1);
      expect(w.records.at(-1)).toMatchObject({
        decision: "rejected",
        reasonCode: code,
        model: null,
      });
    },
  );

  it("triages an issue once", async () => {
    const w = world();
    await runTriage(issue(), w.deps);
    expect(await runTriage(issue({ deliveryId: "d-2" }), w.deps)).toEqual({
      outcome: "ignored",
      code: "already_triaged",
    });
    expect(w.model.classify).toHaveBeenCalledTimes(1);
    expect(w.start).toHaveBeenCalledTimes(1);
  });

  it("does nothing in a repository without a valid guest policy", async () => {
    const missing = world();
    missing.github.readGuestPolicy.mockResolvedValue({
      kind: "missing",
    } as never);
    expect(await runTriage(issue(), missing.deps)).toEqual({
      outcome: "ignored",
      code: "guest_policy_missing",
    });
    const invalid = world();
    invalid.github.readGuestPolicy.mockResolvedValue({
      kind: "ok",
      text: "version: 9",
    });
    expect(await runTriage(issue(), invalid.deps)).toEqual({
      outcome: "ignored",
      code: "guest_policy_invalid",
    });
    for (const w of [missing, invalid]) {
      expect(w.records).toEqual([]);
      expect(w.github.comment).not.toHaveBeenCalled();
      expect(w.model.classify).not.toHaveBeenCalled();
    }
    expect(parseGuestPolicy("version: 9").ok).toBe(false);
  });

  it("leaves an accepted request to the administrator when no run can start", async () => {
    const w = world({
      starter: { start: async () => ({ outcome: "capacity_full" }) },
    });
    expect(await runTriage(issue(), w.deps)).toEqual({
      outcome: "needs_admin",
      code: "start_deferred",
    });
    expect(w.records[0]).toMatchObject({
      decision: "needs_admin",
      reasonCode: "start_deferred",
      runId: null,
    });
    expect(w.github.addLabel).toHaveBeenCalledWith(
      "acme/demo",
      7,
      "demo:needs-admin",
    );
  });

  it("removes mentions and links from the model's words in the accept comment", async () => {
    const w = world(
      {},
      JSON.stringify({
        decision: "accept",
        category: "ui_text_style",
        reasonCode: "allowed",
        summary: "문구 변경 @octocat [클릭](https://evil.test/x) #12",
        acceptance: ["<img src=x> 문구가 바뀐다 http://evil.test"],
      }),
    );
    await runTriage(issue(), w.deps);
    const comment = w.github.comment.mock.calls[0]![2];
    expect(comment).not.toContain("evil.test");
    expect(comment).not.toContain("@octocat");
    expect(comment).not.toContain("<img");
    expect(comment).not.toMatch(/#12\b/);
  });

  it("keeps the record when a GitHub action fails", async () => {
    const w = world({}, REJECT);
    w.github.comment.mockRejectedValue(new Error("boom"));
    expect(await runTriage(issue(), w.deps)).toEqual({
      outcome: "rejected",
      code: "auth",
    });
    expect(w.records).toHaveLength(1);
  });
});
