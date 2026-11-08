// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Api, type Me, type RunDetail } from "./api";
import { mountApp } from "./app";

const RUN: RunDetail = {
  run: {
    id: "aaaaaaaaaaa1",
    repo: "acme/demo",
    issueNumber: 7,
    state: "awaiting_approval",
    reasonCode: null,
    prNumber: 40,
    title: null,
    tier: null,
    headSha: "abcdef1234567890",
    cost: {
      status: "not_measured",
      totalUsd: null,
      implementUsd: null,
      reviewUsd: null,
      tokens: null,
    },
    path: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_500_000,
  },
  events: [
    {
      id: 1,
      ts: 1_700_000_000_000,
      kind: "created",
      fromState: null,
      toState: "queued",
      reasonCode: null,
    },
    {
      id: 2,
      ts: 1_700_000_100_000,
      kind: "transition",
      fromState: "queued",
      toState: "cloning",
      reasonCode: null,
    },
    {
      id: 3,
      ts: 1_700_000_200_000,
      kind: "cleanup",
      fromState: null,
      toState: null,
      reasonCode: null,
    },
    {
      id: 4,
      ts: 1_700_000_500_000,
      kind: "transition",
      fromState: "reviewing",
      toState: "awaiting_approval",
      reasonCode: null,
    },
  ],
};

function fakeApi(
  over: Partial<Api> & { user?: Me } = {},
): Api & { calls: string[] } {
  const calls: string[] = [];
  const api: Api = {
    me: async () => over.user ?? { role: "anonymous" },
    projects: async () => ({
      projects: [
        {
          repo: "acme/demo",
          counts: { active: 1, merged: 2, needs_human: 3, failed: 4 },
          attention: 5,
          costUsd: 1.5,
          description: "데모 <b>저장소</b>",
        },
      ],
    }),
    runs: async () => ({ runs: [RUN.run], nextCursor: null }),
    run: async () => RUN,
    stop: async (id) => void calls.push(`stop:${id}`),
    review: async (id, action, sha) => {
      calls.push(`review:${id}:${action}:${sha}`);
      return "https://github.com/login/oauth/authorize?state=s";
    },
    logout: async () => void calls.push("logout"),
    budget: async () => ({
      period: "2026-11",
      runCapUsd: 5,
      mode: "normal",
      providers: {
        anthropic: { limitUsd: 50, spentUsd: 1, exhausted: false },
        openai: { limitUsd: 50, spentUsd: 1, exhausted: false },
      },
    }),
    ...over,
  };
  return Object.assign(api, { calls });
}

const root = () => document.querySelector<HTMLElement>("#app")!;
// Microtasks only, so it also works while fake timers are installed.
const flush = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
};
async function open(
  path: string,
  api: Api,
  startLogin = async () => {},
  navigate: (url: string) => void = () => {},
) {
  window.history.replaceState({}, "", path);
  const app = mountApp(root(), { api, startLogin, navigate });
  await flush();
  return app;
}
const text = () => root().textContent ?? "";
const button = (label: string) =>
  [...root().querySelectorAll("button")].find((b) =>
    b.textContent?.includes(label),
  );

beforeEach(() => {
  document.body.innerHTML = '<main id="app"></main>';
});
afterEach(() => vi.useRealTimers());

