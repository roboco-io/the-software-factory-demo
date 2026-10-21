import { expect, test, type Page } from "@playwright/test";

// 토론 열기 → 답글 → 답글의 답글 → 다른 사용자의 추천. 책 고정 데이터(book-v1)가 필요하므로 로컬·CI에서만 실행한다.
const local = !process.env.E2E_BASE_URL;

async function signUp(page: Page, id: string) {
  await page.goto("./#/register");
  await page.getByPlaceholder("Username").fill(id);
  await page.getByPlaceholder("Email").fill(`${id}@test.com`);
  await page.getByPlaceholder("Password").fill("password123");
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page.locator("nav").getByRole("link", { name: id, exact: true })).toBeVisible();
}

test("open a topic on a section, reply in a thread and vote", async ({ page, browser }) => {
  test.skip(!local, "책 고정 데이터가 있는 로컬·CI에서만 실행한다");
  const a = `ta${Date.now()}`;
  await signUp(page, a);

  await page.goto("./#/book/ch01?anchor=s01");
  await page.getByRole("link", { name: "이 절에서 토론 열기" }).click();
  await expect(page.getByLabel("절")).toHaveValue("s01");
  await page.getByLabel("유형").selectOption("question");
  await page.getByPlaceholder("토론 제목").fill(`질문 ${a}`);
  await page.getByPlaceholder("무엇을 이야기하고 싶은가요? (마크다운)").fill("**핵심** 질문");
  await page.getByRole("button", { name: "토론 열기" }).click();

  await expect(page.getByRole("heading", { name: `질문 ${a}` })).toBeVisible();
  await expect(page.getByTestId("topic-body").locator("strong")).toHaveText("핵심");
  await expect(
    page.getByRole("link", { name: "1장 시험용 첫 장 · 고객의 문제를 기준으로 삼는다" }),
  ).toBeVisible();

  await page.getByPlaceholder("답글을 쓰세요").fill("첫 답글");
  await page.getByRole("button", { name: "답글 달기" }).click();
  const first = page.locator("[data-reply]").filter({ hasText: "첫 답글" }).first();
  await expect(first).toBeVisible();
  await first.getByRole("button", { name: "답글" }).first().click();
  await first.getByPlaceholder("답글을 쓰세요").fill("답글의 답글");
  await first.getByRole("button", { name: "답글 달기" }).click();
  await expect(first.locator(".reply-children").getByText("답글의 답글")).toBeVisible();
  const url = page.url();

  const other = await browser.newContext();
  const pb = await other.newPage();
  await signUp(pb, `tb${Date.now()}`);
  await pb.goto(url);
  const target = pb.locator("[data-reply]").filter({ hasText: "첫 답글" }).first();
  await target.getByRole("button", { name: "추천 0" }).first().click();
  await expect(target.getByRole("button", { name: "추천 1" }).first()).toBeVisible();
  await other.close();
});
