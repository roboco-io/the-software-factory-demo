import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext";
import { Profile } from "./Profile";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Profile", () => {
  it("lists the user's topics", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        urls.push(url);
        const body = url.includes("/profiles/")
          ? { profile: { username: "alice", bio: null, image: null, following: false } }
          : { topics: [], topicsCount: 0 };
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    render(
      <MemoryRouter initialEntries={["/profile/alice"]}>
        <AuthProvider>
          <Routes>
            <Route path="/profile/:username" element={<Profile />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: "alice" })).toBeInTheDocument();
    expect(screen.getByText("작성한 토론")).toBeInTheDocument();
    await waitFor(() => expect(urls.some((u) => u.includes("/topics?author=alice&"))).toBe(true));
    expect(urls.some((u) => u.includes("/articles"))).toBe(false);
  });
});
