import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext";
import { ArticleList } from "./ArticleList";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

function article(i: number) {
  return {
    slug: `a-${i}`,
    title: `T${i}`,
    description: "d",
    body: "b",
    tagList: [],
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    favorited: false,
    favoritesCount: 0,
    author: { username: "u", bio: null, image: null, following: false },
  };
}

function setup(count: number) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      const offset = Number(/offset=(\d+)/.exec(url)?.[1] ?? 0);
      const n = Math.min(10, count - offset);
      return new Response(
        JSON.stringify({
          articles: Array.from({ length: n }, (_, i) => article(offset + i)),
          articlesCount: count,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
  render(
    <MemoryRouter>
      <AuthProvider>
        <ArticleList query="" />
      </AuthProvider>
    </MemoryRouter>,
  );
  return urls;
}

describe("ArticleList pagination", () => {
  it.each([
    [11, 2],
    [19, 2],
    [20, 2],
    [21, 3],
  ])("count %i -> %i buttons", async (count, buttons) => {
    setup(count);
    await waitFor(() => expect(screen.getAllByRole("button")).toHaveLength(buttons));
  });

  it("no pagination for 10 or fewer", async () => {
    setup(10);
    await screen.findByText("T0");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("last page requests offset 10 and shows the remainder", async () => {
    const urls = setup(11);
    fireEvent.click(await screen.findByRole("button", { name: "2" }));
    await screen.findByText("T10");
    expect(urls.at(-1)).toContain("offset=10");
  });
});

// 프로덕션 스모크(apps/web/e2e-smoke/home.spec.ts)는 이 표식으로 주 목록 로딩 완료를 확인한다.
describe("ArticleList smoke marker", () => {
  it("appears only after the list has loaded, including an empty list", async () => {
    setup(0);
    expect(screen.queryByTestId("smoke-ready")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("smoke-ready")).toBeInTheDocument());
  });

  it("does not appear when loading fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 500 })),
    );
    render(
      <MemoryRouter>
        <AuthProvider>
          <ArticleList query="" />
        </AuthProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.queryByText("Loading articles...")).toBeNull());
    expect(screen.queryByTestId("smoke-ready")).toBeNull();
  });
});
