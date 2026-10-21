import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext";
import { BookPage } from "./BookPage";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

function setup(path: string, status = 200) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/book/")) {
        if (status !== 200)
          return new Response(JSON.stringify({ errors: { document: ["not found"] } }), { status });
        return new Response(
          JSON.stringify({
            document: {
              docId: "ch05",
              kind: "chapter",
              title: "5장 의도를 실행 계약으로 바꾼다",
              revision: 5,
              topicCount: 1,
              sections: [
                { anchor: "s01", heading: "무엇을 알면 일을 맡길 수 있는가", topicCount: 1 },
                { anchor: "s02", heading: "목적을 작업의 입력과 결과에 연결한다", topicCount: 0 },
              ],
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ topics: [], topicsCount: 0 }), { status: 200 });
    }),
  );
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Routes>
          <Route path="/book/:docId" element={<BookPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
  return urls;
}

describe("BookPage", () => {
  it("lists sections with counts and links to the book and to section filters", async () => {
    const urls = setup("/book/ch05");
    expect(
      await screen.findByRole("heading", { name: "5장 의도를 실행 계약으로 바꾼다" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "책에서 읽기" }).getAttribute("href")).toBe(
      "https://factory.roboco.io/book/ch05/",
    );
    const s1 = screen.getByRole("link", { name: /무엇을 알면 일을 맡길 수 있는가/ });
    expect(s1.getAttribute("href")).toBe("/book/ch05?anchor=s01");
    await waitFor(() => expect(urls.some((u) => u.includes("/topics?docId=ch05&"))).toBe(true));
  });

  it("filters topics by the selected section", async () => {
    const urls = setup("/book/ch05?anchor=s02");
    await screen.findByRole("heading", { name: "5장 의도를 실행 계약으로 바꾼다" });
    await waitFor(() =>
      expect(urls.some((u) => u.includes("/topics?docId=ch05&anchor=s02&"))).toBe(true),
    );
    expect(screen.getByRole("link", { name: "책에서 이 절 읽기" }).getAttribute("href")).toBe(
      "https://factory.roboco.io/book/ch05/#s02",
    );
  });

  it("shows the API error for an unknown document", async () => {
    setup("/book/ch99", 404);
    expect(await screen.findByText("document not found")).toBeInTheDocument();
  });
});
