import { expect, test } from "@playwright/test";

// 읽기 전용: 페이지를 열고 보기만 한다. 입력·클릭·전송을 하지 않는다.
test("home renders the article list from the production API", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { name: "conveyor" })).toBeVisible();
  await expect(page.getByText("Global Feed")).toBeVisible();
  await expect(page.getByText("Loading articles...")).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator(".error-messages")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "피드백" })).toBeVisible();
});
