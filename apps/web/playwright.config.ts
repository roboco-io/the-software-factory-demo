import { defineConfig, devices } from "@playwright/test";

const raw = process.env.E2E_BASE_URL;
const external = raw && !raw.endsWith("/") ? `${raw}/` : raw;
const root = new URL("../..", import.meta.url).pathname;
// 워크트리마다 포트를 나눌 수 있도록 환경 변수로 바꿀 수 있다(AGENTS.md 병렬 작업 규칙).
const webPort = process.env.E2E_WEB_PORT ?? "4173";
const apiPort = process.env.E2E_API_PORT ?? "8787";
const bookPort = process.env.E2E_BOOK_PORT ?? "8791";
process.env.E2E_API_BASE ??= `http://localhost:${apiPort}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: external ?? `http://localhost:${webPort}/`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  globalSetup: external ? undefined : "./e2e/global-setup.ts",
  webServer: external
    ? undefined
    : [
        {
          command: `python3 -m http.server ${bookPort} --bind 127.0.0.1`,
          cwd: `${root}tests/forum/vendor/fixtures/book-v1`,
          url: `http://127.0.0.1:${bookPort}/website/content-manifest.json`,
          reuseExistingServer: !process.env.CI,
          timeout: 30_000,
        },
        {
          // 책 동기화는 포럼 계약의 고정 데이터(book-v1)를 로컬 서버로 내보내 --test-scheduled로 실행한다(e2e/global-setup.ts).
          command: `rm -rf .wrangler/state && pnpm exec wrangler d1 migrations apply sfd-prod --local && pnpm exec wrangler dev --port ${apiPort} --test-scheduled --var JWT_SECRET:e2e-local --var BOOK_SOURCE_URL:http://127.0.0.1:${bookPort} --var ALLOWED_ORIGINS:http://localhost:${webPort}`,
          cwd: `${root}apps/api`,
          url: `http://localhost:${apiPort}/api/health`,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
        {
          command: `pnpm build && pnpm exec vite preview --port ${webPort} --strictPort`,
          cwd: `${root}apps/web`,
          env: { VITE_API_BASE: `http://localhost:${apiPort}/api` },
          url: `http://localhost:${webPort}/`,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      ],
});
