import { describe, expect, it, vi } from "vitest";
import { ApiFailure, createClient, errorMessages } from "./client";

const json = (status: number, body: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("createClient", () => {
  it("sends Token header and JSON body", async () => {
    const f = vi.fn(async () => json(200, { ok: true }));
    const c = createClient("https://api.test/api", () => "tkn", f);
    await c.post("/topics", { topic: { title: "x" } });
    const [url, init] = f.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/api/topics");
    expect((init.headers as Record<string, string>).authorization).toBe("Token tkn");
    expect(init.body).toBe(JSON.stringify({ topic: { title: "x" } }));
  });

  it("omits Authorization when there is no token", async () => {
    const f = vi.fn(async () => json(200, {}));
    await createClient("b", () => null, f).get("/x");
    const init = (f.mock.calls[0]! as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("throws ApiFailure with RealWorld errors on 422", async () => {
    const f = vi.fn(async () => json(422, { errors: { email: ["can't be blank"] } }));
    const err = await createClient("b", () => null, f)
      .post("/users", {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiFailure);
    expect((err as ApiFailure).status).toBe(422);
    expect(errorMessages((err as ApiFailure).errors)).toEqual(["email can't be blank"]);
  });

  it("maps network errors to status 0", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const err = (await createClient("b", () => null, f)
      .get("/x")
      .catch((e: unknown) => e)) as ApiFailure;
    expect(err.status).toBe(0);
    expect(err.errors).toEqual({ network: ["is unreachable"] });
  });

  it("returns undefined for 204", async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }));
    await expect(createClient("b", () => null, f).del("/x")).resolves.toBeUndefined();
  });

  it("handles non-JSON error bodies", async () => {
    const f = vi.fn(async () => new Response("Bad Gateway", { status: 502 }));
    const err = (await createClient("b", () => null, f)
      .get("/x")
      .catch((e: unknown) => e)) as ApiFailure;
    expect(err.status).toBe(502);
    expect(err.errors).toEqual({ server: ["responded with 502"] });
  });
});
