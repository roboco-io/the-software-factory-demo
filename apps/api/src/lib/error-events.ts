import { eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../db/client";
import { errorEvents } from "../db/schema";
import type { Env } from "../env";
import { sha256Hex } from "./hash";

export const MESSAGE_MAX = 500;
export const PATH_MAX = 200;
// 공개 이슈 폭주를 막는 상한: 미확인(acked_at이 없거나 last_seen보다 이전인) 행이 이만큼 쌓이면
// 새 fingerprint는 기록하지 않는다. 확인된 행은 세지 않고, 기존 fingerprint는 항상 갱신한다.
export const ERROR_EVENTS_CAP = 500;

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// 슬러그 형식(하이픈으로 이은 소문자·숫자 단어 + 6자 접미사). 옛 RealWorld 글 주소가 메시지에 섞여도 가린다.
const SLUG = /\b[a-z0-9]+(?:-[a-z0-9]+)*-[a-z0-9]{6}\b/g;
const NUMBER = /\d+/g;
// 요청 본문 조각(JSON 파싱 오류 등)이 메시지에 섞일 수 있으므로 개별 값을 가린다.
const QUOTED = /"[^"]*"|'[^']*'/g;
const EMAIL = /\S+@\S+\.\S+/g;
const JWT = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.?[A-Za-z0-9_-]*/g;
const LONG_RUN = /[A-Za-z0-9_-]{20,}/g;

// UUID는 긴 문자열 규칙보다 먼저 {uuid}로 바꿔 구분을 유지한다.
export function normalizeText(s: string): string {
  return s
    .replace(QUOTED, "{str}")
    .replace(EMAIL, "{email}")
    .replace(JWT, "{token}")
    .replace(UUID, "{uuid}")
    .replace(LONG_RUN, "{token}")
    .replace(SLUG, "{slug}")
    .replace(NUMBER, "{n}");
}

// 배포마다 번들의 줄·열이 바뀌므로 위치는 지우고 함수·파일만 남긴다.
// V8은 await 뒤의 프레임에 `async`를 붙이므로(`at async f`) 앞의 `async `도 지운다.
export function topFrames(stack: string | undefined, n = 3): string[] {
  return (stack ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("at "))
    .slice(0, n)
    .map((l) => l.replace(/^at async /, "at ").replace(/:\d+(?::\d+)?(\)?)$/, "$1"));
}

export async function errorFingerprint(err: Error): Promise<string> {
  const head = normalizeText(`${err.name}: ${err.message}`);
  const frames = topFrames(err.stack);
  const parts = frames.length > 0 ? [head, ...frames] : [head, "{nostack}"];
  return (await sha256Hex(parts.join("\n"))).slice(0, 16);
}

// spec 7.1.3. routePattern은 c.req.routePath 같은 라우트 패턴(예: /api/profiles/:username)이다.
// 호출하는 쪽(onError)이 ctx.waitUntil로 넘긴다. 실패는 삼키고 fingerprint만 로그에 남긴다(메시지는 남기지 않는다).
export async function recordError(
  env: Env,
  err: Error,
  routePattern: string,
  now: Date = new Date(),
  cap: number = ERROR_EVENTS_CAP,
): Promise<void> {
  let fingerprint = "unknown";
  try {
    fingerprint = await errorFingerprint(err);
    const d = db(env);
    const ts = now.toISOString();
    const known = await d
      .select({ f: errorEvents.fingerprint })
      .from(errorEvents)
      .where(eq(errorEvents.fingerprint, fingerprint))
      .get();
    if (!known) {
      const total = await d
        .select({ c: sql<number>`count(*)` })
        .from(errorEvents)
        .where(or(isNull(errorEvents.ackedAt), lt(errorEvents.ackedAt, errorEvents.lastSeen)))
        .get();
      if ((total?.c ?? 0) >= cap) return;
    }
    await d
      .insert(errorEvents)
      .values({
        fingerprint,
        message: normalizeText(`${err.name}: ${err.message}`).slice(0, MESSAGE_MAX),
        path: normalizeText(routePattern).slice(0, PATH_MAX),
        count: 1,
        firstSeen: ts,
        lastSeen: ts,
      })
      .onConflictDoUpdate({
        target: errorEvents.fingerprint,
        set: { count: sql`${errorEvents.count} + 1`, lastSeen: ts },
      });
  } catch {
    console.error("recordError failed", fingerprint);
  }
}
