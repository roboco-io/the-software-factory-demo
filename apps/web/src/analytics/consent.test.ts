import { describe, expect, it } from "vitest";
import {
  CONSENT_KEY,
  CONSENT_TTL,
  createAnalytics,
  safePageUrl,
  type AnalyticsOptions,
  type ConsentStore,
} from "./consent";

// roboco-io/the-software-factory의 website/tests/analytics.test.mjs 중 동의 관련 시나리오를 옮겼다.
function setup(options: Partial<AnalyticsOptions> = {}) {
  const records = new Map<string, string>();
  const calls: string[] = [];
  let time = 100000000;
  const storage: ConsentStore = {
    getItem: (k) => records.get(k) ?? null,
    setItem: (k, v) => void records.set(k, v),
    removeItem: (k) => void records.delete(k),
  };
  const analytics = createAnalytics({
    measurementId: "G-ABC1234567",
    hostname: "roboco.io",
    siteHostname: "roboco.io",
    getStorage: () => storage,
    now: () => time,
    enable: () => calls.push("enable"),
    disable: () => calls.push("disable"),
    ...options,
  });
  return { analytics, records, calls, advance: () => (time += CONSENT_TTL + 1) };
}

const grant = JSON.stringify({ version: 1, choice: "granted", updatedAt: 100000000 });

describe("analytics consent", () => {
  it("never starts before consent and refusal keeps it off", () => {
    const s = setup();
    expect(s.analytics.sync()).toEqual({ configured: true, choice: null, active: false });
    s.analytics.choose("denied");
    expect(s.calls).toEqual([]);
    expect(s.analytics.sync().choice).toBe("denied");
  });

  it("grant starts once and withdrawal disables", () => {
    const s = setup();
    s.analytics.choose("granted");
    s.analytics.choose("granted");
    expect(s.calls).toEqual(["enable"]);
    s.analytics.choose("denied");
    expect(s.calls.at(-1)).toBe("disable");
  });

  it("restores only valid consent; expiry and removal stop collection", () => {
    const s = setup();
    s.analytics.choose("granted");
    s.advance();
    expect(s.analytics.sync().choice).toBeNull();
    expect(s.calls.at(-1)).toBe("disable");
    const t = setup();
    t.analytics.choose("granted");
    t.records.delete(CONSENT_KEY);
    expect(t.analytics.sync().choice).toBeNull();
    expect(t.calls.at(-1)).toBe("disable");
    const u = setup();
    u.records.set(CONSENT_KEY, grant);
    u.analytics.sync();
    expect(u.calls).toEqual(["enable"]);
  });

  it("bad config or other hosts never activate; corrupt storage is not consent", () => {
    for (const options of [
      { measurementId: "" },
      { measurementId: "not-an-id" },
      { hostname: "localhost" },
    ]) {
      const s = setup(options);
      s.analytics.choose("granted");
      expect(s.calls).toEqual([]);
      expect(s.analytics.sync().configured).toBe(false);
    }
    const s = setup();
    s.records.set(CONSENT_KEY, "broken");
    expect(s.analytics.sync().choice).toBeNull();
    expect(s.calls).toEqual([]);
  });

  it("blocked storage still honours an explicit choice for the current document", () => {
    const s = setup({
      getStorage: () => {
        throw Error("blocked");
      },
    });
    expect(s.analytics.sync().choice).toBeNull();
    s.analytics.choose("granted");
    expect(s.calls).toEqual(["enable"]);
    s.analytics.choose("denied");
    expect(s.calls.at(-1)).toBe("disable");
  });

  it("backup refusal wins even if the old primary grant cannot be deleted", () => {
    const backup = new Map<string, string>();
    const options: Partial<AnalyticsOptions> = {
      getStorage: () => ({
        getItem: () => grant,
        setItem: () => {
          throw Error("read only");
        },
        removeItem: () => {
          throw Error("read only");
        },
      }),
      getBackupStorage: () => ({
        getItem: (k) => backup.get(k) ?? null,
        setItem: (k, v) => void backup.set(k, v),
      }),
    };
    const s = setup(options);
    s.analytics.choose("denied");
    expect(s.analytics.sync().active).toBe(false);
    const reload = setup(options);
    expect(reload.analytics.sync().choice).toBe("denied");
    expect(reload.calls).toEqual([]);
  });

  it("restored grants fail closed when consent storage is read-only", () => {
    const s = setup({
      getStorage: () => ({
        getItem: () => grant,
        setItem: () => {
          throw Error("read only");
        },
      }),
    });
    expect(s.analytics.sync().active).toBe(false);
    expect(s.calls).toEqual([]);
  });

  it("page URLs exclude query strings and hash routes", () => {
    expect(
      safePageUrl("https://roboco.io/the-software-factory-demo/?email=x#/article/secret"),
    ).toBe("https://roboco.io/the-software-factory-demo/");
    expect(safePageUrl("javascript:alert(1)")).toBe("");
  });
});