describe("home", () => {
  it("explains in plain language what the factory does and how one issue flows", async () => {
    await open("/", fakeApi());
    expect(root().querySelector("h1")?.textContent).toContain(
      "Software Factory",
    );
    const t = text();
    for (const word of ["구현", "교차 리뷰", "프로그램", "사람"])
      expect(t).toContain(word);
    expect(root().querySelectorAll("ol.flow > li")).toHaveLength(4);
  });

  it("lists the projects on the same page, before the explanation", async () => {
    await open("/", fakeApi());
    const link = root().querySelector<HTMLAnchorElement>(
      'a[href="/projects/acme/demo"]',
    );
    expect(link).not.toBeNull();
    const flow = root().querySelector("ol.flow")!;
    expect(
      link!.compareDocumentPosition(flow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(root().querySelector('a[href="/projects"]')).toBeNull();
  });

  it("still opens the same page from the old /projects address", async () => {
    await open("/projects", fakeApi());
    expect(root().querySelector("h1")?.textContent).toContain(
      "Software Factory",
    );
    expect(
      root().querySelector('a[href="/projects/acme/demo"]'),
    ).not.toBeNull();
  });
});

describe("budget notice (stage 5)", () => {
  it("shows on every screen when both accounts reached their limit", async () => {
    const api = fakeApi({
      budget: async () => ({
        period: "2026-11",
        runCapUsd: 5,
        mode: "paused",
        providers: {
          anthropic: { limitUsd: 50, spentUsd: 50, exhausted: true },
          openai: { limitUsd: 50, spentUsd: 48, exhausted: true },
        },
      }),
    });
    await open("/projects", api);
    const notice = root().querySelector(".budget-notice");
    expect(notice?.getAttribute("role")).toBe("alert");
    expect(notice?.textContent).toContain("새 실행을 멈췄습니다");
  });

  it("shows nothing in normal mode or when the budget cannot be read", async () => {
    await open("/", fakeApi());
    expect(root().querySelector(".budget-notice")).toBeNull();
    await open(
      "/",
      fakeApi({
        budget: async () => {
          throw new ApiError(503, "unavailable");
        },
      }),
    );
    expect(root().querySelector(".budget-notice")).toBeNull();
    expect(text()).not.toContain("예산");
  });
});

describe("shell and role badge", () => {
  it("shows an anonymous badge and a login link", async () => {
    await open("/", fakeApi());
    expect(root().querySelector(".role-badge")?.textContent).toContain("익명");
    expect(root().querySelector('a[href="/api/auth/login"]')).not.toBeNull();
    expect(button("로그아웃")).toBeUndefined();
  });

  it("shows the role and login of an observer and an operator, with a logout button", async () => {
    await open("/", fakeApi({ user: { role: "observer", login: "visitor" } }));
    expect(root().querySelector(".role-badge")?.textContent).toContain(
      "옵저버",
    );
    expect(root().querySelector(".role-badge")?.textContent).toContain(
      "visitor",
    );
    await open("/", fakeApi({ user: { role: "operator", login: "boss" } }));
    expect(root().querySelector(".role-badge")?.textContent).toContain(
      "운영자",
    );
    expect(button("로그아웃")).toBeDefined();
  });

  it("logs out through the API and shows the anonymous badge", async () => {
    let me: Me = { role: "observer", login: "visitor" };
    const api = fakeApi({
      logout: async () => void (me = { role: "anonymous" }),
    });
    api.me = async () => me;
    await open("/", api);
    button("로그아웃")!.click();
    await flush();
    expect(root().querySelector(".role-badge")?.textContent).toContain("익명");
  });

  it("starts the login through startLogin instead of following the raw link", async () => {
    const startLogin = vi.fn(async () => {});
    await open("/", fakeApi(), startLogin);
    const link = root().querySelector<HTMLAnchorElement>(
      'a[href="/api/auth/login"]',
    )!;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(startLogin).toHaveBeenCalledOnce();
  });

  it("tells the user when login is not set up", async () => {
    await open("/", fakeApi(), async () => {
      throw new ApiError(503, "auth_not_configured");
    });
    root()
      .querySelector<HTMLAnchorElement>('a[href="/api/auth/login"]')!
      .click();
    await flush();
    expect(root().querySelector('[role="alert"]')?.textContent).toContain(
      "로그인",
    );
    expect(root().querySelector('[role="alert"]')?.textContent).toContain(
      "설정",
    );
  });

  it("shows a failure banner for ?login=failed and removes the parameter from the address", async () => {
    await open("/?login=failed", fakeApi());
    expect(root().querySelector('[role="alert"]')?.textContent).toContain(
      "로그인하지 못했습니다",
    );
    expect(window.location.search).toBe("");
  });
});

describe("projects", () => {
  it("lists projects with counts by outcome and links to each", async () => {
    await open("/projects", fakeApi());
    const link = root().querySelector<HTMLAnchorElement>(
      'a[href="/projects/acme/demo"]',
    );
    expect(link?.textContent).toContain("acme/demo");
    expect(text()).toContain("진행 중");
    expect(text()).toContain("병합");
  });

  it("shows each project's description as plain text, and nothing when it has none", async () => {
    await open("/", fakeApi());
    const desc = root().querySelector(".cards .card .desc");
    expect(desc?.textContent).toBe("데모 <b>저장소</b>");
    expect(desc?.querySelector("b")).toBeNull();
    await open(
      "/",
      fakeApi({
        projects: async () => ({
          projects: [
            {
              repo: "acme/demo",
              counts: { active: 0, merged: 0, needs_human: 0, failed: 0 },
              attention: 0,
              costUsd: 0,
              description: null,
            },
          ],
        }),
      }),
    );
    expect(root().querySelector(".cards .desc")).toBeNull();
  });

  it("shows an empty state", async () => {
    await open(
      "/projects",
      fakeApi({ projects: async () => ({ projects: [] }) }),
    );
    expect(text()).toContain("등록된 프로젝트가 없습니다");
  });

  it("shows an error state with a retry that loads again", async () => {
    let fail = true;
    const api = fakeApi({
      projects: async () => {
        if (fail) throw new ApiError(500, "internal_error");
        return { projects: [] };
      },
    });
    await open("/projects", api);
    expect(root().querySelector('[role="alert"]')?.textContent).toContain(
      "불러오지 못했습니다",
    );
    fail = false;
    button("다시 시도")!.click();
    await flush();
    expect(text()).toContain("등록된 프로젝트가 없습니다");
  });
});

describe("project page", () => {
  it("lists runs with links, and loads the next page on request", async () => {
    const runs = vi
      .fn()
      .mockResolvedValueOnce({ runs: [RUN.run], nextCursor: "1_aaaaaaaaaaa1" })
      .mockResolvedValueOnce({
        runs: [
          { ...RUN.run, id: "aaaaaaaaaaa0", issueNumber: 3, state: "merged" },
        ],
        nextCursor: null,
      });
    await open("/projects/acme/demo", fakeApi({ runs }));
    expect(root().querySelector('a[href="/runs/aaaaaaaaaaa1"]')).not.toBeNull();
    button("더 보기")!.click();
    await flush();
    expect(runs).toHaveBeenLastCalledWith("acme/demo", "1_aaaaaaaaaaa1");
    expect(root().querySelector('a[href="/runs/aaaaaaaaaaa0"]')).not.toBeNull();
    expect(button("더 보기")).toBeUndefined();
  });

  it("shows the state beside the outcome only when it adds something", async () => {
    await open(
      "/projects/acme/demo",
      fakeApi({
        runs: async () => ({
          runs: [
            {
              ...RUN.run,
              id: "aaaaaaaaaaa3",
              state: "merged",
              reasonCode: null,
            },
            {
              ...RUN.run,
              id: "aaaaaaaaaaa4",
              state: "needs_human",
              reasonCode: "changes_requested",
            },
          ],
          nextCursor: null,
        }),
      }),
    );
    const [merged, stopped] = [...root().querySelectorAll(".run-row .status")];
    expect(merged!.querySelector(".muted")).toBeNull();
    expect(stopped!.querySelector(".muted")?.textContent).toBe(
      "사람의 확인 필요",
    );
  });

  it("shows an empty state and a not-found state", async () => {
    await open(
      "/projects/acme/demo",
      fakeApi({ runs: async () => ({ runs: [], nextCursor: null }) }),
    );
    expect(text()).toContain("아직 실행이 없습니다");
    await open(
      "/projects/acme/none",
      fakeApi({
        runs: async () => {
          throw new ApiError(404, "not_found");
        },
      }),
    );
    expect(text()).toContain("찾을 수 없습니다");
  });
});

describe("run detail", () => {
  it("shows the state, the Korean explanation of every event and links to the issue and the PR", async () => {
    await open("/runs/aaaaaaaaaaa1", fakeApi());
    expect(text()).toContain("사람 승인 대기");
    expect(
      root().querySelector('a[href="https://github.com/acme/demo/issues/7"]'),
    ).not.toBeNull();
    expect(
      root().querySelector('a[href="https://github.com/acme/demo/pull/40"]'),
    ).not.toBeNull();
    const items = root().querySelectorAll("ol.timeline > li");
    expect(items).toHaveLength(4);
    expect(items[1]!.textContent).toContain("저장소");
    expect(items[2]!.textContent).toContain("샌드박스");
    for (const a of root().querySelectorAll<HTMLAnchorElement>(
      "a[href^='http']",
    ))
      expect(a.rel).toContain("noopener");
  });

  it("shows merged_outside_factory as finished with no action needed", async () => {
    const detail: RunDetail = {
      run: {
        ...RUN.run,
        state: "needs_human",
        reasonCode: "merged_outside_factory",
      },
      events: [
        ...RUN.events,
        {
          id: 5,
          ts: 1_700_000_900_000,
          kind: "transition",
          fromState: "awaiting_approval",
          toState: "needs_human",
          reasonCode: "merged_outside_factory",
        },
      ],
    };
    await open("/runs/aaaaaaaaaaa1", fakeApi({ run: async () => detail }));
    expect(root().querySelector(".outcome")?.className).toContain("tone-ok");
    expect(root().querySelector(".outcome")?.textContent).toContain("필요 없");
  });

  it("shows what an operator should do for a stopped run", async () => {
    const detail: RunDetail = {
      run: {
        ...RUN.run,
        state: "needs_human",
        reasonCode: "changes_requested",
      },
      events: RUN.events,
    };
    await open("/runs/aaaaaaaaaaa1", fakeApi({ run: async () => detail }));
    const next = root().querySelector(".outcome .next-step");
    expect(next?.textContent).toContain("운영자가 할 일");
    expect(next?.textContent).toContain("직접 병합");
    expect(root().querySelector(".outcome .next-note")?.textContent).toContain(
      "승인해도",
    );
  });

  it("shows no next step for a run that is still moving", async () => {
    await open("/runs/aaaaaaaaaaa1", fakeApi({ run: async () => RUN }));
    expect(root().querySelector(".next-step")).toBeNull();
  });

  it("renders data from the server only as text", async () => {
    const hostile =
      '<img src=x onerror="window.pwned=1"><script>window.pwned=1</script>';
    const detail = {
      run: {
        ...RUN.run,
        repo: "acme/demo",
        state: hostile,
        reasonCode: hostile,
      },
      events: [
        {
          ...RUN.events[0]!,
          kind: hostile,
          toState: hostile,
          reasonCode: hostile,
        },
      ],
    } as unknown as RunDetail;
    await open("/runs/aaaaaaaaaaa1", fakeApi({ run: async () => detail }));
    expect(root().querySelector("img")).toBeNull();
    expect(root().querySelector("script")).toBeNull();
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });

  it("does not link to GitHub for a repository name that is not a plain owner/name", async () => {
    const detail = {
      run: { ...RUN.run, repo: "evil.example/../x?y" },
      events: [],
    };
    await open("/runs/aaaaaaaaaaa1", fakeApi({ run: async () => detail }));
    expect(root().querySelector("a[href^='https://github.com']")).toBeNull();
  });

  it("shows a not-found state and an error state", async () => {
    await open(
      "/runs/zzz",
      fakeApi({
        run: async () => {
          throw new ApiError(404, "not_found");
        },
      }),
    );
    expect(text()).toContain("찾을 수 없습니다");
    await open(
      "/runs/zzz",
      fakeApi({
        run: async () => {
          throw new ApiError(500, "internal_error");
        },
      }),
    );
    expect(text()).toContain("불러오지 못했습니다");
  });
});

describe("stop button", () => {
  const active = fakeApi;
  it("is shown to operators on an active run only", async () => {
    await open(
      "/runs/aaaaaaaaaaa1",
      active({ user: { role: "operator", login: "boss" } }),
    );
    expect(button("실행 중지")).toBeDefined();
    const done: RunDetail = { ...RUN, run: { ...RUN.run, state: "merged" } };
    await open(
      "/runs/aaaaaaaaaaa1",
      active({
        user: { role: "operator", login: "boss" },
        run: async () => done,
      }),
    );
    expect(button("실행 중지")).toBeUndefined();
  });

  it("is not shown to observers or anonymous visitors", async () => {
    await open(
      "/runs/aaaaaaaaaaa1",
      active({ user: { role: "observer", login: "visitor" } }),
    );
    expect(button("실행 중지")).toBeUndefined();
    await open("/runs/aaaaaaaaaaa1", active());
    expect(button("실행 중지")).toBeUndefined();
  });

  it("asks for confirmation, then requests the stop and shows the new state only when the run says so", async () => {
    let state: RunDetail = RUN;
    const api = active({
      user: { role: "operator", login: "boss" },
      run: async () => state,
    });
    api.stop = async (id) => {
      api.calls.push(`stop:${id}`);
    };
    await open("/runs/aaaaaaaaaaa1", api);
    button("실행 중지")!.click();
    await flush();
    expect(api.calls).toEqual([]);
    expect(button("취소")).toBeDefined();
    button("중지 확인")!.click();
    await flush();
    expect(api.calls).toEqual(["stop:aaaaaaaaaaa1"]);
    // The run has not changed yet: the page says requested, not stopped.
    expect(text()).toContain("중지 요청됨");
    expect(text()).not.toContain("운영자가 중지");
    expect(text()).toContain("사람 승인 대기");
    // The server applies it at the next tick; the page re-reads and then shows the state.
    state = {
      ...RUN,
      run: {
        ...RUN.run,
        state: "needs_human",
        reasonCode: "stopped_by_operator",
      },
    };
    button("상태 새로고침")!.click();
    await flush();
    expect(text()).toContain("운영자가 중지");
    expect(button("실행 중지")).toBeUndefined();
  });

  it("after the last poll says the stop has not been applied yet and asks for a refresh", async () => {
    const api = active({ user: { role: "operator", login: "boss" } });
    await open("/runs/aaaaaaaaaaa1", api);
    button("실행 중지")!.click();
    await flush();
    vi.useFakeTimers();
    button("중지 확인")!.click();
    await flush();
    expect(text()).toContain("중지 요청됨");
    vi.advanceTimersByTime(3000 * 21 + 10);
    await flush();
    expect(text()).toContain("아직 적용되지 않았습니다");
    expect(text()).not.toContain("중지 요청됨");
    expect(button("상태 새로고침")).toBeDefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("re-reads the run right after the request and shows a state that already changed", async () => {
    let state: RunDetail = RUN;
    const api = active({
      user: { role: "operator", login: "boss" },
      run: async () => state,
    });
    api.stop = async () => {
      state = {
        ...RUN,
        run: { ...RUN.run, state: "failed", reasonCode: "stopped_by_operator" },
      };
    };
    await open("/runs/aaaaaaaaaaa1", api);
    button("실행 중지")!.click();
    await flush();
    button("중지 확인")!.click();
    await flush();
    expect(text()).toContain("운영자가 중지");
  });

  it("explains a refusal, such as a merge that already started", async () => {
    const api = active({
      user: { role: "operator", login: "boss" },
      stop: async () => {
        throw new ApiError(409, "merge_attempted");
      },
    });
    await open("/runs/aaaaaaaaaaa1", api);
    button("실행 중지")!.click();
    await flush();
    button("중지 확인")!.click();
    await flush();
    expect(root().querySelector('[role="alert"]')?.textContent).toContain(
      "병합",
    );
  });
});

describe("replay", () => {
  it("steps through the events with play and pause", async () => {
    await open("/runs/aaaaaaaaaaa1", fakeApi());
    vi.useFakeTimers();
    expect(root().querySelectorAll("ol.timeline > li")).toHaveLength(4);
    button("처음부터")!.click();
    expect(root().querySelectorAll("ol.timeline > li")).toHaveLength(0);
    button("다음")!.click();
    expect(root().querySelectorAll("ol.timeline > li")).toHaveLength(1);
    button("재생")!.click();
    expect(button("일시정지")).toBeDefined();
    vi.advanceTimersByTime(1500);
    expect(root().querySelectorAll("ol.timeline > li").length).toBeGreaterThan(
      1,
    );
    button("일시정지")!.click();
    const shown = root().querySelectorAll("ol.timeline > li").length;
    vi.advanceTimersByTime(10_000);
    expect(root().querySelectorAll("ol.timeline > li")).toHaveLength(shown);
    expect(root().querySelector(".replay-position")?.textContent).toContain(
      `${shown} / 4`,
    );
  });

  it("stops the timer when the user leaves the run", async () => {
    await open("/runs/aaaaaaaaaaa1", fakeApi());
    vi.useFakeTimers();
    button("재생")!.click();
    root().querySelector<HTMLAnchorElement>('.crumb a[href="/"]')!.click();
    await flush();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("navigation", () => {
  it("handles in-app links without reloading, and shows a not-found page", async () => {
    await open("/projects/acme/demo", fakeApi());
    root().querySelector<HTMLAnchorElement>('.crumb a[href="/"]')!.click();
    await flush();
    expect(window.location.pathname).toBe("/");
    expect(root().querySelector("h1")?.textContent).toContain(
      "Software Factory",
    );
    await open("/nowhere", fakeApi());
    expect(text()).toContain("찾을 수 없습니다");
  });
});

const OPERATOR: Me = { role: "operator", login: "boss" };
const withRun = (over: Partial<RunDetail["run"]>): RunDetail => ({
  ...RUN,
  run: { ...RUN.run, ...over },
});

describe("project page, console", () => {
  const mk = (id: string, state: string, over = {}) => ({
    ...RUN.run,
    id,
    state,
    issueNumber: Number(id.slice(-1)),
    updatedAt: Date.now(),
    ...over,
  });

  it("project page shows attention, active, merged and cost cards", async () => {
    await open("/projects/acme/demo", fakeApi());
    const cards = root().querySelector(".summary")?.textContent ?? "";
    expect(cards).toContain("주의 필요");
    expect(cards).toContain("5");
    expect(cards).toContain("진행 중");
    expect(cards).toContain("병합됨");
    expect(cards).toContain("$1.50");
    await open(
      "/projects/acme/demo",
      fakeApi({
        projects: async () => ({
          projects: [
            {
              repo: "acme/demo",
              counts: { active: 0, merged: 0, needs_human: 0, failed: 0 },
              attention: 0,
              costUsd: null,
            },
          ],
        }),
      }),
    );
    expect(root().querySelector(".summary")?.textContent).toContain(
      "계산 불가",
    );
  });

  it("still lists runs when the project summary cannot be read", async () => {
    await open(
      "/projects/acme/demo",
      fakeApi({
        projects: async () => {
          throw new ApiError(500, "error");
        },
      }),
    );
    expect(root().querySelector('a[href="/runs/aaaaaaaaaaa1"]')).not.toBeNull();
    expect(root().querySelector(".summary")).toBeNull();
  });

  it("runs keep the API's newest-first order, even when an older one needs attention", async () => {
    const runs = async () => ({
      runs: [
        mk("aaaaaaaaaaa1", "merged"),
        mk("aaaaaaaaaaa2", "awaiting_approval"),
      ],
      nextCursor: null,
    });
    await open("/projects/acme/demo", fakeApi({ runs }));
    const ids = [
      ...root().querySelectorAll("li.run-row a[href^='/runs/']"),
    ].map((a) => a.getAttribute("href"));
    expect(ids).toEqual(["/runs/aaaaaaaaaaa1", "/runs/aaaaaaaaaaa2"]);
  });

  it("each run row shows where it stopped on the seven-stage rail", async () => {
    const runs = async () => ({
      runs: [
        mk("aaaaaaaaaaa1", "needs_human", {
          path: [
            { state: "queued", at: 0 },
            { state: "implementing", at: 60_000 },
            { state: "reviewing", at: 120_000 },
            { state: "needs_human", at: 180_000 },
          ],
        }),
      ],
      nextCursor: null,
    });
    await open("/projects/acme/demo", fakeApi({ runs }));
    const cells = [...root().querySelectorAll("li.run-row ol.rail > li")];
    expect(cells).toHaveLength(7);
    expect(cells[3]!.getAttribute("aria-label")).toBe("리뷰: 멈춤, 1분");
    expect(cells[3]!.classList.contains("stopped")).toBe(true);
    expect(cells[6]!.getAttribute("aria-label")).toBe("병합: 도달 전");
  });

  it("the board header counts running and stopped runs per stage", async () => {
    const runs = async () => ({
      runs: [
        mk("aaaaaaaaaaa1", "implementing", {
          path: [{ state: "implementing", at: 0 }],
        }),
        mk("aaaaaaaaaaa2", "failed", {
          path: [
            { state: "implementing", at: 0 },
            { state: "failed", at: 1 },
          ],
        }),
      ],
      nextCursor: null,
    });
    await open("/projects/acme/demo", fakeApi({ runs }));
    const heads = [...root().querySelectorAll(".board-head .stage")];
    expect(heads.map((x) => x.querySelector("strong")?.textContent)).toEqual([
      "접수",
      "구현",
      "PR",
      "리뷰",
      "체크",
      "승인",
      "병합",
    ]);
    expect(heads[1]!.textContent).toContain("진행 1");
    expect(heads[1]!.textContent).toContain("멈춤 1");
    expect(heads[0]!.querySelector(".stage-count")).toBeNull();
  });

  it("the run page draws the same rail and it follows the replay", async () => {
    await open("/runs/aaaaaaaaaaa1", fakeApi());
    const rail = () => [...root().querySelectorAll("ol.rail > li")];
    expect(rail()).toHaveLength(7);
    expect(rail()[5]!.classList.contains("current")).toBe(true);
    button("처음부터")!.click();
    expect(root().querySelector("ol.rail > li.current")).toBeNull();
    button("다음")!.click();
    expect(rail()[0]!.classList.contains("current")).toBe(true);
  });

  it("attention filter", async () => {
    const runs = async () => ({
      runs: [
        mk("aaaaaaaaaaa1", "merged"),
        mk("aaaaaaaaaaa2", "awaiting_approval"),
      ],
      nextCursor: null,
    });
    await open("/projects/acme/demo", fakeApi({ runs }));
    button("주의가 필요한 실행만")!.click();
    expect(root().querySelectorAll("li.run-row")).toHaveLength(1);
    expect(button("주의가 필요한 실행만")!.getAttribute("aria-pressed")).toBe(
      "true",
    );
    button("주의가 필요한 실행만")!.click();
    expect(root().querySelectorAll("li.run-row")).toHaveLength(2);
  });

  it("run row shows tokens and cost, and says when it was not measured", async () => {
    const usage = {
      inputTokens: 10_000,
      outputTokens: 2_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const runs = async () => ({
      runs: [
        mk("aaaaaaaaaaa1", "merged", {
          cost: {
            status: "measured",
            totalUsd: 0.47,
            implementUsd: 0.4,
            reviewUsd: 0.07,
            tokens: {
              implement: usage,
              review: { ...usage, inputTokens: 0, outputTokens: 0 },
            },
          },
        }),
        mk("aaaaaaaaaaa2", "merged"),
      ],
      nextCursor: null,
    });
    await open("/projects/acme/demo", fakeApi({ runs }));
    const lines = [...root().querySelectorAll(".run-cost")];
    expect(lines[0]!.textContent).toBe("토큰 1.2만 · $0.47");
    expect(lines[1]!.textContent).toBe("토큰과 비용 측정 전");
  });

  it("run row shows title and tier", async () => {
    const runs = async () => ({
      runs: [
        mk("aaaaaaaaaaa1", "merged", { title: "로그인 고치기", tier: "T2" }),
      ],
      nextCursor: null,
    });
    await open("/projects/acme/demo", fakeApi({ runs }));
    const row = root().querySelector("li.run-row")!;
    expect(row.textContent).toContain("로그인 고치기");
    expect(row.textContent).toContain("T2");
  });

  it("missing title keeps the issue number", async () => {
    await open("/projects/acme/demo", fakeApi());
    expect(root().querySelector("li.run-row")?.textContent).toContain(
      "이슈 #7",
    );
  });

  it("test_title_is_text: a title with markup is shown as text", async () => {
    const evil = '<img src=x onerror="alert(1)"><script>1</script>';
    const runs = async () => ({
      runs: [mk("aaaaaaaaaaa1", "merged", { title: evil, tier: evil })],
      nextCursor: null,
    });
    await open("/projects/acme/demo", fakeApi({ runs }));
    expect(
      root().querySelector("li.run-row img, li.run-row script"),
    ).toBeNull();
    expect(root().querySelector("li.run-row")?.textContent).toContain(evil);
    await open(
      "/runs/aaaaaaaaaaa1",
      fakeApi({ run: async () => withRun({ title: evil }) }),
    );
    expect(root().querySelector("img, script")).toBeNull();
    expect(text()).toContain(evil);
  });
});

describe("run page, console", () => {
  it("run page shows implement and review cost", async () => {
    const run = withRun({
      cost: {
        status: "measured",
        totalUsd: 0.5,
        implementUsd: 0.4,
        reviewUsd: 0.1,
        tokens: {
          implement: {
            inputTokens: 1000,
            outputTokens: 200,
            cacheReadTokens: 30,
            cacheWriteTokens: 4,
          },
          review: {
            inputTokens: 500,
            outputTokens: 60,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        },
      },
    });
    await open("/runs/aaaaaaaaaaa1", fakeApi({ run: async () => run }));
    const t = root().querySelector(".cost")?.textContent ?? "";
    expect(t).toContain("$0.50");
    expect(t).toContain("$0.40");
    expect(t).toContain("$0.10");
    const rows = [...root().querySelectorAll(".cost tbody tr, .cost tfoot tr")];
    const cells = (r: Element) => [...r.children].map((c) => c.textContent);
    expect(cells(rows[0]!)).toEqual([
      "구현",
      "$0.40",
      "1,000",
      "200",
      "30",
      "4",
    ]);
    expect(cells(rows[1]!)).toEqual(["리뷰", "$0.10", "500", "60", "0", "0"]);
    expect(cells(rows[2]!)).toEqual([
      "합계",
      "$0.50",
      "1,500",
      "260",
      "30",
      "4",
    ]);
    await open("/runs/aaaaaaaaaaa1", fakeApi());
    expect(root().querySelector(".cost")?.textContent).toContain("측정 전");
    const unknown = withRun({
      cost: {
        status: "unknown",
        totalUsd: null,
        implementUsd: null,
        reviewUsd: null,
        tokens: {
          implement: {
            inputTokens: 7,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          review: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        },
      },
    });
    await open("/runs/aaaaaaaaaaa1", fakeApi({ run: async () => unknown }));
    expect(root().querySelector(".cost")?.textContent).toContain("계산 불가");
    expect(root().querySelectorAll(".cost tbody td")[2]?.textContent).toBe("7");
  });
});

describe("approval", () => {
  it("test_approve_operator_only: observer and anonymous see no button", async () => {
    await open("/runs/aaaaaaaaaaa1", fakeApi({ user: OPERATOR }));
    expect(button("승인")).toBeDefined();
    expect(button("수정 요청")).toBeDefined();
    expect(text()).toContain("abcdef1");
    expect(text()).toContain("결정은 운영자 본인의 GitHub 리뷰로 기록됩니다.");
    await open(
      "/runs/aaaaaaaaaaa1",
      fakeApi({ user: { role: "observer", login: "v" } }),
    );
    expect(button("승인")).toBeUndefined();
    expect(button("수정 요청")).toBeUndefined();
    await open("/runs/aaaaaaaaaaa1", fakeApi());
    expect(button("승인")).toBeUndefined();
  });

  it("test_approve_only_awaiting: no box for other states or without a commit", async () => {
    await open(
      "/runs/aaaaaaaaaaa1",
      fakeApi({
        user: OPERATOR,
        run: async () => withRun({ state: "reviewing" }),
      }),
    );
    expect(button("승인")).toBeUndefined();
    await open(
      "/runs/aaaaaaaaaaa1",
      fakeApi({
        user: OPERATOR,
        run: async () => withRun({ headSha: null }),
      }),
    );
    expect(button("승인")).toBeUndefined();
  });

  it("redirect goes to the returned GitHub address only", async () => {
    const navigate = vi.fn();
    const api = fakeApi({ user: OPERATOR });
    await open("/runs/aaaaaaaaaaa1", api, undefined, navigate);
    button("승인")!.click();
    await flush();
    expect(api.calls).toContain("review:aaaaaaaaaaa1:approve:abcdef1234567890");
    expect(navigate).toHaveBeenCalledWith(
      "https://github.com/login/oauth/authorize?state=s",
    );

    const bad = vi.fn();
    await open(
      "/runs/aaaaaaaaaaa1",
      fakeApi({ user: OPERATOR, review: async () => "https://evil.example/x" }),
      undefined,
      bad,
    );
    button("수정 요청")!.click();
    await flush();
    expect(bad).not.toHaveBeenCalled();
    expect(root().querySelector('[role="alert"]')).not.toBeNull();
  });

  it("sends request_changes", async () => {
    const api = fakeApi({ user: OPERATOR });
    await open("/runs/aaaaaaaaaaa1", api);
    button("수정 요청")!.click();
    await flush();
    expect(api.calls).toContain(
      "review:aaaaaaaaaaa1:request_changes:abcdef1234567890",
    );
  });

  it("test_head_changed_notice: explains a moved commit and reloads the run", async () => {
    const run = vi.fn(async () => RUN);
    await open(
      "/runs/aaaaaaaaaaa1",
      fakeApi({
        user: OPERATOR,
        run,
        review: async () => {
          throw new ApiError(409, "head_changed");
        },
      }),
    );
    const before = run.mock.calls.length;
    button("승인")!.click();
    await flush();
    expect(text()).toContain("커밋이 바뀌었습니다");
    expect(run.mock.calls.length).toBeGreaterThan(before);
  });

  it("explains not_awaiting_approval and other failures", async () => {
    await open(
      "/runs/aaaaaaaaaaa1",
      fakeApi({
        user: OPERATOR,
        review: async () => {
          throw new ApiError(409, "not_awaiting_approval");
        },
      }),
    );
    button("승인")!.click();
    await flush();
    expect(text()).toContain("승인을 기다리는 상태가 아닙니다");
    await open(
      "/runs/aaaaaaaaaaa1",
      fakeApi({
        user: OPERATOR,
        review: async () => {
          throw new ApiError(0, "network");
        },
      }),
    );
    button("승인")!.click();
    await flush();
    expect(text()).toContain("시작하지 못했습니다");
  });
});

describe("review notice", () => {
  it("test_review_notice_cleared_on_reload: shows a notice per result and removes the query", async () => {
    const cases: [string, string][] = [
      ["ok", "리뷰를 GitHub에 남겼습니다"],
      ["stale", "커밋이 바뀌어"],
      ["denied", "권한이 없어"],
      ["failed", "리뷰를 남기지 못했습니다"],
    ];
    for (const [code, words] of cases) {
      await open(`/runs/aaaaaaaaaaa1?review=${code}`, fakeApi());
      expect(text()).toContain(words);
      expect(window.location.search).toBe("");
      expect(window.location.pathname).toBe("/runs/aaaaaaaaaaa1");
    }
  });

  it("ignores an unknown value and shows no notice", async () => {
    await open("/runs/aaaaaaaaaaa1?review=<b>x</b>", fakeApi());
    expect(root().querySelector(".message")).toBeNull();
    expect(root().querySelector("b")).toBeNull();
  });
});
