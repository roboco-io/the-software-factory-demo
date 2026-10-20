// 동의 배너와 GA4 로더. roboco-io/the-software-factory의 website/src/scripts/analytics.ts와
// BookAnalytics.astro를 옮겨 왔다. 방문자가 "통계 수집에 동의"를 누르기 전에는
// googletagmanager.com을 요청하지 않는다. 운영 원칙은 the-software-factory의 website/ANALYTICS.md를 따른다.
import "./analytics.css";
import {
  CONSENT_KEY,
  CONSENT_TTL,
  createAnalytics,
  safePageUrl,
  type ConsentStore,
} from "./consent";

// factory.roboco.io와 같은 GA4 속성. Vite 환경변수로 바꿀 수 있다.
export const MEASUREMENT_ID: string = import.meta.env.VITE_GA_MEASUREMENT_ID ?? "G-VPLZXJ5P05";
export const SITE_HOSTNAME = "roboco.io";
// 데모 전용 쿠키 접두어. roboco.io 홈페이지의 _ga 쿠키는 건드리지 않는다.
const COOKIE_PREFIX = "sfdemo";

type AnalyticsWindow = Window & { dataLayer?: unknown[]; gtag?: (...args: unknown[]) => void };

function button(label: string, attr: string, className: string): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = className;
  el.textContent = label;
  el.setAttribute(attr, "");
  return el;
}

function render(): HTMLElement {
  const root = document.createElement("div");
  root.className = "analytics-root";
  root.setAttribute("data-analytics-root", "");

  const banner = document.createElement("aside");
  banner.className = "analytics-banner";
  banner.hidden = true;
  banner.setAttribute("data-analytics-banner", "");
  banner.setAttribute("aria-label", "이용 통계 수집 선택");
  const text = document.createElement("p");
  const strong = document.createElement("strong");
  strong.textContent = "데모를 개선하는 데 이용 통계를 활용합니다.";
  text.append(
    strong,
    " 동의하면 Google Analytics가 페이지 방문과 화면 이용을 측정하고 쿠키를 사용합니다. 주소의 쿼리와 # 뒤 경로는 보내지 않으며, Google signals와 광고 개인화는 사용하지 않습니다. 동의하지 않아도 데모의 모든 기능을 이용할 수 있습니다.",
  );
  const actions = document.createElement("div");
  actions.className = "analytics-actions";
  actions.append(
    button("동의하지 않음", "data-analytics-deny", "analytics-button"),
    button("통계 수집에 동의", "data-analytics-allow", "analytics-button"),
  );
  banner.append(text, actions);

  const settings = document.createElement("div");
  settings.className = "analytics-settings";
  const status = document.createElement("span");
  status.setAttribute("data-analytics-status", "");
  status.setAttribute("role", "status");
  settings.append(button("통계 설정", "data-analytics-open", "analytics-quiet"), status);

  root.append(banner, settings);
  return root;
}

