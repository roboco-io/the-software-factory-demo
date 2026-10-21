import { describe, expect, it } from "vitest";
import app from "../src/index";
import { api } from "./helpers";

const FORUM = /^\/api\/(book|topics|replies|agents)(\/|$)/;
const METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);
// 운영용 내부 경로. 토큰 없이는 404로 존재를 숨기므로 공개 명세에 넣지 않는다.
const INTERNAL = new Set(["POST /book/sync"]);

// Hono 경로 "/api/topics/:id"를 OpenAPI 경로 "/topics/{id}"로 바꾼다.
const toOpenApi = (path: string) => path.replace(/^\/api/, "").replace(/:(\w+)/g, "{$1}");

describe("GET /api/openapi.json", () => {
  it("serves an OpenAPI 3.1 document for the forum API", async () => {
    const res = await api("/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      info: { title: string };
      servers: unknown[];
    };
    expect(doc.openapi).toMatch(/^3\.1\./);
    expect(doc.info.title).toContain("포럼");
    expect(doc.servers).toEqual([{ url: "https://sfd-api.roboco.workers.dev/api" }]);
  });

  it("documents exactly the forum routes the API serves", async () => {
    const doc = (await (await api("/openapi.json")).json()) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const served = new Set(
      app.routes
        .filter((r) => METHODS.has(r.method) && FORUM.test(r.path))
        .map((r) => `${r.method} ${toOpenApi(r.path)}`)
        .filter((op) => !INTERNAL.has(op)),
    );
    const documented = new Set(
      Object.entries(doc.paths).flatMap(([path, ops]) =>
        Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`),
      ),
    );
    expect([...documented].sort()).toEqual([...served].sort());
  });
});
