import { describe, expect, it } from "vitest";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  clearCookie,
  constantTimeEqual,
  readCookie,
  sessionCookie,
  signSession,
  verifySession,
} from "./session";

const SECRET = "k".repeat(48);
const NOW = 1_800_000_000;
const good = { id: "3435720", login: "octo-cat", exp: NOW + 600 };

describe("constantTimeEqual", () => {
  it("compares equal strings, different strings and different lengths", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("session cookie value", () => {
  it("round-trips id, login and exp", async () => {
    const value = await signSession(SECRET, good);
    expect(await verifySession(SECRET, value, NOW)).toEqual(good);
  });

  it("rejects a tampered payload or MAC, another secret and malformed values", async () => {
    const value = await signSession(SECRET, good);
    const [payload, mac] = value.split(".") as [string, string];
    const forged = btoa(JSON.stringify({ ...good, id: "1" })).replace(
      /=+$/,
      "",
    );
    expect(await verifySession(SECRET, `${forged}.${mac}`, NOW)).toBeNull();
    expect(
      await verifySession(SECRET, `${payload}.${"A".repeat(43)}`, NOW),
    ).toBeNull();
    expect(await verifySession("other".repeat(10), value, NOW)).toBeNull();
    for (const bad of [
      "",
      ".",
      "a.b.c",
      "x",
      `${payload}.`,
      `.${mac}`,
      undefined,
    ])
      expect(await verifySession(SECRET, bad, NOW)).toBeNull();
    expect(await verifySession(undefined, value, NOW)).toBeNull();
    expect(await verifySession("", value, NOW)).toBeNull();
  });

  it("rejects an expired session and one that claims a longer life than allowed", async () => {
    const expired = await signSession(SECRET, { ...good, exp: NOW - 1 });
    expect(await verifySession(SECRET, expired, NOW)).toBeNull();
    const eternal = await signSession(SECRET, {
      ...good,
      exp: NOW + SESSION_TTL_SECONDS + 60,
    });
    expect(await verifySession(SECRET, eternal, NOW)).toBeNull();
  });

  it("rejects a signed payload with the wrong shape", async () => {
    for (const bad of [
      { ...good, id: "abc" },
      { ...good, id: 3435720 },
      { ...good, login: "bad login" },
      { ...good, login: "" },
      { ...good, exp: "soon" },
      { ...good, exp: 1.5 },
    ]) {
      const value = await signSession(SECRET, bad as never);
      expect(await verifySession(SECRET, value, NOW)).toBeNull();
    }
  });

  it("keeps only id, login and exp, so a role claim in the payload has no effect", async () => {
    const value = await signSession(SECRET, {
      ...good,
      role: "operator",
      isOperator: true,
    } as never);
    expect(await verifySession(SECRET, value, NOW)).toEqual(good);
  });
});

describe("cookie headers", () => {
  it("sets a __Host- cookie that is HttpOnly, Secure, Lax, Path=/ with a 7-day life", () => {
    const header = sessionCookie("v");
    expect(header).toBe(
      `${SESSION_COOKIE}=v; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`,
    );
    expect(SESSION_COOKIE.startsWith("__Host-")).toBe(true);
    expect(header).not.toContain("Domain");
  });

  it("clears a cookie with the same attributes", () => {
    expect(clearCookie("__Host-x")).toBe(
      "__Host-x=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    );
  });

  it("reads one cookie by exact name", () => {
    const header = "a=1; __Host-session=abc; b=2";
    expect(readCookie(header, "__Host-session")).toBe("abc");
    expect(readCookie(header, "session")).toBeUndefined();
    expect(readCookie(null, "a")).toBeUndefined();
  });
});
