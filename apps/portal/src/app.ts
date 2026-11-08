import { ApiError, type Api, type Me } from "./api";
import { budgetNotice } from "./budget-notice";
import { h, link } from "./dom";
import { matchRoute } from "./router";
import {
  homeView,
  messageBox,
  notFoundView,
  projectView,
  runView,
  type View,
  type ViewContext,
} from "./views";

export interface AppOptions {
  api: Api;
  /** Starts the GitHub sign-in. Rejects with an ApiError when sign-in is not set up. */
  startLogin(): Promise<void>;
  /** Sends the browser to an address outside the portal. Defaults to `window.location.assign`. */
  navigate?(url: string): void;
}

const REVIEW_NOTICES: Record<string, ["alert" | "status", string]> = {
  ok: [
    "status",
    "리뷰를 GitHub에 남겼습니다. 병합 여부는 프로그램이 다시 판정합니다.",
  ],
  stale: [
    "alert",
    "승인하는 사이 PR의 커밋이 바뀌어 리뷰를 남기지 않았습니다. 새 커밋을 확인한 뒤 다시 결정해 주세요.",
  ],
  denied: [
    "alert",
    "이 GitHub 계정에는 승인 권한이 없어 리뷰를 남기지 않았습니다.",
  ],
  failed: ["alert", "리뷰를 남기지 못했습니다. 잠시 뒤 다시 시도해 주세요."],
};

const ROLE_LABELS = {
  anonymous: "익명",
  observer: "옵저버",
  operator: "운영자",
} as const;

const mounted = new WeakMap<HTMLElement, () => void>();

