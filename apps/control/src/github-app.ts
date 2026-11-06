// GitHub issues App private keys as PKCS#1 ("BEGIN RSA PRIVATE KEY"). WebCrypto only
// imports PKCS#8, so a PKCS#1 key is wrapped in a PKCS#8 PrivateKeyInfo here.

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
  return [0x80 | bytes.length, ...bytes];
}

function derWrap(tag: number, content: Uint8Array): Uint8Array {
  const header = [tag, ...derLength(content.length)];
  const out = new Uint8Array(header.length + content.length);
  out.set(header);
  out.set(content, header.length);
  return out;
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
};

// version INTEGER 0, then AlgorithmIdentifier { rsaEncryption, NULL }.
const VERSION_AND_RSA_ALGORITHM = Uint8Array.from([
  0x02, 0x01, 0x00, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d,
  0x01, 0x01, 0x01, 0x05, 0x00,
]);

export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  return derWrap(0x30, concat(VERSION_AND_RSA_ALGORITHM, derWrap(0x04, pkcs1)));
}

function pemBody(pem: string, label: string): Uint8Array | null {
  const match = new RegExp(
    `-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`,
  ).exec(pem);
  if (match === null) return null;
  const base64 = (match[1] ?? "").replace(/\s+/g, "");
  try {
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

const ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

/** Accepts PKCS#1 or PKCS#8 PEM. Secrets stored with literal "\n" sequences are accepted. */
export async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const normalized =
    pem.includes("\\n") && !pem.includes("\n")
      ? pem.replace(/\\n/g, "\n")
      : pem;
  const pkcs8 = pemBody(normalized, "PRIVATE KEY");
  const pkcs1 = pkcs8 === null ? pemBody(normalized, "RSA PRIVATE KEY") : null;
  const der = pkcs8 ?? (pkcs1 === null ? null : pkcs1ToPkcs8(pkcs1));
  if (der === null)
    throw new Error("GitHub App private key is not a valid RSA PEM key");
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      der as BufferSource,
      ALGORITHM,
      false,
      ["sign"],
    );
  } catch {
    throw new Error("GitHub App private key could not be imported");
  }
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const encodeJson = (value: unknown) =>
  base64url(new TextEncoder().encode(JSON.stringify(value)));

/** Creates a GitHub App JWT. GitHub accepts at most 10 minutes; this uses 9 plus 1 of clock skew. */
export async function createAppJwt(input: {
  appId: string;
  privateKeyPem: string;
  nowSeconds: number;
}): Promise<string> {
  const key = await importPrivateKey(input.privateKeyPem);
  const signingInput = `${encodeJson({ alg: "RS256", typ: "JWT" })}.${encodeJson(
    {
      iat: input.nowSeconds - 60,
      exp: input.nowSeconds + 9 * 60,
      iss: input.appId,
    },
  )}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      ALGORITHM.name,
      key,
      new TextEncoder().encode(signingInput),
    ),
  );
  return `${signingInput}.${base64url(signature)}`;
}
