const HEX64 = /^[0-9a-f]{64}$/;

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Verifies GitHub's `X-Hub-Signature-256` header. `crypto.subtle.verify` compares
 * the MAC in constant time, so no early exit leaks how many bytes matched.
 */
export async function verifySignature(
  secret: string,
  body: Uint8Array,
  header: string | null,
): Promise<boolean> {
  if (secret === "" || header === null || !header.startsWith("sha256="))
    return false;
  const hex = header.slice("sha256=".length);
  if (!HEX64.test(hex)) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    hexToBytes(hex),
    body as BufferSource,
  );
}
