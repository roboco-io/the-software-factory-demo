import { nodeModule } from "./node";

interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint };
  all(...params: unknown[]): Record<string, unknown>[];
}
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

/** A D1-shaped adapter over node:sqlite, so tests run the real SQL. */
export function createTestD1(migrations: string[]) {
  const { DatabaseSync } = nodeModule<{
    DatabaseSync: new (path: string) => SqliteDb;
  }>("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const sql of migrations) db.exec(sql);

  class Stmt {
    params: unknown[] = [];
    constructor(readonly sql: string) {}
    bind(...values: unknown[]) {
      this.params = values;
      return this;
    }
    async run() {
      const r = db.prepare(this.sql).run(...this.params);
      return { meta: { changes: Number(r.changes) } };
    }
    async first() {
      return db.prepare(this.sql).all(...this.params)[0] ?? null;
    }
    async all() {
      return { results: db.prepare(this.sql).all(...this.params) };
    }
  }
  const d1 = {
    prepare: (sql: string) => new Stmt(sql),
    async batch(stmts: Stmt[]) {
      db.exec("BEGIN");
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return {
    d1,
    query: (sql: string, ...params: unknown[]) =>
      db.prepare(sql).all(...params),
    exec: (sql: string) => db.exec(sql),
  };
}

export function readMigrations(): string[] {
  const fs = nodeModule<{
    readFileSync(p: string, e: string): string;
    readdirSync(p: string): string[];
  }>("node:fs");
  const cwd = (
    globalThis as unknown as { process: { cwd(): string } }
  ).process.cwd();
  const dir = `${cwd}/migrations/`;
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => fs.readFileSync(`${dir}${f}`, "utf8"));
}
