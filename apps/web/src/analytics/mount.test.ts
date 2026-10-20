import { afterEach, describe, expect, it } from "vitest";
import { CONSENT_KEY } from "./consent";
import { mountAnalytics } from "./mount";

const gaScript = () => document.querySelector('script[src*="googletagmanager.com"]');

afterEach(() => {
  document.body.replaceChildren();
  document.head.querySelectorAll("[data-google-analytics]").forEach((el) => el.remove());
  localStorage.clear();
  for (const c of document.cookie.split(";"))
    document.cookie = `${c.trim().split("=")[0]}=; Max-Age=0; Path=/`;
});

describe("mountAnalytics", () => {
  it("renders nothing and loads nothing outside the production host", () => {
    mountAnalytics("G-TEST123456", "roboco.io");
    expect(document.querySelector("[data-analytics-root]")).toBeNull();
    expect(gaScript()).toBeNull();
  });

  it("loads gtag.js only after the visitor accepts", () => {
    mountAnalytics("G-TEST123456", location.hostname);
    const banner = document.querySelector<HTMLElement>("[data-analytics-banner]")!;
    expect(banner.hidden).toBe(false);
    expect(gaScript()).toBeNull();

    document.querySelector<HTMLButtonElement>("[data-analytics-allow]")!.click();
    expect(gaScript()?.getAttribute("src")).toBe(
      "https://www.googletagmanager.com/gtag/js?id=G-TEST123456",
    );
    expect(banner.hidden).toBe(true);
    expect(JSON.parse(localStorage.getItem(CONSENT_KEY)!).choice).toBe("granted");
    const config = ((window as Window & { dataLayer?: IArguments[] }).dataLayer ?? [])
      .map((a) => Array.from(a))
      .find((a) => a[0] === "config");
    expect(config?.[2]).toMatchObject({
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      cookie_prefix: "sfdemo",
    });
  });

  it("refusal keeps Google unloaded", () => {
    mountAnalytics("G-TEST123456", location.hostname);
    document.querySelector<HTMLButtonElement>("[data-analytics-deny]")!.click();
    expect(gaScript()).toBeNull();
    expect(document.querySelector("[data-analytics-status]")!.textContent).toBe("통계 수집 거절됨");
  });
});
