const COOKIE = "factory_session";
const enc = new TextEncoder();

function toB64u(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64u(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function key(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

export async function signToken(
  payload: object,
  secret: string,
  nowMs: number,
  ttlMs: number,
): Promise<string> {
  const body = toB64u(
    enc.encode(JSON.stringify({ ...payload, exp: nowMs + ttlMs })),
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    await key(secret, "sign"),
    enc.encode(body),
  );
  return `${body}.${toB64u(new Uint8Array(sig))}`;
}

export async function verifyToken(
  token: string | undefined,
  secret: string | undefined,
  nowMs: number,
): Promise<Record<string, unknown> | null> {
  if (!token || !secret) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  const sigBytes = fromB64u(sig);
  if (!sigBytes || sigBytes.length === 0) return null;
  const ok = await crypto.subtle.verify(
    "HMAC",
    await key(secret, "verify"),
    sigBytes,
    enc.encode(body),
  );
  if (!ok) return null;
  const raw = fromB64u(body);
  if (!raw) return null;
  try {
    const payload: unknown = JSON.parse(new TextDecoder().decode(raw));
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload)
    )
      return null;
    const exp = (payload as Record<string, unknown>).exp;
    if (typeof exp !== "number" || nowMs >= exp) return null;
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function readUser(
  cookieHeader: string | null,
  secret: string | undefined,
  nowMs: number,
): Promise<{ id: string; login: string } | null> {
  if (!cookieHeader) return null;
  let value: string | undefined;
  for (const part of cookieHeader.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === COOKIE)
      value = part.slice(i + 1).trim();
  }
  const payload = await verifyToken(value, secret, nowMs);
  if (
    !payload ||
    typeof payload.id !== "string" ||
    typeof payload.login !== "string"
  )
    return null;
  return { id: payload.id, login: payload.login };
}

export function roleOf(
  user: { id: string } | null,
  operatorIds: readonly string[],
): "anonymous" | "observer" | "operator" {
  if (!user) return "anonymous";
  return operatorIds.includes(user.id) ? "operator" : "observer";
}

export function sessionCookie(value: string, maxAgeSeconds: number): string {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}
