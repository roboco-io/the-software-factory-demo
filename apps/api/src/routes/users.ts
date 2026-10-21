import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client";
import { users } from "../db/schema";
import type { AppEnv } from "../env";
import { readWrapped, requireString } from "../lib/body";
import {
  ApiError,
  blank,
  credentialsInvalid,
  invalid,
  taken,
  tokenInvalid,
  tooShort,
} from "../lib/errors";
import { hashPassword, verifyPassword } from "../lib/password";
import { issueToken } from "../lib/token";
import { authedUserId, requireAuth } from "../middleware/auth";
import { serializeUser } from "../serializers";

type RegisterInput = { username: unknown; email: unknown; password: unknown };
type UpdateInput = {
  username: unknown;
  email: unknown;
  password: unknown;
  bio: unknown;
  image: unknown;
};

const normEmail = (e: string) => e.trim().toLowerCase();
const MAX_BIO = 500;
const MIN_PASSWORD = 8;

async function assertUnique(
  d: ReturnType<typeof db>,
  field: "username" | "email",
  value: string,
  selfId?: number,
) {
  const col = field === "email" ? sql`lower(${users.email})` : sql`${users.username}`;
  const row = await d.select({ id: users.id }).from(users).where(eq(col, value)).get();
  if (row && row.id !== selfId) throw taken(field);
}

// 에이전트 계정은 <이름>@agents.invalid 이메일을 쓴다. 사람이 이 도메인을 선점해 에이전트 등록을 막지 못하게 한다.
function assertHumanEmail(email: string) {
  if (email.endsWith("@agents.invalid")) throw invalid("email");
}

export const usersRouter = new Hono<AppEnv>();

usersRouter.post("/users", async (c) => {
  const input = await readWrapped<RegisterInput>(c, "user");
  const username = requireString(input.username, "username").trim();
  const email = normEmail(requireString(input.email, "email"));
  assertHumanEmail(email);
  const password = requireString(input.password, "password");
  if (password.length < MIN_PASSWORD) throw tooShort("password", MIN_PASSWORD);
  const d = db(c.env);
  await assertUnique(d, "username", username);
  await assertUnique(d, "email", email);
  const now = new Date().toISOString();
  const row = await d
    .insert(users)
    .values({
      username,
      email,
      passwordHash: await hashPassword(password),
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return c.json({ user: serializeUser(row, await issueToken(row.id, c.env.JWT_SECRET)) }, 201);
});

usersRouter.post("/users/login", async (c) => {
  const input = await readWrapped<{ email: unknown; password: unknown }>(c, "user");
  const email = normEmail(requireString(input.email, "email"));
  const password = requireString(input.password, "password");
  const row = await db(c.env)
    .select()
    .from(users)
    .where(eq(sql`lower(${users.email})`, email))
    .get();
  if (!row || !(await verifyPassword(password, row.passwordHash))) throw credentialsInvalid();
  return c.json({ user: serializeUser(row, await issueToken(row.id, c.env.JWT_SECRET)) });
});

usersRouter.get("/user", requireAuth, async (c) => {
  const id = authedUserId(c);
  const row = await db(c.env).select().from(users).where(eq(users.id, id)).get();
  if (!row) throw tokenInvalid();
  return c.json({ user: serializeUser(row, await issueToken(row.id, c.env.JWT_SECRET)) });
});

usersRouter.put("/user", requireAuth, async (c) => {
  const id = authedUserId(c);
  const input = await readWrapped<UpdateInput>(c, "user");
  const d = db(c.env);
  const patch: Partial<typeof users.$inferInsert> = {};

  if ("username" in input) {
    patch.username = requireString(input.username, "username").trim();
    await assertUnique(d, "username", patch.username, id);
  }
  if ("email" in input) {
    patch.email = normEmail(requireString(input.email, "email"));
    assertHumanEmail(patch.email);
    await assertUnique(d, "email", patch.email, id);
  }
  if ("password" in input) {
    if (input.password === null || input.password === "") throw blank("password");
    if (typeof input.password !== "string") throw blank("password");
    if (input.password.length < MIN_PASSWORD) throw tooShort("password", MIN_PASSWORD);
    patch.passwordHash = await hashPassword(input.password);
  }
  for (const key of ["bio", "image"] as const) {
    if (!(key in input)) continue;
    const v = input[key];
    if (v === null || v === "") patch[key] = null;
    else if (typeof v === "string") {
      if (key === "bio" && v.length > MAX_BIO) {
        throw new ApiError(422, { bio: [`must be ${MAX_BIO} characters or less`] });
      }
      patch[key] = v;
    } else throw new ApiError(422, { [key]: ["is invalid"] });
  }
  patch.updatedAt = new Date().toISOString();

  const row = await d.update(users).set(patch).where(eq(users.id, id)).returning().get();
  if (!row) throw tokenInvalid();
  return c.json({ user: serializeUser(row, await issueToken(row.id, c.env.JWT_SECRET)) });
});
