// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

// A small fake of console-model.
vi.mock("./console-model", async () => {
  const STAGES: Record<string, number> = {
    queued: 0,
    implementing: 1,
    reviewing: 2,
    checking: 3,
    awaiting_approval: 4,
    merged: 5,
    needs_human: 5,
    failed: 5,
  };
  const json = async (fetchFn: typeof fetch, url: string) => {
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
  return {
    stageOf: (s: string) => STAGES[s] ?? 0,
    explain: (r: { state: string; reasonCode: string | null }) =>
      `설명:${r.state}:${r.reasonCode}`,
    money: (c: { status: string; totalUsd: number | null }) =>
      c.status === "not_measured"
        ? "측정 전"
        : c.status === "unknown"
          ? "계산 불가"
          : `$${(c.totalUsd ?? 0).toFixed(2)}`,
    fetchConsole: async (fetchFn: typeof fetch) => {
      const [list, session] = await Promise.all([
        json(fetchFn, "/api/runs"),
        json(fetchFn, "/api/session"),
      ]);
      return { runs: list.runs, totals: list.totals, session };
    },
    fetchRun: (fetchFn: typeof fetch, id: string) =>
      json(fetchFn, `/api/runs/${encodeURIComponent(id)}`),
    sendReview: async (
      fetchFn: typeof fetch,
      id: string,
      action: string,
      headSha: string,
    ) => {
      const res = await fetchFn(`/api/runs/${encodeURIComponent(id)}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, headSha }),
      });
      const body = await res.json();
      return res.ok
        ? { ok: true, redirect: body.redirect }
        : { ok: false, error: body.error };
    },
  };
});

import { mountConsole } from "./console-view";

type Overrides = Record<string, unknown>;
const cost = {
  status: "measured",
  totalUsd: 0.47,
  implementUsd: 0.42,
  reviewUsd: 0.05,
};
function run(id: string, o: Overrides = {}) {
  return {
    id,
    repo: "a/b",
    issueNumber: 1,
    title: `title ${id}`,
    tier: "T3",
    state: "reviewing",
    reasonCode: null,
    prNumber: 7,
    headSha: "abc1234",
    createdAt: 0,
    updatedAt: Date.now() - 120000,
    bucket: "active",
    cost,
    ...o,
  };
}
const approvalRun = () =>
  run("r1", {
    issueNumber: 128,
    state: "awaiting_approval",
    bucket: "attention",
  });

function api(
  runs: unknown[],
  role = "anonymous",
  extra: Record<string, unknown> = {},
) {
  const calls: { url: string; method: string }[] = [];
  let fail = false;
  const fetchFn = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    if (fail) return new Response("{}", { status: 500 });
    const j = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url === "/api/session")
      return j({
        role,
        login: role === "anonymous" ? null : "me",
        loginEnabled: true,
      });
    if (url === "/api/runs") {
      const count = (b: string) =>
        runs.filter((r) => (r as { bucket: string }).bucket === b).length;
      return j({
        runs,
        totals: {
          attention: count("attention"),
          active: count("active"),
          done: count("done"),
          usd: 1.5,
        },
      });
    }
    const m = /^\/api\/runs\/([^/]+)$/.exec(url);
    if (m) {
      const found = runs.find(
        (r) => (r as { id: string }).id === decodeURIComponent(m[1]!),
      );
      return found
        ? j({
            ...(found as object),
            events: [
              {
                ts: 1700000000000,
                kind: "transition",
                fromState: "queued",
                toState: "implementing",
                reasonCode: null,
              },
            ],
          })
        : j({ error: "not_found" }, 404);
    }
    if (/\/review$/.test(url))
      return (
        extra.reviewResponse ??
        j({ redirect: "https://github.com/login/oauth/authorize?x=1" })
      );
    return j({ error: "not_found" }, 404);
  }) as unknown as typeof fetch;
  return { fetchFn, calls, setFail: (v: boolean) => (fail = v) };
}

function setup() {
  const root = document.createElement("main");
  document.body.replaceChildren(root);
  let tick: (() => void) | undefined;
  let ms = 0;
  const fakeInterval = ((fn: () => void, delay: number) => {
    tick = fn;
    ms = delay;
    return 1;
  }) as unknown as typeof setInterval;
  return { root, fakeInterval, tick: () => tick?.(), ms: () => ms };
}
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const text = (root: HTMLElement) => root.textContent ?? "";
const buttonByText = (root: HTMLElement, t: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent === t) as
    HTMLButtonElement | undefined;

beforeEach(() => {
  window.history.replaceState({}, "", "/");
});

describe("console view", () => {
  it("test_title_is_text: title markup creates no element", async () => {
    const { root, fakeInterval } = setup();
    const a = api([run("r1", { title: "<img src=x onerror=1>" })]);
    await mountConsole(root, { fetch: a.fetchFn, setInterval: fakeInterval });
    expect(root.querySelector("img")).toBeNull();
    expect(text(root)).toContain("<img src=x onerror=1>");
    root.querySelector<HTMLButtonElement>("[data-run]")!.click();
    await flush();
    expect(root.querySelector("img")).toBeNull();
  });

  it("test_buttons_operator_only", async () => {
    for (const [role, expected] of [
      ["anonymous", false],
      ["observer", false],
      ["operator", true],
    ] as const) {
      const { root, fakeInterval } = setup();
      const a = api([approvalRun(), run("r2", { issueNumber: 2 })], role);
      await mountConsole(root, { fetch: a.fetchFn, setInterval: fakeInterval });
      root.querySelector<HTMLButtonElement>("[data-run]")!.click();
      await flush();
      expect(!!buttonByText(root, "승인"), role).toBe(expected);
      expect(!!buttonByText(root, "수정 요청"), role).toBe(expected);
    }
    const { root, fakeInterval } = setup();
    const a = api([run("r2", { issueNumber: 2 })], "operator");
    await mountConsole(root, { fetch: a.fetchFn, setInterval: fakeInterval });
    root.querySelector<HTMLButtonElement>("[data-run]")!.click();
    await flush();
    expect(buttonByText(root, "승인")).toBeUndefined();
  });

  it("test_poll_failure_keeps_data", async () => {
    const { root, fakeInterval, tick } = setup();
    const a = api([run("r1", { title: "Keep me" })]);
    await mountConsole(root, { fetch: a.fetchFn, setInterval: fakeInterval });
    a.setFail(true);
    tick();
    await flush();
    expect(text(root)).toContain("Keep me");
    expect(root.querySelector("[role=alert]")?.textContent).toContain(
      "최신 상태를 불러오지 못했습니다",
    );
    a.setFail(false);
    tick();
    await flush();
    expect(root.querySelector("[role=alert]")).toBeNull();
  });

  it("test_empty_state", async () => {
    const { root, fakeInterval } = setup();
    const a = api([]);
    await mountConsole(root, { fetch: a.fetchFn, setInterval: fakeInterval });
    expect(text(root)).toContain("표시할 실행이 없습니다");
  });

  it("attention filter", async () => {
    const { root, fakeInterval } = setup();
    const a = api([approvalRun(), run("r2", { issueNumber: 2 })]);
    await mountConsole(root, { fetch: a.fetchFn, setInterval: fakeInterval });
    expect(root.querySelectorAll("[data-run]").length).toBe(2);
    buttonByText(root, "확인 필요")!.click();
    expect(root.querySelectorAll("[data-run]").length).toBe(1);
    expect(buttonByText(root, "확인 필요")!.getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("four cards with totals", async () => {
    const { root, fakeInterval } = setup();
    const a = api([
      approvalRun(),
      run("r2"),
      run("r3", { state: "merged", bucket: "done" }),
    ]);
    await mountConsole(root, { fetch: a.fetchFn, setInterval: fakeInterval });
    const cards = root.querySelectorAll("[data-card]");
    expect(cards.length).toBe(4);
    expect(
      [...cards].map((c) => c.querySelector(".card-value")!.textContent),
    ).toEqual(["1", "1", "1", "$1.50"]);
  });

  it("stage track has six segments and an aria label", async () => {
    const { root, fakeInterval } = setup();
    const a = api([approvalRun()]);
    await mountConsole(root, { fetch: a.fetchFn, setInterval: fakeInterval });
    const track = root.querySelector("[data-run] [aria-label^='6단계']")!;
    expect(track.children.length).toBe(6);
    expect(track.getAttribute("aria-label")).toBe("6단계 중 5단계: 승인");
  });

  it("selecting a row loads detail", async () => {
    const { root, fakeInterval } = setup();
    const a = api([run("r1", { title: "Detail me" })]);
    await mountConsole(root, { fetch: a.fetchFn, setInterval: fakeInterval });
    root.querySelector<HTMLButtonElement>("[data-run]")!.click();
    await flush();
    expect(a.calls.some((c) => c.url === "/api/runs/r1")).toBe(true);
    expect(root.querySelector("aside")!.textContent).toContain("Detail me");
    expect(root.querySelector("aside ol li")).not.toBeNull();
  });

  it("labels every state in rows and log, cleanup without to_state", async () => {
    const { root, fakeInterval } = setup();
    const a = api([
      run("r1", { state: "pr_opened" }),
      run("r2", { state: "zzz" }),
    ]);
    await mountConsole(root, { fetch: a.fetchFn, setInterval: fakeInterval });
    expect(text(root)).toContain("PR 열림");
    expect(text(root)).toContain("zzz");
    const orig = a.fetchFn;
    const fetchFn = (async (u: string, i?: RequestInit) => {
      const res = await orig(u, i);
      if (u !== "/api/runs/r1") return res;
      const body = await res.json();
      body.events = [
        {
          ts: 1,
          kind: "transition",
          fromState: "queued",
          toState: "pr_opened",
          reasonCode: null,
        },
        {
          ts: 2,
          kind: "cleanup",
          fromState: null,
          toState: null,
          reasonCode: null,
        },
      ];
      return new Response(JSON.stringify(body));
    }) as unknown as typeof fetch;
    const b = setup();
    await mountConsole(b.root, { fetch: fetchFn, setInterval: b.fakeInterval });
    b.root.querySelector<HTMLButtonElement>("[data-run]")!.click();
    await flush();
    const items = [...b.root.querySelectorAll("aside ol li")].map(
      (li) => li.firstElementChild!.textContent,
    );
    expect(items).toEqual(["PR 열림", "정리 작업"]);
  });

  it("scrolls detail into view only after a click on a stacked layout", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    window.matchMedia = ((q: string) => ({
      matches: q === "(max-width: 959px)",
    })) as unknown as typeof window.matchMedia;
    const { root, fakeInterval, tick } = setup();
    const a = api([run("r1")]);
    await mountConsole(root, { fetch: a.fetchFn, setInterval: fakeInterval });
    tick();
    await flush();
    expect(scroll).not.toHaveBeenCalled();
    root.querySelector<HTMLButtonElement>("[data-run]")!.click();
    await flush();
    expect(scroll).toHaveBeenCalledTimes(1);
    tick();
    await flush();
    expect(scroll).toHaveBeenCalledTimes(1);
    // @ts-expect-error remove for environment without matchMedia
    delete window.matchMedia;
    root.querySelector<HTMLButtonElement>("[data-run]")!.click();
    await flush();
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it("refresh every 30 seconds", async () => {
    const { root, fakeInterval, tick, ms } = setup();
    const a = api([run("r1")]);
    await mountConsole(root, { fetch: a.fetchFn, setInterval: fakeInterval });
    expect(ms()).toBe(30000);
    const before = a.calls.filter((c) => c.url === "/api/runs").length;
    tick();
    await flush();
    expect(a.calls.filter((c) => c.url === "/api/runs").length).toBe(
      before + 1,
    );
  });

  it("head_changed shows reload notice", async () => {
    const { root, fakeInterval } = setup();
    const a = api([approvalRun()], "operator", {
      reviewResponse: new Response(JSON.stringify({ error: "head_changed" }), {
        status: 409,
      }),
    });
    await mountConsole(root, { fetch: a.fetchFn, setInterval: fakeInterval });
    root.querySelector<HTMLButtonElement>("[data-run]")!.click();
    await flush();
    buttonByText(root, "승인")!.click();
    await flush();
    expect(text(root)).toContain("커밋이 바뀌었습니다");
  });

  it("missing title shows issue number only", async () => {
    const { root, fakeInterval } = setup();
    const a = api([run("r1", { title: null, issueNumber: 55 })]);
    await mountConsole(root, { fetch: a.fetchFn, setInterval: fakeInterval });
    const row = root.querySelector("[data-run] .row-title")!;
    expect(row.textContent).toBe("이슈 #55");
  });

  it("login link, logout and no mock wording", async () => {
    const { root, fakeInterval } = setup();
    const a = api([run("r1")]);
    await mountConsole(root, { fetch: a.fetchFn, setInterval: fakeInterval });
    expect(root.querySelector("a[href='/api/auth/login']")).not.toBeNull();
    expect(text(root)).not.toContain("예시 데이터");
    expect(text(root)).not.toContain("목업");
    const b = setup();
    const op = api([run("r1")], "operator");
    await mountConsole(b.root, {
      fetch: op.fetchFn,
      setInterval: b.fakeInterval,
    });
    expect(b.root.querySelector("a[href='/api/auth/login']")).toBeNull();
    buttonByText(b.root, "로그아웃")!.click();
    await flush();
    expect(
      op.calls.some((c) => c.url === "/api/auth/logout" && c.method === "POST"),
    ).toBe(true);
  });

  it("shows a notice after returning from review", async () => {
    window.history.replaceState({}, "", "/?run=r1&review=stale");
    const { root, fakeInterval } = setup();
    const a = api([approvalRun()], "operator");
    await mountConsole(root, { fetch: a.fetchFn, setInterval: fakeInterval });
    await flush();
    expect(root.querySelector("[role=status]")?.textContent).toContain(
      "커밋이 바뀌어",
    );
  });
});
