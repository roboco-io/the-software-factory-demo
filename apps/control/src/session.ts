/** Name of the session cookie. The `__Host-` prefix makes browsers require Secure, Path=/ and no Domain. */
export const SESSION_COOKIE = "__Host-session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** What a session holds. The role is never part of it: it is computed from `id` on each request. */
export interface Session {
  id: string;
  login: string;
  /** Expiry, in seconds since the epoch. */
  exp: number;
}

const ID = /^[0-9]{1,20}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** Only for decoding: an unpadded base64url string. */
const B64URL = /^[A-Za-z0-9_-]*$/;

const encoder = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!B64URL.test(value) || value.length % 4 === 1) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Compares two strings without stopping at the first difference. Only the lengths are not hidden. */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

const hmacKey = (secret: string, usage: "sign" | "verify") =>
  crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );

/** `base64url(payload).base64url(HMAC-SHA256(payload))`. The payload is the JSON of the session. */
export async function signSession(
  secret: string,
  session: Session,
): Promise<string> {
  const payload = toBase64Url(encoder.encode(JSON.stringify(session)));
  const mac = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, "sign"),
    encoder.encode(payload),
  );
  return `${payload}.${toBase64Url(new Uint8Array(mac))}`;
}

/**
 * Returns the session, or null for anything else: no secret, a malformed value, a MAC that
 * does not match (checked by `crypto.subtle.verify`, which compares in constant time),
 * a payload of the wrong shape, an expired session. Fields other than id, login and exp
 * are dropped.
 */
export async function verifySession(
  secret: string | undefined,
  value: string | undefined,
  nowSeconds: number,
): Promise<Session | null> {
  if (secret === undefined || secret === "" || value === undefined) return null;
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [payload, mac] = parts as [string, string];
  const macBytes = fromBase64Url(mac);
  if (payload === "" || macBytes === null || macBytes.length !== 32)
    return null;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, "verify"),
    macBytes,
    encoder.encode(payload),
  );
  if (!valid) return null;
  const bytes = fromBase64Url(payload);
  if (bytes === null) return null;
  let data: unknown;
  try {
    data = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data))
    return null;
  const { id, login, exp } = data as Record<string, unknown>;
  if (typeof id !== "string" || !ID.test(id)) return null;
  if (typeof login !== "string" || !LOGIN.test(login)) return null;
  if (typeof exp !== "number" || !Number.isSafeInteger(exp)) return null;
  if (exp <= nowSeconds || exp > nowSeconds + SESSION_TTL_SECONDS) return null;
  return { id, login, exp };
}

const ATTRIBUTES = "Path=/; HttpOnly; Secure; SameSite=Lax";

export const sessionCookie = (value: string, maxAge = SESSION_TTL_SECONDS) =>
  `${SESSION_COOKIE}=${value}; ${ATTRIBUTES}; Max-Age=${maxAge}`;

export const clearCookie = (name: string) =>
  `${name}=; ${ATTRIBUTES}; Max-Age=0`;

/** The value of one cookie, matched by exact name. */
export function readCookie(
  header: string | null,
  name: string,
): string | undefined {
  if (header === null) return undefined;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at === -1) continue;
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

/**
 * Signs any JSON object for one named purpose. The purpose is part of what the MAC covers, so a
 * value signed for one purpose never verifies for another, and never as a session
 * (a session's MAC covers the bare payload).
 */
export async function signPayload(
  secret: string,
  purpose: string,
  data: Record<string, unknown>,
): Promise<string> {
  const payload = toBase64Url(encoder.encode(JSON.stringify(data)));
  const mac = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, "sign"),
    encoder.encode(`${purpose}.${payload}`),
  );
  return `${payload}.${toBase64Url(new Uint8Array(mac))}`;
}

/** The object, or null for a missing secret, a malformed value, a wrong MAC or a payload that is not an object. */
export async function verifyPayload(
  secret: string | undefined,
  purpose: string,
  value: string | undefined,
): Promise<Record<string, unknown> | null> {
  if (secret === undefined || secret === "" || value === undefined) return null;
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [payload, mac] = parts as [string, string];
  const macBytes = fromBase64Url(mac);
  if (payload === "" || macBytes === null || macBytes.length !== 32)
    return null;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, "verify"),
    macBytes,
    encoder.encode(`${purpose}.${payload}`),
  );
  if (!valid) return null;
  const bytes = fromBase64Url(payload);
  if (bytes === null) return null;
  try {
    const data: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    return typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