/** Draws the portal into `root` and handles navigation. Returns a function that removes it. */
export function mountApp(root: HTMLElement, options: AppOptions): () => void {
  mounted.get(root)?.();
  const { api } = options;

  let me: Me = { role: "anonymous" };
  let banner: string | null = null;
  let bannerKind: "alert" | "status" = "alert";
  let cleanup: (() => void) | undefined;
  let generation = 0;
  let alive = true;

  const roleArea = h("div", { class: "who" });
  const bannerSlot = h("div");
  const budgetSlot = h("div");
  const main = h("main", { id: "main" });
  const header = h(
    "header",
    { class: "top" },
    link("/", "Software Factory"),
    roleArea,
  );
  root.replaceChildren(header, budgetSlot, bannerSlot, main);

  /** Stage 5: a notice while the budget limits the factory. Nothing when it cannot be read. */
  async function paintBudget() {
    let notice: ReturnType<typeof budgetNotice> = null;
    try {
      notice = budgetNotice(await api.budget());
    } catch {
      notice = null;
    }
    if (!alive) return;
    budgetSlot.replaceChildren(
      ...(notice === null
        ? []
        : [
            h(
              "div",
              {
                class: `message ${notice.kind} budget-notice`,
                role: notice.kind,
              },
              notice.text,
            ),
          ]),
    );
  }

  function paintBanner() {
    if (banner === null) return bannerSlot.replaceChildren();
    const close = h("button", { type: "button", class: "link" }, "닫기");
    close.addEventListener("click", () => {
      banner = null;
      paintBanner();
    });
    bannerSlot.replaceChildren(
      h(
        "div",
        { class: `message ${bannerKind}`, role: bannerKind },
        banner,
        " ",
        close,
      ),
    );
  }

  function paintRole() {
    const badge = h(
      "span",
      { class: `role-badge role-${me.role}` },
      me.login === undefined
        ? ROLE_LABELS[me.role]
        : `${ROLE_LABELS[me.role]} · ${me.login}`,
    );
    if (me.role === "anonymous") {
      const login = h(
        "a",
        { href: "/api/auth/login", class: "button" },
        "GitHub로 로그인",
      );
      login.addEventListener("click", (event) => {
        event.preventDefault();
        options.startLogin().catch((error: unknown) => {
          banner =
            error instanceof ApiError && error.code === "auth_not_configured"
              ? "로그인 설정이 아직 되어 있지 않아 로그인할 수 없습니다. 운영자에게 알려 주세요."
              : "로그인을 시작하지 못했습니다. 잠시 뒤 다시 시도해 주세요.";
          paintBanner();
        });
      });
      roleArea.replaceChildren(badge, login);
      return;
    }
    const out = h("button", { type: "button" }, "로그아웃");
    out.addEventListener("click", () => {
      api.logout().then(
        () => refreshMe().then(() => render()),
        () => {
          banner = "로그아웃하지 못했습니다. 잠시 뒤 다시 시도해 주세요.";
          paintBanner();
        },
      );
    });
    roleArea.replaceChildren(badge, out);
  }

  async function refreshMe() {
    try {
      me = await api.me();
    } catch {
      me = { role: "anonymous" };
    }
    paintRole();
  }

  function show(view: View) {
    cleanup?.();
    cleanup = view.cleanup;
    document.title = `${view.title} - Software Factory`;
    main.replaceChildren(view.el);
    main.removeAttribute("aria-busy");
  }

  async function render() {
    const mine = ++generation;
    cleanup?.();
    cleanup = undefined;
    main.setAttribute("aria-busy", "true");
    main.replaceChildren(
      h("p", { class: "muted", role: "status" }, "불러오는 중입니다..."),
    );
    const route = matchRoute(window.location.pathname);
    const context: ViewContext = {
      api,
      me,
      reload: () => void render(),
      notify: (kind, text) => {
        banner = text;
        bannerKind = kind;
        paintBanner();
      },
      navigate: (url) =>
        (options.navigate ?? ((u) => window.location.assign(u)))(url),
    };
    try {
      let view: View;
      switch (route.name) {
        case "home":
          view = await homeView(context);
          break;
        case "project":
          view = await projectView(context, route.repo);
          break;
        case "run":
          view = await runView(context, route.id);
          break;
        default:
          view = notFoundView();
      }
      if (mine === generation && alive) show(view);
      else view.cleanup?.();
    } catch (error) {
      if (mine !== generation || !alive) return;
      if (error instanceof ApiError && error.status === 404) {
        show(notFoundView());
        return;
      }
      const retry = h("button", { type: "button" }, "다시 시도");
      retry.addEventListener("click", () => void render());
      show({
        title: "오류",
        el: h(
          "section",
          null,
          messageBox(
            "alert",
            "내용을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.",
          ),
          retry,
        ),
      });
    }
  }

  function go(path: string) {
    window.history.pushState(null, "", path);
    banner = null;
    bannerKind = "alert";
    paintBanner();
    void render();
  }

  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>(
      "a[data-link]",
    );
    if (anchor === null || anchor === undefined) return;
    event.preventDefault();
    const url = new URL(anchor.href, window.location.href);
    if (url.origin === window.location.origin) go(url.pathname);
  };
  const onPop = () => void render();
  root.addEventListener("click", onClick);
  window.addEventListener("popstate", onPop);

  if (new URLSearchParams(window.location.search).get("login") === "failed") {
    banner =
      "로그인하지 못했습니다. 다시 시도해 주세요. 계속 실패하면 운영자에게 알려 주세요.";
    // Remove the marker so a reload does not show it again.
    window.history.replaceState(null, "", window.location.pathname);
  }
  const reviewResult = new URLSearchParams(window.location.search).get(
    "review",
  );
  if (reviewResult !== null && Object.hasOwn(REVIEW_NOTICES, reviewResult)) {
    [bannerKind, banner] = REVIEW_NOTICES[reviewResult]!;
    window.history.replaceState(null, "", window.location.pathname);
  }
  paintBanner();
  paintRole();
  void paintBudget();
  void refreshMe().then(() => render());

  const destroy = () => {
    alive = false;
    generation++;
    cleanup?.();
    root.removeEventListener("click", onClick);
    window.removeEventListener("popstate", onPop);
    mounted.delete(root);
  };
  mounted.set(root, destroy);
  return destroy;
}
