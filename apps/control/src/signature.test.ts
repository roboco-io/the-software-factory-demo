import { describe, expect, it } from "vitest";
import { verifySignature } from "./signature";
import { sign } from "./testing/sign";

const secret = "whsec_test_secret";
const body = new TextEncoder().encode('{"a":1}');

describe("verifySignature", () => {
  it("accepts a correct signature", async () => {
    expect(await verifySignature(secret, body, await sign(secret, body))).toBe(
      true,
    );
  });
  it("rejects a forged signature (wrong secret)", async () => {
    expect(await verifySignature(secret, body, await sign("other", body))).toBe(
      false,
    );
  });
  it("rejects a signature over a different body", async () => {
    const other = new TextEncoder().encode('{"a":2}');
    expect(await verifySignature(secret, body, await sign(secret, other))).toBe(
      false,
    );
  });
  it.each([
    null,
    "",
    "sha256=",
    "sha256=zz",
    "sha1=" + "a".repeat(40),
    "a".repeat(64),
    "sha256=" + "a".repeat(63),
    "sha256=" + "a".repeat(65),
    "sha256=" + "g".repeat(64),
  ])("rejects malformed header %s", async (header) => {
    expect(await verifySignature(secret, body, header)).toBe(false);
  });
  it("rejects when the secret is empty", async () => {
    expect(await verifySignature("", body, await sign(secret, body))).toBe(
      false,
    );
  });
});
