import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client";
import { users } from "../db/schema";
import type { AppEnv } from "../env";
import { blank, invalid, notFound, tokenInvalid, tooLarge } from "../lib/errors";
import { issueToken } from "../lib/token";
import { authedUserId, requireAuth } from "../middleware/auth";
import { serializeUser } from "../serializers";

export const MAX_IMAGE_BYTES = 1024 * 1024;
const TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);

function matchesType(type: string, data: ArrayBuffer): boolean {
  const b = new Uint8Array(data.slice(0, 12));
  switch (type) {
    case "image/png":
      return startsWith(b, [137, 80, 78, 71, 13, 10, 26, 10]);
    case "image/jpeg":
      return startsWith(b, [0xff, 0xd8, 0xff]);
    case "image/gif":
      return (
        startsWith(b, [0x47, 0x49, 0x46, 0x38]) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61
      );
    case "image/webp":
      return startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8);
    default:
      return false;
  }
}

async function readLimited(body: ReadableStream<Uint8Array> | null): Promise<ArrayBuffer> {
  if (!body) return new ArrayBuffer(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel().catch(() => {});
      throw tooLarge("image", MAX_IMAGE_BYTES);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out.buffer;
}

export const imagesRouter = new Hono<AppEnv>();

imagesRouter.post("/user/image", requireAuth, async (c) => {
  const id = authedUserId(c);
  const type = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!TYPES.includes(type)) throw invalid("image");
  const declared = Number(c.req.header("content-length") ?? 0);
  if (declared > MAX_IMAGE_BYTES) throw tooLarge("image", MAX_IMAGE_BYTES);
  const data = await readLimited(c.req.raw.body);
  if (data.byteLength === 0) throw blank("image");
  if (!matchesType(type, data)) throw invalid("image");
  const now = new Date().toISOString();
  const res = await c.env.DB.prepare(
    "INSERT INTO images (owner_id, content_type, data, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(id, type, data, now)
    .run();
  const url = `${new URL(c.req.url).origin}/api/images/${res.meta.last_row_id}`;
  const row = await db(c.env)
    .update(users)
    .set({ image: url, updatedAt: now })
    .where(eq(users.id, id))
    .returning()
    .get();
  if (!row) throw tokenInvalid();
  return c.json({
    image: url,
    user: serializeUser(row, await issueToken(row.id, c.env.JWT_SECRET)),
  });
});

imagesRouter.get("/images/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT content_type, data FROM images WHERE id = ?")
    .bind(Number(c.req.param("id")))
    .first<{ content_type: string; data: ArrayBuffer | number[] }>();
  if (!row) throw notFound("image");
  const bytes = row.data instanceof ArrayBuffer ? row.data : new Uint8Array(row.data).buffer;
  return new Response(bytes, {
    headers: {
      "content-type": row.content_type,
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
});
