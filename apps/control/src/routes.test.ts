import { describe, expect, it, vi } from "vitest";
import { handleRequest } from "./app";
import { ROUTES, type Route } from "./routes";
import {
  CLIENT_SECRET,
  ORIGIN,
  SESSION_SECRET,
  cookieFor,
  makeWorld,
  observerCookie,
  operatorCookie,
  req,
  seedRuns,
} from "./testing/api-world";

const SAMPLE: Record<string, string> = {
  owner: "acme",
  repo: "demo",
  id: "aaaaaaaaaaa1",
};
const pathOf = (route: Route) =>
  route.path.replace(/:([a-z]+)/g, (_, name: string) => SAMPLE[name]!);
const nonGet = ROUTES.flatMap((route) =>
  route.methods.filter((m) => m !== "GET").map((method) => ({ route, method })),
);
/** The only non-GET routes that may be open to a caller below operator, with the reason. */
const EXEMPT: Record<string, string> = {
  "/api/auth/logout": "own-session",
  "/api/github/webhook": "signed-webhook",
};

describe("route table", () => {
  it("states methods and a minimum role for every route, with unique paths", () => {
    expect(ROUTES.length).toBeGreaterThan(5);
    const paths = ROUTES.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const r of ROUTES) {
      expect(r.methods.length).toBeGreaterThan(0);
      expect(["anonymous", "observer", "operator"]).toContain(r.minRole);
      expect(typeof r.handler).toBe("function");
    }
  });

  it("fails if a non-GET route has a minimum role below operator without a recorded exemption", () => {
    for (const { route } of nonGet) {
      if (route.minRole === "operator") continue;
      expect(EXEMPT[route.path], `${route.path} needs operator`).toBe(
        route.exemption,
      );
    }
    // The exemptions are exactly the two listed here; a third one fails this test.
    const exempt = ROUTES.filter((r) => r.exemption !== undefined)
      .map((r) => r.path)
      .sort();
    expect(exempt).toEqual(Object.keys(EXEMPT).sort());
  });

  it("allows only the stop route as an operator write", () => {
    expect(
      nonGet
        .filter((x) => x.route.minRole === "operator")
        .map((x) => x.route.path),
    ).toEqual(["/api/runs/:id/stop", "/api/runs/:id/review"]);
  });
});

