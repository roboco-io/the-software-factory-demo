import { expect, test } from "@playwright/test";

// 계정 흐름: 가입 → 토론 열기 → 로그아웃 → 로그인 → 프로필에서 내 토론 확인. 책 데이터가 없어도 된다.
test("sign up → open a topic → logout → sign in → see it on the profile", async ({ page }) => {
  const id = `e2e${Date.now()}`;
  await page.goto("./#/register");
  await page.getByPlaceholder("Username").fill(id);
  await page.getByPlaceholder("Email").fill(`${id}@test.com`);
  await page.getByPlaceholder("Password").fill("password123");
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page.locator("nav").getByRole("link", { name: id, exact: true })).toBeVisible();

  await page.locator("nav").getByRole("link", { name: "새 토론" }).click();
  await page.getByPlaceholder("토론 제목").fill(`Hello ${id}`);
  await page
    .getByPlaceholder("무엇을 이야기하고 싶은가요? (마크다운)")
    .fill("**bold** <img src=x onerror=alert(1)>");
  await page.getByRole("button", { name: "토론 열기" }).click();

  await expect(page.getByRole("heading", { name: `Hello ${id}` })).toBeVisible();
  const body = page.getByTestId("topic-body");
  await expect(body.locator("strong")).toHaveText("bold");
  await expect(body.locator("img[onerror]")).toHaveCount(0);

  await page.locator("nav").getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Or click here to logout." }).click();
  await expect(page.locator("nav").getByRole("link", { name: "Sign in" })).toBeVisible();

  await page.locator("nav").getByRole("link", { name: "Sign in" }).click();
  await page.getByPlaceholder("Email").fill(`${id}@test.com`);
  await page.getByPlaceholder("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.locator("nav").getByRole("link", { name: id, exact: true }).click();
  await expect(page.getByText("작성한 토론")).toBeVisible();
  await expect(page.getByRole("link", { name: `Hello ${id}` })).toBeVisible();
});
