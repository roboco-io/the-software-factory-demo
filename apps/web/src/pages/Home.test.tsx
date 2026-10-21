import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext";
import { Home } from "./Home";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Home", () => {
  it("shows recent topics and the book table of contents with topic counts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const body = url.includes("/book")
          ? {
              documents: [
                { docId: "preface", kind: "preface", title: "머리말", revision: 3, topicCount: 0 },
                { docId: "ch01", kind: "chapter", title: "1장 첫 장", revision: 11, topicCount: 2 },
              ],
              syncedAt: "2026-10-21T05:17:51.632Z",
            }
          : { topics: [], topicsCount: 0 };
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    render(
      <MemoryRouter>
        <AuthProvider>
          <Home />
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: "conveyor" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "최근 토론" })).toBeInTheDocument();
    const ch = await screen.findByRole("link", { name: /1장 첫 장/ });
    expect(ch.getAttribute("href")).toBe("/book/ch01");
    expect(ch.textContent).toContain("2");
    expect(screen.getByText(/마지막 동기화/)).toBeInTheDocument();
  });
});
