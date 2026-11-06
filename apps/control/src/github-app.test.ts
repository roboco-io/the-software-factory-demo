import { describe, expect, it } from "vitest";
import { createAppJwt, importPrivateKey, pkcs1ToPkcs8 } from "./github-app";
import { nodeModule } from "./testing/node";

interface KeyObject {
  export(o: {
    type: "pkcs1" | "pkcs8" | "spki";
    format: "pem" | "der";
  }): string & Uint8Array;
}
const nodeCrypto = nodeModule<{
  generateKeyPairSync(
    t: "rsa",
    o: { modulusLength: number },
  ): { privateKey: KeyObject; publicKey: KeyObject };
}>("node:crypto");

const { privateKey, publicKey } = nodeCrypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const pkcs1Pem = privateKey.export({ type: "pkcs1", format: "pem" }) as string;
const pkcs8Pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const pkcs1Der = privateKey.export({
  type: "pkcs1",
  format: "der",
}) as unknown as Uint8Array;
const pkcs8Der = privateKey.export({
  type: "pkcs8",
  format: "der",
}) as unknown as Uint8Array;
const spki = publicKey.export({
  type: "spki",
  format: "der",
}) as unknown as Uint8Array;

const b64urlToBytes = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );

async function verify(jwt: string) {
  const [h, p, s] = jwt.split(".") as [string, string, string];
  const key = await crypto.subtle.importKey(
    "spki",
    spki,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  return {
    ok,
    header: JSON.parse(new TextDecoder().decode(b64urlToBytes(h))) as Record<
      string,
      unknown
    >,
    claims: JSON.parse(new TextDecoder().decode(b64urlToBytes(p))) as Record<
      string,
      unknown
    >,
  };
}

describe("GitHub App key handling", () => {
  it("converts GitHub's PKCS#1 DER into the PKCS#8 DER WebCrypto needs", () => {
    expect(Array.from(pkcs1ToPkcs8(pkcs1Der))).toEqual(Array.from(pkcs8Der));
  });
  it("imports a PKCS#1 PEM (GitHub's format)", async () => {
    expect(pkcs1Pem).toContain("BEGIN RSA PRIVATE KEY");
    const key = await importPrivateKey(pkcs1Pem);
    expect(key.algorithm.name).toBe("RSASSA-PKCS1-v1_5");
  });
  it("imports a PKCS#8 PEM and a PEM stored with literal \\n sequences", async () => {
    await importPrivateKey(pkcs8Pem);
    await importPrivateKey(pkcs1Pem.trim().replace(/\n/g, "\\n"));
  });
  it("rejects garbage without echoing it", async () => {
    await expect(importPrivateKey("not a key SECRET-VALUE")).rejects.toThrow(
      /private key/i,
    );
    await expect(
      importPrivateKey("not a key SECRET-VALUE"),
    ).rejects.not.toThrow(/SECRET-VALUE/);
    await expect(
      importPrivateKey(
        "-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----",
      ),
    ).rejects.toThrow();
  });
});

describe("createAppJwt", () => {
  it("signs an RS256 JWT that verifies with the public key", async () => {
    const jwt = await createAppJwt({
      appId: "12345",
      privateKeyPem: pkcs1Pem,
      nowSeconds: 1_700_000_000,
    });
    const v = await verify(jwt);
    expect(v.ok).toBe(true);
    expect(v.header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(v.claims).toEqual({
      iat: 1_700_000_000 - 60,
      exp: 1_700_000_000 + 9 * 60,
      iss: "12345",
    });
  });
  it("keeps the lifetime within GitHub's 10 minute limit", async () => {
    const jwt = await createAppJwt({
      appId: "1",
      privateKeyPem: pkcs8Pem,
      nowSeconds: 5000,
    });
    const { claims } = await verify(jwt);
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(
      600,
    );
  });
});
