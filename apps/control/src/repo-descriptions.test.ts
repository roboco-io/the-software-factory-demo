import { describe, expect, it } from "vitest";
import {
  FAIL_TTL_MS,
  OK_TTL_MS,
  createDescriptionCache,
  githubDescriptionLoader,
} from "./repo-descriptions";
import { nodeModule } from "./testing/node";

describe("createDescriptionCache", () => {
  it("loads each repository once and reuses the answer until it expires", async () => {
    let now = 0;
    const calls: string[] = [];
    const cache = createDescriptionCache({
      load: async (repo) => {
        calls.push(repo);
        return `${repo} 설명`;
      },
      now: () => now,
    });
    expect(await cache.get(["a/x", "b/y"])).toEqual(
      new Map([
        ["a/x", "a/x 설명"],
        ["b/y", "b/y 설명"],
      ]),
    );
    now = OK_TTL_MS - 1;
    await cache.get(["a/x", "b/y"]);
    expect(calls).toEqual(["a/x", "b/y"]);
    now = OK_TTL_MS;
    await cache.get(["a/x"]);
    expect(calls).toEqual(["a/x", "b/y", "a/x"]);
  });

  it("answers null when loading fails or takes too long, and retries after a shorter time", async () => {
    let now = 0;
    let calls = 0;
    const cache = createDescriptionCache({
      load: async () => {
        calls += 1;
        throw new Error("boom");
      },
      now: () => now,
    });
    expect(await cache.get(["a/x"])).toEqual(new Map([["a/x", null]]));
    now = FAIL_TTL_MS - 1;
    await cache.get(["a/x"]);
    expect(calls).toBe(1);
    now = FAIL_TTL_MS;
    await cache.get(["a/x"]);
    expect(calls).toBe(2);

    const slow = createDescriptionCache({
      load: () => new Promise<string>(() => {}),
      now: () => 0,
      timeoutMs: 5,
    });
    expect(await slow.get(["a/x"])).toEqual(new Map([["a/x", null]]));
  });
});

interface KeyObject {
  export(o: { type: "pkcs1"; format: "pem" }): string;
}
const { privateKey } = nodeModule<{
  generateKeyPairSync(
    t: "rsa",
    o: { modulusLength: number },
  ): { privateKey: KeyObject };
}>("node:crypto").generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" });

function fakeGitHub(description: unknown) {
  const seen: { method: string; path: string; body: unknown }[] = [];
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ method: init?.method ?? "GET", path: url.pathname, body });
    const reply = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status });
    if (url.pathname === "/repos/acme/demo/installation")
      return reply({ id: 7 });
    if (url.pathname === "/app/installations/7/access_tokens")
      return reply({ token: "t", expires_at: "2030-01-01T00:00:00Z" }, 201);
    if (url.pathname === "/repos/acme/demo") return reply({ description });
    return reply({ message: "Not Found" }, 404);
  }) as typeof fetch;
  return { seen, doFetch };
}

describe("githubDescriptionLoader", () => {
  it("reads the repository description with a metadata-only token", async () => {
    const gh = fakeGitHub("  데모 앱  ");
    const load = githubDescriptionLoader({
      appId: "1",
      privateKeyPem: pem,
      fetch: gh.doFetch,
    });
    expect(await load("acme/demo")).toBe("데모 앱");
    const token = gh.seen.find((s) => s.path.endsWith("/access_tokens"));
    expect(token?.body).toEqual({
      repositories: ["demo"],
      permissions: { metadata: "read" },
    });
  });

  it("answers null for an empty or missing description", async () => {
    for (const description of [null, "", "   "]) {
      const gh = fakeGitHub(description);
      const load = githubDescriptionLoader({
        appId: "1",
        privateKeyPem: pem,
        fetch: gh.doFetch,
      });
      expect(await load("acme/demo")).toBeNull();
    }
  });
});
