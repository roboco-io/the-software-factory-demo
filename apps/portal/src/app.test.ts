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
        },
      ],
    }),
    runs: async () => ({ runs: [RUN.run], nextCursor: null }),
    run: async () => RUN,
    stop: async (id) => void calls.push(`stop:${id}`),
    logout: async () => void calls.push("logout"),
    ...over,
  };
  return Object.assign(api, { calls });
}

const root = () => document.querySelector<HTMLElement>("#app")!;
// Microtasks only, so it also works while fake timers are installed.
const flush = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
};
async function open(path: string, api: Api, startLogin = async () => {}) {
  window.history.replaceState({}, "", path);
  const app = mountApp(root(), { api, startLogin });
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
    expect(root().querySelector('a[href="/projects"]')).not.toBeNull();
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
    root().querySelector<HTMLAnchorElement>('a[href="/projects"]')!.click();
    await flush();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("navigation", () => {
  it("handles in-app links without reloading, and shows a not-found page", async () => {
    await open("/", fakeApi());
    root().querySelector<HTMLAnchorElement>('a[href="/projects"]')!.click();
    await flush();
    expect(window.location.pathname).toBe("/projects");
    expect(root().querySelector("h1")?.textContent).toContain("프로젝트");
    await open("/nowhere", fakeApi());
    expect(text()).toContain("찾을 수 없습니다");
  });
});