export function mountAnalytics(
  measurementId: string = MEASUREMENT_ID,
  siteHostname: string = SITE_HOSTNAME,
): void {
  const win = window as AnalyticsWindow;
  // PR 미리보기(gh-pages의 pr-preview/)와 로컬 실행에서는 GA를 켜지 않는다.
  const hostname = location.pathname.includes("/pr-preview/") ? "" : location.hostname;
  let loaded = false;
  const gtag = (...args: unknown[]) => win.gtag?.(...args);
  let consentChannel: BroadcastChannel | undefined;
  try {
    consentChannel = new BroadcastChannel("software-factory-demo.analytics-consent");
  } catch {
    /* optional cross-tab notification */
  }

  function eraseAnalyticsCookies() {
    const parts = location.hostname.split(".");
    const domains = ["", ...parts.slice(0, -1).map((_, i) => "." + parts.slice(i).join("."))];
    const pattern = new RegExp(`^${COOKIE_PREFIX}_ga(?:_|$)`);
    for (const cookie of document.cookie.split(";")) {
      const name = cookie.trim().split("=")[0] ?? "";
      if (!pattern.test(name)) continue;
      for (const domain of domains)
        document.cookie = `${name}=; Max-Age=0; Path=/;${domain ? " Domain=" + domain + ";" : ""} SameSite=Lax`;
    }
  }

  const cookieName = (key: string) =>
    key === CONSENT_KEY ? `${COOKIE_PREFIX}_consent` : `${COOKIE_PREFIX}_consent_probe`;
  // localStorage를 쓸 수 없을 때를 대비해 같은 선택을 데모 전용 동의 쿠키에도 보존한다.
  const backupStorage: ConsentStore = {
    getItem(key) {
      const name = cookieName(key) + "=";
      const raw = document.cookie
        .split(";")
        .map((x) => x.trim())
        .find((x) => x.startsWith(name))
        ?.slice(name.length);
      return raw ? decodeURIComponent(raw) : null;
    },
    setItem(key, value) {
      const seconds =
        key === CONSENT_KEY
          ? Math.max(
              0,
              Math.ceil(
                ((JSON.parse(value) as { updatedAt: number }).updatedAt +
                  CONSENT_TTL -
                  Date.now()) /
                  1000,
              ),
            )
          : 60;
      document.cookie = `${cookieName(key)}=${encodeURIComponent(value)}; Max-Age=${seconds}; Path=/; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
      if (this.getItem(key) !== value) throw Error("Consent cookie unavailable");
    },
    removeItem(key) {
      document.cookie = `${cookieName(key)}=; Max-Age=0; Path=/; SameSite=Lax`;
    },
  };

  const root = render();
  const banner = root.querySelector<HTMLElement>("[data-analytics-banner]")!;
  const status = root.querySelector<HTMLElement>("[data-analytics-status]")!;
  const open = root.querySelector<HTMLButtonElement>("[data-analytics-open]")!;

  const analytics = createAnalytics({
    measurementId,
    hostname,
    siteHostname,
    getStorage: () => localStorage,
    getBackupStorage: () => backupStorage,
    enable() {
      loaded = true;
      Reflect.set(win, `ga-disable-${measurementId}`, false);
      win.dataLayer = [];
      win.gtag = function () {
        // gtag.js는 arguments 객체를 그대로 받아야 한다.
        // eslint-disable-next-line prefer-rest-params
        win.dataLayer!.push(arguments);
      };
      const denied = { ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" };
      gtag("consent", "default", { analytics_storage: "denied", ...denied });
      gtag("js", new Date());
      gtag("consent", "update", { analytics_storage: "granted", ...denied });
      let referrer = "";
      try {
        referrer = new URL(document.referrer).origin;
      } catch {
        /* no valid referrer */
      }
      gtag("config", measurementId, {
        send_page_view: true,
        allow_google_signals: false,
        allow_ad_personalization_signals: false,
        page_location: safePageUrl(location.href),
        page_referrer: referrer,
        cookie_prefix: COOKIE_PREFIX,
        cookie_domain: location.hostname,
        cookie_expires: 15552000,
        cookie_update: false,
        cookie_flags: "SameSite=Lax;Secure",
      });
      const script = document.createElement("script");
      script.async = true;
      script.dataset.googleAnalytics = "";
      script.src = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
      script.onerror = () => {
        status.textContent = "통계 도구를 불러오지 못했습니다. 데모는 계속 이용할 수 있습니다.";
      };
      document.head.append(script);
    },
    disable() {
      Reflect.set(win, `ga-disable-${measurementId}`, true);
      win.dataLayer = [];
      eraseAnalyticsCookies();
      document.querySelector("[data-google-analytics]")?.remove();
      // 동의 철회·만료 뒤 SDK와 자동 수집 리스너를 내리기 위해 문서를 다시 불러온다.
      if (loaded) location.reload();
    },
  });

  // 수집 대상이 아닌 환경(로컬, PR 미리보기 등)에서는 배너와 설정 버튼을 그리지 않는다.
  if (!analytics.sync().configured) return;
  document.body.append(root);

  function refresh(show = false) {
    const state = analytics.sync();
    banner.hidden = !show && state.choice !== null;
    status.textContent =
      state.choice === "granted"
        ? "통계 수집 동의됨"
        : state.choice === "denied"
          ? "통계 수집 거절됨"
          : "아직 선택하지 않았습니다.";
  }
  function choose(choice: "granted" | "denied") {
    analytics.choose(choice);
    consentChannel?.postMessage("changed");
    refresh();
    open.focus();
  }
  consentChannel?.addEventListener("message", () => {
    analytics.sync(true);
    refresh();
  });
  root.querySelector("[data-analytics-allow]")!.addEventListener("click", () => choose("granted"));
  root.querySelector("[data-analytics-deny]")!.addEventListener("click", () => choose("denied"));
  open.addEventListener("click", () => {
    refresh(true);
    root.querySelector<HTMLButtonElement>("[data-analytics-deny]")?.focus();
  });
  window.addEventListener("storage", (event) => {
    if (event.key === CONSENT_KEY || event.key === null) {
      analytics.sync(true);
      refresh();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });
  refresh();
}
