import { describe, expect, it } from "vitest";
import { createTriageGitHub } from "./github-triage";
import { testPem } from "./testing/pulls-world";

function world(routes: Record<string, () => Response> = {}) {
  const calls: { method: string; path: string; body: unknown; auth: string }[] =
    [];
  const fetchStub = (async (url: string, init: RequestInit) => {
    const path = url.replace("https://api.github.com", "");
    const method = init.method ?? "GET";
    calls.push({
      method,
      path,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      auth: new Headers(init.headers).get("authorization") ?? "",
    });
    const custom = routes[`${method} ${path}`];
    if (custom !== undefined) return custom();
    if (path === "/repos/acme/demo/installation")
      return Response.json({ id: 7 });
    if (path === "/app/installations/7/access_tokens")
      return Response.json(
        { token: "inst-token", expires_at: "2030-01-01T00:00:00Z" },
        { status: 201 },
      );
    if (path === "/repos/acme/demo")
      return Response.json({ default_branch: "main" });
    if (path === "/repos/acme/demo/git/ref/heads/main")
      return Response.json({ object: { sha: "abc123" } });
    if (
      path === "/repos/acme/demo/contents/.factory/guest-policy.yml?ref=abc123"
    )
      return new Response("version: 1\n");
    if (path === "/user/555")
      return Response.json({ id: 555, created_at: "2020-01-02T03:04:05Z" });
    return Response.json({}, { status: method === "GET" ? 404 : 201 });
  }) as typeof fetch;
  const github = createTriageGitHub({
    appId: "1",
    privateKeyPem: testPem(),
    fetch: fetchStub,
  });
  return { calls, github };
}

describe("triage GitHub port", () => {
  it("reads the guest policy at the tip of the default branch with a narrow token", async () => {
    const { calls, github } = world();
    expect(await github.readGuestPolicy("acme/demo")).toEqual({
      kind: "ok",
      text: "version: 1\n",
    });
    const token = calls.find((c) => c.path.endsWith("/access_tokens"))!;
    expect(token.body).toEqual({
      repositories: ["demo"],
      permissions: { contents: "read", issues: "write" },
    });
    expect(calls.find((c) => c.path.includes("/contents/"))!.auth).toBe(
      "Bearer inst-token",
    );
  });

  it("reports a repository without the policy file", async () => {
    const { github } = world({
      "GET /repos/acme/demo/contents/.factory/guest-policy.yml?ref=abc123":
        () => new Response("{}", { status: 404 }),
    });
    expect(await github.readGuestPolicy("acme/demo")).toEqual({
      kind: "missing",
    });
  });

  it("reads when an account was created, by its numeric id", async () => {
    const { github } = world();
    // No token yet: the age is unknown, which the pre-check treats as too new.
    expect(await github.userCreatedAt(555)).toBeNull();
    await github.readGuestPolicy("acme/demo");
    expect(await github.userCreatedAt(555)).toBe(
      Date.parse("2020-01-02T03:04:05Z"),
    );
    expect(await github.userCreatedAt(556)).toBeNull();
  });

  it("does not trust a profile of another account", async () => {
    const { github } = world({
      "GET /user/555": () =>
        Response.json({ id: 1, created_at: "2001-01-01T00:00:00Z" }),
    });
    await github.readGuestPolicy("acme/demo");
    expect(await github.userCreatedAt(555)).toBeNull();
  });

  it("labels, comments and closes as not planned", async () => {
    const { calls, github } = world();
    await github.addLabel("acme/demo", 9, "demo:rejected");
    await github.comment("acme/demo", 9, "text");
    await github.closeNotPlanned("acme/demo", 9);
    const writes = calls.filter((c) =>
      c.path.startsWith("/repos/acme/demo/issues"),
    );
    expect(writes).toEqual([
      {
        method: "POST",
        path: "/repos/acme/demo/issues/9/labels",
        body: { labels: ["demo:rejected"] },
        auth: "Bearer inst-token",
      },
      {
        method: "POST",
        path: "/repos/acme/demo/issues/9/comments",
        body: { body: "text" },
        auth: "Bearer inst-token",
      },
      {
        method: "PATCH",
        path: "/repos/acme/demo/issues/9",
        body: { state: "closed", state_reason: "not_planned" },
        auth: "Bearer inst-token",
      },
    ]);
    // One token for the three writes.
    expect(calls.filter((c) => c.path.endsWith("/access_tokens"))).toHaveLength(
      1,
    );
  });

  it("refuses a malformed repository name", async () => {
    const { github } = world();
    await expect(github.comment("../x", 1, "t")).rejects.toThrow();
  });
});
