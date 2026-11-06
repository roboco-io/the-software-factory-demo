import { describe, expect, it } from "vitest";
import { handleRequest } from "./index";

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
});
