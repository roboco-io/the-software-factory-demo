import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_BASE } from "../api/client";
import { AuthProvider } from "../auth/AuthContext";
import { TopicPreview } from "../components/TopicList";
import { Profile } from "./Profile";
import { Settings } from "./Settings";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const base = { email: "u@test.com", token: "jwt-1", username: "u", bio: null };
const URL1 = "https://api.test/api/images/7";

describe("Settings image upload", () => {
  it("uploads the chosen file and shows the returned URL", async () => {
    localStorage.setItem(`jwt:${API_BASE}`, "jwt-1");
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        const post = init?.method === "POST";
        const user = { ...base, image: post ? URL1 : null };
        return new Response(JSON.stringify(post ? { image: URL1, user } : { user }), {
          status: 200,
        });
      }),
    );
    render(
      <AuthProvider>
        <MemoryRouter>
          <Settings />
        </MemoryRouter>
      </AuthProvider>,
    );
    const input = await screen.findByLabelText("Upload profile picture");
    const file = new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() =>
      expect(screen.getByPlaceholderText("URL of profile picture")).toHaveValue(URL1),
    );
    const post = calls.find((c) => c.init?.method === "POST")!;
    expect(post.url).toBe(`${API_BASE}/user/image`);
    expect((post.init!.headers as Record<string, string>)["content-type"]).toBe("image/png");
  });

  it("reflects the uploaded image on the profile page and topic list", async () => {
    localStorage.setItem(`jwt:${API_BASE}`, "jwt-1");
    const topic = {
      id: 1,
      title: "T",
      body: "b",
      kind: "general" as const,
      author: { username: "u", image: URL1 },
      book: null,
      replyCount: 0,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      lastActivityAt: "2024-01-01T00:00:00.000Z",
    };
    let uploaded = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = String(url).replace(API_BASE, "");
        let body: unknown;
        if (init?.method === "POST") {
          uploaded = true;
          body = { image: URL1, user: { ...base, image: URL1 } };
        } else if (path.startsWith("/profiles/")) {
          body = {
            profile: { username: "u", bio: null, image: uploaded ? URL1 : null, following: false },
          };
        } else if (path.startsWith("/topics")) {
          body = { topics: uploaded ? [topic] : [], topicsCount: uploaded ? 1 : 0 };
        } else {
          body = { user: { ...base, image: uploaded ? URL1 : null } };
        }
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    const { container } = render(
      <AuthProvider>
        <MemoryRouter initialEntries={["/settings"]}>
          <Routes>
            <Route path="/settings" element={<Settings />} />
            <Route path="/profile/:username" element={<Profile />} />
          </Routes>
          <Link to="/profile/u">go profile</Link>
        </MemoryRouter>
      </AuthProvider>,
    );
    const input = await screen.findByLabelText("Upload profile picture");
    const file = new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() =>
      expect(screen.getByPlaceholderText("URL of profile picture")).toHaveValue(URL1),
    );
    fireEvent.click(screen.getByText("go profile"));
    await waitFor(() =>
      expect(container.querySelector("img.user-img")).toHaveAttribute("src", URL1),
    );
    await waitFor(() =>
      expect(container.querySelector(".article-preview img")).toHaveAttribute("src", URL1),
    );
  });

  it("blocks saving settings while an upload is in flight", async () => {
    localStorage.setItem(`jwt:${API_BASE}`, "jwt-1");
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const puts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          await gate;
          return new Response(JSON.stringify({ image: URL1, user: { ...base, image: URL1 } }));
        }
        if (init?.method === "PUT") puts.push(String(init.body));
        return new Response(JSON.stringify({ user: { ...base, image: null } }));
      }),
    );
    render(
      <AuthProvider>
        <MemoryRouter>
          <Settings />
        </MemoryRouter>
      </AuthProvider>,
    );
    const input = await screen.findByLabelText("Upload profile picture");
    const file = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });
    const btn = screen.getByText("Update Settings");
    await waitFor(() => expect(btn).toBeDisabled());
    fireEvent.submit(btn.closest("form")!);
    expect(puts).toHaveLength(0);
    release();
    await waitFor(() => expect(btn).not.toBeDisabled());
    expect(screen.getByPlaceholderText("URL of profile picture")).toHaveValue(URL1);
  });

  it("renders the uploaded image as the topic avatar", () => {
    const topic = {
      id: 1,
      title: "T",
      body: "b",
      kind: "general" as const,
      author: { username: "u", image: URL1 },
      book: null,
      replyCount: 0,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      lastActivityAt: "2024-01-01T00:00:00.000Z",
    };
    const { container } = render(
      <MemoryRouter>
        <TopicPreview topic={topic} />
      </MemoryRouter>,
    );
    expect(container.querySelector("img")).toHaveAttribute("src", URL1);
  });
});
