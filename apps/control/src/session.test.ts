import { describe, expect, it } from "vitest";
import {
  readUser,
  roleOf,
  sessionCookie,
  signToken,
  verifyToken,
} from "./session";

const b64 = (s: string) =>
  btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("session", () => {
  it("round trip returns the payload", async () => {
    const t = await signToken({ a: 1 }, "s", 0, 1000);
    expect(t).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(await verifyToken(t, "s", 500)).toMatchObject({ a: 1 });
  });
  it("expired token is null", async () => {
    const t = await signToken({ a: 1 }, "s", 0, 1000);
    expect(await verifyToken(t, "s", 2000)).toBeNull();
  });
  it("test_tampered_payload_null", async () => {
    const t = await signToken({ id: "2" }, "s", 0, 1000);
    const sig = t.split(".")[1];
    const forged = `${b64(JSON.stringify({ id: "1", exp: 1000 }))}.${sig}`;
    expect(await verifyToken(forged, "s", 1)).toBeNull();
  });
  it("test_wrong_secret_null", async () => {
    const t = await signToken({ a: 1 }, "s", 0, 1000);
    expect(await verifyToken(t, "other", 1)).toBeNull();
  });
  it("test_missing_secret_null", async () => {
    const t = await signToken({ a: 1 }, "s", 0, 1000);
    expect(await verifyToken(t, undefined, 1)).toBeNull();
    expect(await verifyToken(t, "", 1)).toBeNull();
    expect(await verifyToken(undefined, "s", 1)).toBeNull();
  });
  it("test_alg_none_shape_null", async () => {
    const p = b64(JSON.stringify({ id: "1", exp: 1000 }));
    expect(await verifyToken(`${p}.`, "s", 1)).toBeNull();
    expect(await verifyToken(p, "s", 1)).toBeNull();
    expect(
      await verifyToken(`${b64('{"alg":"none"}')}.${p}.`, "s", 1),
    ).toBeNull();
  });
  it("readUser reads the cookie", async () => {
    expect(await readUser(null, "s", 0)).toBeNull();
    const t = await signToken({ id: "2", login: "x" }, "s", 0, 1000);
    expect(await readUser(`a=b; factory_session=${t}`, "s", 1)).toEqual({
      id: "2",
      login: "x",
    });
    expect(await readUser(`factory_session=${t}`, "s", 5000)).toBeNull();
    expect(await readUser(`factory_session=${t}`, undefined, 1)).toBeNull();
  });
  it("readUser rejects payload without id and login", async () => {
    const t = await signToken({ a: 1 }, "s", 0, 1000);
    expect(await readUser(`factory_session=${t}`, "s", 1)).toBeNull();
  });
  it("roleOf", () => {
    expect(roleOf(null, ["1"])).toBe("anonymous");
    expect(roleOf({ id: "2" }, ["1"])).toBe("observer");
    expect(roleOf({ id: "1" }, ["1"])).toBe("operator");
  });
  it("test_login_cannot_grant_operator", () => {
    const user = { id: "2", login: "operatorname" };
    expect(roleOf(user, ["1"])).toBe("observer");
  });
  it("sessionCookie", () => {
    expect(sessionCookie("v", 28800)).toBe(
      "factory_session=v; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800",
    );
  });
});
