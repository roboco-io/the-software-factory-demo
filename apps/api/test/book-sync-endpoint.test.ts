import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./helpers";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const manifest = { ch01: { revision: "3", anchors: { 첫째: "s01" } } };

function mockBook(prefix: string, calls: string[]) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    calls.push(url);
    if (!url.startsWith(prefix)) return new Response("wrong ref", { status: 404 });
    if (url.endsWith("/website/content-manifest.json"))
      return new Response(JSON.stringify(manifest));
    if (url.endsWith("/manuscript/chapters/ch01.md"))
      return new Response("# 1장\n\n## 첫째\n\n본문.\n");
    return new Response("nope", { status: 404 });
  });
}

const post = (body: unknown, token?: string) =>
  api("/book/sync", {
    method: "POST",
    body,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });

afterEach(() => vi.restoreAllMocks());

// 책 저장소 배포가 끝나면 호출하는 동기화 엔드포인트. 토큰이 없거나 틀리면 존재를 드러내지 않는 404다.
describe("POST /api/book/sync", () => {
  it("hides itself without the right token", async () => {
    for (const token of [undefined, "wrong"]) {
      const res = await post({}, token);
      expect(res.status, String(token)).toBe(404);
      expect(await res.json()).toEqual({ errors: { route: ["not found"] } });
    }
  });

  it("syncs from the given book commit so a stale raw cache of main is not read", async () => {
    const calls: string[] = [];
    const base = (env.BOOK_SOURCE_URL ?? "").replace(/\/[^/]+\/?$/, "");
    mockBook(`${base}/${SHA}/`, calls);
    const res = await post({ ref: SHA }, env.BOOK_SYNC_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { syncedAt: string; documents: number };
    expect(body.documents).toBe(1);
    expect(body.syncedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(calls.every((u) => u.startsWith(`${base}/${SHA}/`))).toBe(true);
    const book = (await (await api("/book")).json()) as { syncedAt: string };
    expect(book.syncedAt).toBe(body.syncedAt);
  });

  it("rejects a ref that is not a full commit SHA", async () => {
    for (const ref of ["main", "../x", SHA.slice(0, 7), 42]) {
      const res = await post({ ref }, env.BOOK_SYNC_TOKEN);
      expect(res.status, String(ref)).toBe(422);
      expect(await res.json()).toEqual({ errors: { ref: ["is invalid"] } });
    }
  });
});
