import { describe, expect, it } from "vitest";
import { handleRequest } from "./app";
import { sign } from "./testing/sign";

const get = (path: string, method = "GET") =>
  handleRequest(new Request(`https://factory.test${path}`, { method }));

describe("control API", () => {
  it("reports health as JSON without caching", async () => {
    const res = await get("/api/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("rejects non-GET health requests", async () => {
    const res = await get("/api/health", "POST");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });

  it("returns a JSON 404 for unknown API paths", async () => {
    const res = await get("/api/unknown");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("exposes no path outside the route table", async () => {
    for (const path of ["/api/runs", "/api/events", "/api/github", "/api/"]) {
      expect((await get(path)).status).toBe(404);
    }
  });

  it("answers 503 for a data route when the database is not bound", async () => {
    expect((await get("/api/projects")).status).toBe(503);
    expect((await get("/api/runs/abc123")).status).toBe(503);
  });

  it("answers 503 on the webhook when no secret is configured", async () => {
    const res = await get("/api/github/webhook", "POST");
    expect(res.status).toBe(503);
  });

  it("routes a signed, non-actionable webhook to 202 with no bindings needed", async () => {
    const body = new TextEncoder().encode("{}");
    const res = await handleRequest(
      new Request("https://factory.test/api/github/webhook", {
        method: "POST",
        headers: {
          "x-github-event": "ping",
          "x-hub-signature-256": await sign("s3cret", body),
        },
        body,
      }),
      { GITHUB_WEBHOOK_SECRET: "s3cret" },
    );
    expect(res.status).toBe(202);
  });

  it("returns 500 and keeps the delivery retryable when secrets for a run are missing", async () => {
    const claimed = new Set<string>();
    const db = {
      prepare(sql: string) {
        let id = "";
        const stmt = {
          bind: (...v: unknown[]) => ((id = String(v[0])), stmt),
          run: async () => {
            if (sql.startsWith("INSERT OR IGNORE")) {
              const fresh = !claimed.has(id);
              claimed.add(id);
              return { meta: { changes: fresh ? 1 : 0 } };
            }
            claimed.delete(id);
            return { meta: { changes: 1 } };
          },
        };
        return stmt;
      },
      batch: async () => undefined,
    };
    const payload = new TextEncoder().encode(
      JSON.stringify({
        action: "labeled",
        label: { name: "factory:go" },
        sender: { id: 101, login: "alice", type: "User" },
        repository: { full_name: "acme/demo" },
        issue: { number: 1, state: "open", title: "t", body: "b" },
      }),
    );
    const res = await handleRequest(
      new Request("https://factory.test/api/github/webhook", {
        method: "POST",
        headers: {
          "x-github-event": "issues",
          "x-github-delivery": "abc-123",
          "x-hub-signature-256": await sign("s3cret", payload),
        },
        body: payload,
      }),
      {
        GITHUB_WEBHOOK_SECRET: "s3cret",
        RUNS_ENABLED: "true",
        OPERATOR_IDS: "101",
        PROJECTS: "acme/demo",
        DB: db as never,
      },
    );
    expect(res.status).toBe(500);
    expect(claimed.has("abc-123")).toBe(false);
  });
});
