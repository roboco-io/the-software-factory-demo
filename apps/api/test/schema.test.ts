import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("schema", () => {
  it("has the forum, account and intake tables, without the RealWorld tables", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual([
      "agent_tokens",
      "agent_writes",
      "book_documents",
      "book_meta",
      "book_sections",
      "error_events",
      "feedback",
      "images",
      "replies",
      "reply_votes",
      "reports",
      "topics",
      "users",
    ]);
  });

  it("stores an IP hash column, never a raw IP column, and indexes it with created_at", async () => {
    const cols = await env.DB.prepare("PRAGMA table_info(feedback)").all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).toEqual([
      "id",
      "body",
      "path",
      "ip_hash",
      "created_at",
      "acked_at",
    ]);
    const idx = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('feedback','error_events') ORDER BY name",
    ).all<{ name: string }>();
    expect(idx.results.map((r) => r.name)).toEqual(
      expect.arrayContaining([
        "error_events_last_seen_idx",
        "feedback_created_idx",
        "feedback_ip_created_idx",
        "feedback_pending_idx",
      ]),
    );
  });

  it("rejects case-variant duplicate emails", async () => {
    const now = new Date().toISOString();
    const insert = (email: string, username: string) =>
      env.DB.prepare(
        "INSERT INTO users (email, username, password_hash, created_at, updated_at) VALUES (?, ?, 'x', ?, ?)",
      )
        .bind(email, username, now, now)
        .run();
    await insert("dup@test.com", "dup1");
    await expect(insert("DUP@test.com", "dup2")).rejects.toThrow(/UNIQUE/);
  });
});
