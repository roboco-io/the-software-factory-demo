import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncBook } from "../src/lib/book-sync";
import worker from "../src/index";
import { api, register } from "./helpers";

const BASE = "https://book.test";
const manifest = {
  ch01: { revision: "2", anchors: { 첫째: "s01", 둘째: "s02" } },
};
const md = "# 1장 제목\n\n## 첫째\n\n```\n## 코드\n```\n\n## 없는 절\n\n## 둘째\n";

function mockSource(files: Record<string, string>, calls: string[] = []) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    calls.push(url);
    const body = files[url.slice(BASE.length + 1)];
    return body === undefined ? new Response("nope", { status: 404 }) : new Response(body);
  });
}
const testEnv = () => ({ ...env, BOOK_SOURCE_URL: BASE });

afterEach(() => vi.restoreAllMocks());

describe("book sync", () => {
  it("syncs sections, rereads only changed manuscripts, and keeps data on failure", async () => {
    const calls: string[] = [];
    mockSource(
      {
        "website/content-manifest.json": JSON.stringify(manifest),
        "manuscript/chapters/ch01.md": md,
      },
      calls,
    );
    await worker.scheduled({} as ScheduledController, testEnv());
    const res = await api("/book/ch01");
    const { document } = (await res.json()) as {
      document: { revision: number; sections: { anchor: string; heading: string }[] };
    };
    expect(document.revision).toBe(2);
    expect(document.sections.map((s) => s.anchor)).toEqual(["s01", "s02"]);

    calls.length = 0;
    await syncBook(testEnv());
    expect(calls).toEqual([`${BASE}/website/content-manifest.json`]);

    const before = (await (await api("/book")).json()) as { syncedAt: string };
    vi.restoreAllMocks();
    mockSource({ "website/content-manifest.json": "not json" });
    await expect(syncBook(testEnv())).rejects.toThrow();
    await worker.scheduled({} as ScheduledController, testEnv());
    const after = (await (await api("/book")).json()) as {
      syncedAt: string;
      documents: unknown[];
    };
    expect(after.syncedAt).toBe(before.syncedAt);
    expect(after.documents.length).toBeGreaterThan(0);
  });

  it("groups patterns into one document with one section per pattern", async () => {
    const calls: string[] = [];
    const files = {
      "website/content-manifest.json": JSON.stringify({
        ch01: manifest.ch01,
        p01: { revision: "2", anchors: { 문제: "s01" } },
        p02: { revision: "3", anchors: { 문제: "s01" } },
      }),
      "manuscript/chapters/ch01.md": md,
      "manuscript/patterns/p01.md": "# P01 첫 패턴\n\n## 문제\n\n본문.\n",
      "manuscript/patterns/p02.md": "# P02 둘째 패턴\n\n## 문제\n\n본문.\n",
    };
    mockSource(files, calls);
    await syncBook(testEnv());
    const { documents } = (await (await api("/book")).json()) as {
      documents: { docId: string; kind: string; title: string; revision: number }[];
    };
    expect(documents.map((d) => d.docId)).toEqual(["ch01", "patterns"]);
    expect(documents[1]).toMatchObject({ kind: "patterns", title: "패턴", revision: 5 });
    const { document } = (await (await api("/book/patterns")).json()) as {
      document: { sections: { anchor: string; heading: string }[] };
    };
    expect(document.sections).toEqual([
      expect.objectContaining({ anchor: "p01", heading: "P01 첫 패턴" }),
      expect.objectContaining({ anchor: "p02", heading: "P02 둘째 패턴" }),
    ]);
    expect((await api("/book/p01")).status).toBe(404);

    // 패턴 하나의 revision만 올라도 패턴 원고를 다시 읽고, 그 패턴 절만 해시가 바뀐다
    const hashes = async () =>
      (
        await env.DB.prepare(
          "SELECT anchor, hash FROM book_sections WHERE doc_id = 'patterns' ORDER BY position",
        ).all<{ anchor: string; hash: string }>()
      ).results;
    const before = await hashes();
    vi.restoreAllMocks();
    mockSource({
      ...files,
      "website/content-manifest.json": JSON.stringify({
        ch01: manifest.ch01,
        p01: { revision: "2", anchors: {} },
        p02: { revision: "4", anchors: {} },
      }),
      "manuscript/patterns/p02.md": "# P02 둘째 패턴\n\n## 문제\n\n고친 본문.\n",
    });
    await syncBook(testEnv());
    const after = await hashes();
    expect(after[0]!.hash).toBe(before[0]!.hash);
    expect(after[1]!.hash).not.toBe(before[1]!.hash);
  });

  it("rereads a manuscript whose section hashes are missing even if the revision is unchanged", async () => {
    const calls: string[] = [];
    mockSource(
      {
        "website/content-manifest.json": JSON.stringify(manifest),
        "manuscript/chapters/ch01.md": md,
      },
      calls,
    );
    await syncBook(testEnv());
    // 해시 도입 이전에 동기화된 상태를 흉내 낸다.
    await env.DB.prepare("UPDATE book_sections SET hash = NULL WHERE doc_id = 'ch01'").run();
    calls.length = 0;
    await syncBook(testEnv());
    expect(calls).toContain(`${BASE}/manuscript/chapters/ch01.md`);
    const { results } = await env.DB.prepare(
      "SELECT hash FROM book_sections WHERE doc_id = 'ch01' ORDER BY position",
    ).all<{ hash: string | null }>();
    expect(results.every((r) => /^[0-9a-f]{64}$/.test(r.hash ?? ""))).toBe(true);
  });

  it("keeps existing data when the manifest has an invalid structure", async () => {
    mockSource({
      "website/content-manifest.json": JSON.stringify(manifest),
      "manuscript/chapters/ch01.md": md,
    });
    await syncBook(testEnv());
    const before = (await (await api("/book")).json()) as { syncedAt: string };
    for (const bad of ["[]", '{"error":"unavailable"}', '{"ch01":{"anchors":{}}}', "null"]) {
      vi.restoreAllMocks();
      mockSource({ "website/content-manifest.json": bad });
      await expect(syncBook(testEnv())).rejects.toThrow();
    }
    const after = (await (await api("/book")).json()) as {
      syncedAt: string;
      documents: unknown[];
    };
    expect(after.syncedAt).toBe(before.syncedAt);
    expect(after.documents.length).toBeGreaterThan(0);
    const { document } = (await (await api("/book/ch01")).json()) as {
      document: { sections: unknown[] };
    };
    expect(document.sections.length).toBe(2);
  });

  it("opens, filters, edits and deletes topics", async () => {
    mockSource({
      "website/content-manifest.json": JSON.stringify(manifest),
      "manuscript/chapters/ch01.md": md,
    });
    await syncBook(testEnv());
    const { token } = await register("tp");
    const bad = await api("/topics", {
      method: "POST",
      token,
      body: { topic: { title: "t", body: "b", docId: "ch01", anchor: "s09" } },
    });
    expect(bad.status).toBe(422);
    const ok = await api("/topics", {
      method: "POST",
      token,
      body: { topic: { title: "t", body: "b", docId: "ch01", anchor: "s01" } },
    });
    expect(ok.status).toBe(201);
    const { topic } = (await ok.json()) as { topic: { id: number; book: { status: string } } };
    expect(topic.book.status).toBe("current");
    const list = await api("/topics?docId=ch01&anchor=s01");
    expect(((await list.json()) as { topicsCount: number }).topicsCount).toBeGreaterThanOrEqual(1);
    expect((await api(`/topics/${topic.id}`, { method: "DELETE", token })).status).toBe(204);
    expect((await api(`/topics/${topic.id}`)).status).toBe(404);
  });
});
