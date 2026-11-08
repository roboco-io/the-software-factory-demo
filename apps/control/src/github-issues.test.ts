import { describe, expect, it } from "vitest";
import { createIssueCreator } from "./github-issues";
import { testPem } from "./testing/pulls-world";

describe("issue creator (stage 5 budget issue)", () => {
  it("asks for an issues:write token for that one repository and opens the issue", async () => {
    const calls: {
      method: string;
      url: string;
      body: unknown;
      auth: string;
    }[] = [];
    const fetchStub = (async (url: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({
        method: init.method ?? "GET",
        url,
        body,
        auth: new Headers(init.headers).get("authorization") ?? "",
      });
      if (url.endsWith("/repos/roboco-io/factory/installation"))
        return Response.json({ id: 7 });
      if (url.endsWith("/app/installations/7/access_tokens"))
        return Response.json(
          { token: "inst-token", expires_at: "2030-01-01T00:00:00Z" },
          { status: 201 },
        );
      if (url.endsWith("/repos/roboco-io/factory/issues"))
        return Response.json({ number: 21 }, { status: 201 });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const creator = createIssueCreator({
      appId: "1",
      privateKeyPem: testPem(),
      fetch: fetchStub,
    });
    expect(await creator.createIssue("roboco-io/factory", "T", "B")).toBe(21);
    const token = calls.find((c) => c.url.endsWith("/access_tokens"))!;
    expect(token.body).toEqual({
      repositories: ["factory"],
      permissions: { issues: "write" },
    });
    const issue = calls.at(-1)!;
    expect(issue).toMatchObject({
      method: "POST",
      body: { title: "T", body: "B" },
    });
    expect(issue.auth).toBe("Bearer inst-token");
  });

  it("refuses an invalid repository name before calling GitHub", async () => {
    const creator = createIssueCreator({
      appId: "1",
      privateKeyPem: testPem(),
      fetch: (async () => {
        throw new Error("must not be called");
      }) as typeof fetch,
    });
    await expect(creator.createIssue("../x", "T", "B")).rejects.toThrow();
  });
});
