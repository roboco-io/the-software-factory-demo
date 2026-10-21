import { Hono } from "hono";
import type { AppEnv } from "../env";
import { syncBook } from "../lib/book-sync";
import { invalid, ROUTE_NOT_FOUND } from "../lib/errors";
import { constantTimeEqual } from "../middleware/intake";

export const bookSyncRouter = new Hono<AppEnv>();

const BEARER = /^Bearer ([\x21-\x7e]{1,512})$/;
const SHA = /^[0-9a-f]{40}$/;

// 책 저장소의 Pages 배포가 끝나면 호출한다. 매시 Cron 동기화는 놓친 경우를 위한 보조로 남는다.
// 토큰이 없거나 틀리면 수집 엔드포인트와 같이 알 수 없는 경로의 404로 존재를 드러내지 않는다.
bookSyncRouter.post("/book/sync", async (c) => {
  const expected = c.env.BOOK_SYNC_TOKEN ?? "";
  const presented = BEARER.exec(c.req.header("authorization") ?? "")?.[1];
  if (!expected || presented === undefined || !(await constantTimeEqual(presented, expected)))
    return c.json(ROUTE_NOT_FOUND, 404);
  let ref: string | undefined;
  const raw = await c.req.text();
  if (raw.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw invalid("body");
    }
    const value =
      typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "ref") : undefined;
    if (value !== undefined) {
      if (typeof value !== "string" || !SHA.test(value)) throw invalid("ref");
      ref = value;
    }
  }
  const documents = await syncBook(c.env, ref ? { ref } : {});
  const meta = await c.env.DB.prepare("SELECT synced_at FROM book_meta WHERE id = 1").first<{
    synced_at: string;
  }>();
  return c.json({ syncedAt: meta?.synced_at ?? null, documents });
});
