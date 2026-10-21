import { expect, test } from "@playwright/test";

test("sign up → publish article → comment → logout → sign in", async ({ page }) => {
  const id = `e2e${Date.now()}`;
  await page.goto("./#/register");
  await page.getByPlaceholder("Username").fill(id);
  await page.getByPlaceholder("Email").fill(`${id}@test.com`);
  await page.getByPlaceholder("Password").fill("password123");
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page.locator("nav").getByRole("link", { name: id, exact: true })).toBeVisible();

  await page.locator("nav").getByRole("link", { name: "New Article" }).click();
  await page.getByPlaceholder("Article Title").fill(`Hello ${id}`);
  await page.getByPlaceholder("What's this article about?").fill("smoke");
  await page
    .getByPlaceholder("Write your article (in markdown)")
    .fill("**bold** <img src=x onerror=alert(1)>");
  await page.getByPlaceholder("Enter tags").fill("smoke, e2e");
  await page.getByRole("button", { name: "Publish Article" }).click();

  await expect(page.getByRole("heading", { name: `Hello ${id}` })).toBeVisible();
  const body = page.getByTestId("article-body");
  await expect(body.locator("strong")).toHaveText("bold");
  await expect(body.locator("img[onerror]")).toHaveCount(0);

  await page.getByPlaceholder("Write a comment...").fill("first comment");
  await page.getByRole("button", { name: "Post Comment" }).click();
  await expect(page.locator(".card .card-text")).toHaveText(["first comment"]);

  await page.locator("nav").getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Or click here to logout." }).click();
  await expect(page.locator("nav").getByRole("link", { name: "Sign in" })).toBeVisible();

  await page.locator("nav").getByRole("link", { name: "Sign in" }).click();
  await page.getByPlaceholder("Email").fill(`${id}@test.com`);
  await page.getByPlaceholder("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("nav").getByRole("link", { name: id, exact: true })).toBeVisible();
  // 홈은 포럼 목록으로 바뀌었으므로 글은 작성자 프로필에서 확인한다.
  await page.locator("nav").getByRole("link", { name: id, exact: true }).click();
  await expect(page.getByText(`Hello ${id}`)).toBeVisible();
});
