import { ApiError, type Api, type Me } from "./api";
import { h, link } from "./dom";
import { matchRoute } from "./router";
import {
  homeView,
  messageBox,
  notFoundView,
  projectView,
  projectsView,
  runView,
  type View,
  type ViewContext,
} from "./views";

export interface AppOptions {
  api: Api;
  /** Starts the GitHub sign-in. Rejects with an ApiError when sign-in is not set up. */
  startLogin(): Promise<void>;
}

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
  let cleanup: (() => void) | undefined;
  let generation = 0;
  let alive = true;

  const roleArea = h("div", { class: "who" });
  const bannerSlot = h("div");
  const main = h("main", { id: "main" });
  const nav = h(
    "nav",
    { "aria-label": "주 메뉴" },
    link("/", "홈"),
    link("/projects", "프로젝트"),
  );
  const header = h(
    "header",
    { class: "top" },
    link("/", "Software Factory"),
    nav,
    roleArea,
  );
  root.replaceChildren(header, bannerSlot, main);

  function paintBanner() {
    if (banner === null) return bannerSlot.replaceChildren();
    const close = h("button", { type: "button", class: "link" }, "닫기");
    close.addEventListener("click", () => {
      banner = null;
      paintBanner();
    });
    bannerSlot.replaceChildren(
      h("div", { class: "message alert", role: "alert" }, banner, " ", close),
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
    const context: ViewContext = { api, me, reload: () => void render() };
    try {
      let view: View;
      switch (route.name) {
        case "home":
          view = homeView(me);
          break;
        case "projects":
          view = await projectsView(context);
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
  paintBanner();
  paintRole();
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