describe("every non-GET route (proof for AGENTS.md: observers cannot write)", () => {
  const writes = nonGet.filter((x) => x.route.exemption === undefined);

  it("covers at least the stop route", () => {
    expect(writes.map((w) => w.route.path)).toContain("/api/runs/:id/stop");
  });

  for (const { route, method } of writes) {
    const path = pathOf(route);

    it(`${method} ${route.path}: anonymous gets 401, observer 403, with no side effect`, async () => {
      const w = makeWorld();
      seedRuns(w);
      const before = w.snapshot();
      const anonymous = await handleRequest(req(path, { method }), w.env);
      expect(anonymous.status).toBe(401);
      const observer = await handleRequest(
        req(path, { method, cookie: await observerCookie() }),
        w.env,
      );
      expect(observer.status).toBe(403);
      expect(w.stopCalls).toEqual([]);
      expect(w.snapshot()).toBe(before);
    });

    it(`${method} ${route.path}: a forged, tampered, expired or wrong-secret cookie is anonymous`, async () => {
      const w = makeWorld();
      seedRuns(w);
      const good = await operatorCookie();
      const value = good.split("=")[1]!;
      const cookies = [
        `__Host-session=${value.slice(0, -2)}xx`,
        `__Host-session=${value.split(".")[0]}.`,
        "__Host-session=garbage",
        await cookieFor("3435720", "boss", { expIn: -10 }),
        await cookieFor("3435720", "boss", { secret: "z".repeat(48) }),
        // Plain, unsigned claims.
        `__Host-session=${btoa(JSON.stringify({ id: "3435720", login: "boss", role: "operator" }))}`,
        "session=anything; role=operator",
      ];
      for (const cookie of cookies) {
        const res = await handleRequest(req(path, { method, cookie }), w.env);
        expect(res.status, cookie).toBe(401);
      }
      expect(w.stopCalls).toEqual([]);
    });

    it(`${method} ${route.path}: an observer whose signed cookie claims role fields gains nothing`, async () => {
      const w = makeWorld();
      seedRuns(w);
      const cookie = await cookieFor("555", "visitor", {
        extra: { role: "operator", operator: true, roles: ["operator"] },
      });
      const res = await handleRequest(req(path, { method, cookie }), w.env);
      expect(res.status).toBe(403);
      expect(w.stopCalls).toEqual([]);
    });

    it(`${method} ${route.path}: a foreign or missing Origin is refused even for an operator`, async () => {
      const w = makeWorld();
      seedRuns(w);
      const before = w.snapshot();
      const cookie = await operatorCookie();
      for (const origin of [
        "https://evil.example",
        "http://factory.test",
        "null",
        "https://factory.test.evil.example",
        null,
      ]) {
        const res = await handleRequest(
          req(path, { method, cookie, origin }),
          w.env,
        );
        expect(res.status, String(origin)).toBe(403);
        expect(await res.json()).toEqual({ error: "bad_origin" });
      }
      expect(w.stopCalls).toEqual([]);
      expect(w.snapshot()).toBe(before);
    });

    it(`${method} ${route.path}: an operator with a same-origin request succeeds`, async () => {
      const w = makeWorld();
      seedRuns(w);
      w.exec(`UPDATE runs SET head_sha = 'abc' WHERE id = 'aaaaaaaaaaa1'`);
      const base = req(path, { method, cookie: await operatorCookie() });
      // Each write route gets the valid body it needs; the refusals above use no body at all.
      const reviewBody = JSON.stringify({ action: "approve", headSha: "abc" });
      const res = await handleRequest(
        route.path === "/api/runs/:id/review"
          ? new Request(base, {
              body: reviewBody,
              headers: new Headers([
                ...base.headers,
                ["content-type", "application/json"],
              ]),
            })
          : base,
        w.env,
      );
      if (route.path === "/api/runs/:id/review") {
        expect(res.status).toBe(200);
        expect(w.stopCalls).toEqual([]);
        return;
      }
      expect(res.status).toBe(202);
      expect(w.stopCalls).toEqual([
        { name: "acme/demo#7", runId: "aaaaaaaaaaa1" },
      ]);
    });
  }

  it("removing an operator from OPERATOR_IDS takes effect on the next request, with the same cookie", async () => {
    const w = makeWorld();
    seedRuns(w);
    const cookie = await operatorCookie();
    const path = "/api/runs/aaaaaaaaaaa1/stop";
    const ok = await handleRequest(
      req(path, { method: "POST", cookie }),
      w.env,
    );
    expect(ok.status).toBe(202);
    w.env.OPERATOR_IDS = "42";
    const denied = await handleRequest(
      req(path, { method: "POST", cookie }),
      w.env,
    );
    expect(denied.status).toBe(403);
    expect(w.stopCalls).toHaveLength(1);
  });
});

describe("methods", () => {
  for (const route of ROUTES) {
    it(`${route.path}: wrong methods get 405 with an Allow header`, async () => {
      const w = makeWorld();
      seedRuns(w);
      const allowed = new Set<string>(route.methods);
      if (allowed.has("GET") && route.noHead !== true) allowed.add("HEAD");
      const wrong = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].filter(
        (m) => !allowed.has(m),
      );
      const before = w.snapshot();
      for (const method of wrong) {
        for (const cookie of [undefined, await operatorCookie()]) {
          const res = await handleRequest(
            req(pathOf(route), { method, ...(cookie ? { cookie } : {}) }),
            w.env,
          );
          expect(res.status, `${method} ${route.path}`).toBe(405);
          expect(res.headers.get("allow")).toBe([...allowed].join(", "));
        }
      }
      expect(w.stopCalls).toEqual([]);
      expect(w.snapshot()).toBe(before);
    });
  }

  it("answers 404 for unknown paths and for path parameters that fail validation", async () => {
    const w = makeWorld();
    seedRuns(w);
    for (const path of [
      "/api/nope",
      "/api/runs",
      "/api/runs/",
      "/api/runs/aaaaaaaaaaa1/",
      "/api/runs/..%2Fx",
      "/api/runs/a.b",
      `/api/runs/${"a".repeat(65)}`,
      "/api/projects/acme/demo/runs/extra",
      "/api/projects/-bad/demo/runs",
      "/api/projects/acme/../runs",
      "/api/projects/acme/%2e%2e/runs",
      "/api/projects/acme/de%6Do/runs",
    ]) {
      const res = await handleRequest(req(path), w.env);
      expect(res.status, path).toBe(404);
    }
  });
});

