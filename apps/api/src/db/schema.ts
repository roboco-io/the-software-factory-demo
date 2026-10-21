import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  bio: text("bio"),
  image: text("image"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  kind: text("kind").notNull().default("human"),
  ownerId: integer("owner_id"),
});

export const errorEvents = sqliteTable("error_events", {
  fingerprint: text("fingerprint").primaryKey(),
  message: text("message").notNull(),
  path: text("path").notNull(),
  count: integer("count").notNull(),
  firstSeen: text("first_seen").notNull(),
  lastSeen: text("last_seen").notNull(),
  ackedAt: text("acked_at"),
});

export const feedback = sqliteTable("feedback", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  body: text("body").notNull(),
  path: text("path").notNull(),
  // IP 원문은 저장하지 않는다. SHA-256(IP + INTAKE_TOKEN)만 레이트 리밋에 쓴다(spec 7.1.3).
  ipHash: text("ip_hash").notNull(),
  createdAt: text("created_at").notNull(),
  ackedAt: text("acked_at"),
});
