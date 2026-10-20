// GA4 동의 상태 관리. roboco-io/the-software-factory의 website/src/lib/analytics.mjs를 옮겨 왔다.
// 동의(granted)가 유효할 때만 enable()을 호출하고, 거절·철회·만료 시 disable()을 호출한다.
// 이 데모에는 책 전용 맞춤 이벤트가 없으므로 이벤트 전송(track) 부분은 옮기지 않았다.

export const CONSENT_KEY = "software-factory-demo.analytics.v1";
export const CONSENT_TTL = 180 * 24 * 60 * 60 * 1000;

export type ConsentChoice = "granted" | "denied";

export interface ConsentStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

interface ConsentRecord {
  version: 1;
  choice: ConsentChoice;
  updatedAt: number;
}

export interface AnalyticsState {
  configured: boolean;
  choice: ConsentChoice | null;
  active: boolean;
}

export interface AnalyticsOptions {
  measurementId: string;
  hostname: string;
  siteHostname: string;
  getStorage: () => ConsentStore | null | undefined;
  getBackupStorage?: () => ConsentStore | null | undefined;
  now?: () => number;
  enable: () => void;
  disable: () => void;
}

// 쿼리와 fragment(HashRouter 경로 포함)를 뺀 origin + pathname만 GA에 보낸다.
export function safePageUrl(value: string): string {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? url.origin + url.pathname : "";
  } catch {
    return "";
  }
}

export function createAnalytics({
  measurementId,
  hostname,
  siteHostname,
  getStorage,
  getBackupStorage = () => null,
  now = Date.now,
  enable,
  disable,
}: AnalyticsOptions) {
  const configured = /^G-[A-Z0-9]{6,}$/.test(measurementId) && hostname === siteHostname;
  let active = false;
  let memory: ConsentRecord | null = null;
  const writableGrants = new WeakSet<ConsentStore>();

  function valid(item: unknown): item is ConsentRecord {
    const record = item as Partial<ConsentRecord> | null;
    return (
      record?.version === 1 &&
      (record.choice === "granted" || record.choice === "denied") &&
      typeof record.updatedAt === "number" &&
      Number.isFinite(record.updatedAt) &&
      record.updatedAt <= now() &&
      now() - record.updatedAt < CONSENT_TTL
    );
  }

  function choice(): ConsentChoice | null {
    const records: ConsentRecord[] = valid(memory) ? [memory] : [];
    for (const get of [getStorage, getBackupStorage]) {
      try {
        const store = get();
        const item: unknown = JSON.parse(store?.getItem(CONSENT_KEY) ?? "null");
        if (!valid(item)) continue;
        if (item.choice === "granted" && store && !writableGrants.has(store)) {
          // 복원한 동의를 나중에 철회할 수 있는 저장소인지 확인한다. 쓸 수 없으면 fail closed.
          store.setItem(CONSENT_KEY + ".probe", "1");
          store.removeItem?.(CONSENT_KEY + ".probe");
          writableGrants.add(store);
        }
        records.push(item);
      } catch {
        /* fail closed when a restored grant cannot be updated or withdrawn */
      }
    }
    records.sort((a, b) => b.updatedAt - a.updatedAt || (a.choice === "denied" ? -1 : 1));
    return records[0]?.choice ?? null;
  }

  function sync(resetMemory = false): AnalyticsState {
    if (resetMemory) memory = null;
    const current = choice();
    const allowed = configured && current === "granted";
    if (allowed && !active) {
      active = true;
      enable();
    } else if (!allowed && active) {
      active = false;
      disable();
    }
    return { configured, choice: current, active };
  }

  function choose(value: ConsentChoice): AnalyticsState {
    const item: ConsentRecord = { version: 1, choice: value, updatedAt: now() };
    memory = null;
    for (const get of [getStorage, getBackupStorage]) {
      let store: ConsentStore | null | undefined;
      try {
        store = get();
        if (!store) continue;
        store.setItem(CONSENT_KEY, JSON.stringify(item));
      } catch {
        memory = item;
        if (value === "denied") {
          try {
            store?.removeItem?.(CONSENT_KEY);
          } catch {
            /* backup refusal remains authoritative */
          }
        }
      }
    }
    return sync();
  }

  return { sync, choose };
}
