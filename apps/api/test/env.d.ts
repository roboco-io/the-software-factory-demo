declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("../src/index");
  }
  interface Env {
    DB: D1Database;
    JWT_SECRET: string;
    ALLOWED_ORIGINS: string;
    INTAKE_TOKEN: string;
    BOOK_SYNC_TOKEN: string;
    BOOK_SOURCE_URL?: string;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