describe("HEAD", () => {
  it("does not run the OAuth callback: no code exchange, 405", async () => {
    const w = makeWorld();
    let calls = 0;
    const res = await handleRequest(
      req("/api/auth/callback?code=abc&state=x", { method: "HEAD" }),
      w.env,
      {
        fetch: (async () => {
          calls++;
          return new Response("{}");
        }) as typeof fetch,
      },
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
    expect(calls).toBe(0);
  });
});

describe("logout", () => {
  it("refuses a foreign or missing Origin and does not clear the cookie", async () => {
    const w = makeWorld();
    const cookie = await observerCookie();
    for (const origin of ["https://evil.example", "null", null]) {
      const res = await handleRequest(
        req("/api/auth/logout", { method: "POST", cookie, origin }),
        w.env,
      );
      expect(res.status, String(origin)).toBe(403);
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    const ok = await handleRequest(
      req("/api/auth/logout", { method: "POST", cookie }),
      w.env,
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.getSetCookie()).toHaveLength(1);
  });
});

describe("stop answers", () => {
  const stop = async (w: ReturnType<typeof makeWorld>, id: string) =>
    handleRequest(
      req(`/api/runs/${id}/stop`, {
        method: "POST",
        cookie: await operatorCookie(),
      }),
      w.env,
    );

  it("always asks the Durable Object, even for a run D1 shows as finished", async () => {
    const w = makeWorld();
    seedRuns(w);
    w.state.stopResult = "not_active";
    const res = await stop(w, "aaaaaaaaaaa2");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_active" });
    expect(w.stopCalls).toEqual([
      { name: "acme/demo#8", runId: "aaaaaaaaaaa2" },
    ]);
    // A retry after a crash gets the object's answer again, not a D1-based one.
    w.state.stopResult = "stop_requested";
    const retry = await stop(w, "aaaaaaaaaaa2");
    expect(retry.status).toBe(202);
    expect(await retry.json()).toEqual({ status: "stop_requested" });
  });

  it("maps merge_attempted to 409 and not_found to 404, and writes nothing to D1", async () => {
    const w = makeWorld();
    seedRuns(w);
    const before = w.snapshot();
    w.state.stopResult = "merge_attempted";
    expect((await stop(w, "aaaaaaaaaaa1")).status).toBe(409);
    w.state.stopResult = "not_found";
    expect((await stop(w, "aaaaaaaaaaa1")).status).toBe(404);
    expect(w.snapshot()).toBe(before);
  });

  it("answers 404 without asking the object for an unknown run or a repository outside PROJECTS", async () => {
    const w = makeWorld();
    seedRuns(w);
    expect((await stop(w, "aaaaaaaaaaa9")).status).toBe(404);
    expect((await stop(w, "aaaaaaaaaaa5")).status).toBe(404);
    expect(w.stopCalls).toEqual([]);
  });
});

describe("responses", () => {
  it("are JSON with no-store, and never contain the client secret or session secret", async () => {
    const w = makeWorld();
    seedRuns(w);
    const cookie = await operatorCookie();
    const bodies: string[] = [];
    for (const route of ROUTES) {
      for (const method of route.methods) {
        for (const c of [undefined, cookie]) {
          const res = await handleRequest(
            req(pathOf(route), { method, ...(c ? { cookie: c } : {}) }),
            w.env,
          );
          if (res.status >= 300 && res.status < 400) continue;
          expect(res.headers.get("cache-control"), route.path).toBe("no-store");
          expect(res.headers.get("content-type")).toContain("application/json");
          bodies.push(await res.text());
        }
      }
    }
    for (const body of bodies) {
      expect(body).not.toContain(CLIENT_SECRET);
      expect(body).not.toContain(SESSION_SECRET);
    }
  });

  it("keeps HEAD working for GET routes and returns no body", async () => {
    const w = makeWorld();
    const res = await handleRequest(
      req("/api/health", { method: "HEAD" }),
      w.env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});

describe("logging", () => {
  it("does not log cookies or secrets while handling requests", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const w = makeWorld();
    seedRuns(w);
    const cookie = await operatorCookie();
    await handleRequest(
      req("/api/runs/aaaaaaaaaaa1/stop", { method: "POST", cookie }),
      w.env,
    );
    await handleRequest(
      req("/api/runs/aaaaaaaaaaa1/stop", {
        method: "POST",
        cookie,
        origin: "https://x.example",
      }),
      w.env,
    );
    const text = JSON.stringify(log.mock.calls);
    expect(text).not.toContain(cookie.split("=")[1]);
    expect(text).not.toContain(SESSION_SECRET);
    expect(text).not.toContain(CLIENT_SECRET);
    log.mockRestore();
  });
});

void ORIGIN;
