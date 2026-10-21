import { expect, test } from "@playwright/test";

// 읽기 전용: 페이지를 열고 보기만 한다. 입력·클릭·전송을 하지 않는다.
// 화면 문구 대신 고정 표식(smoke-ready)으로 주 목록 로딩 완료를 확인한다. 포럼 전환 중에 홈 화면이 바뀌어도
// 표식만 유지하면 이 스모크를 고치지 않아도 된다(docs/superpowers/specs/2026-10-21-book-forum-design.md 6.3절).
test("home renders the main list from the production API", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { name: "conveyor" })).toBeVisible();
  await expect(page.getByTestId("smoke-ready")).toBeAttached({ timeout: 20_000 });
  await expect(page.locator(".error-messages")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "피드백" })).toBeVisible();
});
