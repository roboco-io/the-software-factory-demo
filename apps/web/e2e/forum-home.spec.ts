import { expect, test } from "@playwright/test";

// 홈과 장 화면. 로컬·CI에서는 포럼 계약의 고정 데이터(book-v1)로 동기화된 책을 쓴다.
// PR 프리뷰처럼 외부 대상이면 책 데이터와 API 주소를 알 수 없으므로 홈 구조만 확인한다.
const local = !process.env.E2E_BASE_URL;
const API = `${process.env.E2E_API_BASE ?? "http://localhost:8787"}/api`;

test("home shows recent topics and the book table of contents", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { name: "conveyor" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "최근 토론" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "책 목차" })).toBeVisible();
  await expect(page.getByTestId("smoke-ready")).toBeAttached({ timeout: 20_000 });
});

test("a topic on a section appears on the home and on the chapter page", async ({
  page,
  request,
}) => {
  test.skip(!local, "외부 대상은 API 주소와 책 데이터를 알 수 없다");
  const id = `fh${Date.now()}`;
  const user = await request.post(`${API}/users`, {
    data: { user: { username: id, email: `${id}@test.com`, password: "password123" } },
  });
  const { user: u } = (await user.json()) as { user: { token: string } };
  const created = await request.post(`${API}/topics`, {
    headers: { authorization: `Token ${u.token}` },
    data: {
      topic: {
        title: `절 토론 ${id}`,
        body: "본문",
        kind: "question",
        docId: "ch01",
        anchor: "s01",
      },
    },
  });
  expect(created.status()).toBe(201);

  await page.goto("./");
  await expect(page.getByRole("link", { name: `절 토론 ${id}` })).toBeVisible();
  await page.getByRole("link", { name: /1장 시험용 첫 장/ }).click();
  await expect(page.getByRole("heading", { name: "1장 시험용 첫 장" })).toBeVisible();
  await expect(page.getByRole("link", { name: "책에서 읽기" })).toHaveAttribute(
    "href",
    "https://factory.roboco.io/book/ch01/",
  );
  await page.getByRole("link", { name: /고객의 문제를 기준으로 삼는다/ }).click();
  await expect(page.getByRole("heading", { name: "고객의 문제를 기준으로 삼는다" })).toBeVisible();
  await expect(page.getByRole("link", { name: `절 토론 ${id}` })).toBeVisible();
  await expect(page.getByRole("link", { name: "책에서 이 절 읽기" })).toHaveAttribute(
    "href",
    "https://factory.roboco.io/book/ch01/#s01",
  );
});
