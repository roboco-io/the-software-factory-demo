import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_BASE } from "../api/client";
import { AuthProvider } from "../auth/AuthContext";
import { TopicEditor } from "./TopicEditor";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

function setup(path: string) {
  localStorage.setItem(`jwt:${API_BASE}`, "tok");
  const posts: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (url.endsWith("/user"))
        return json({
          user: { username: "carol", email: "e", token: "tok", bio: null, image: null },
        });
      if (url.endsWith("/book"))
        return json({
          documents: [
            { docId: "ch01", kind: "chapter", title: "1장", revision: 1, topicCount: 0 },
            { docId: "ch05", kind: "chapter", title: "5장 계약", revision: 5, topicCount: 0 },
          ],
          syncedAt: null,
        });
      if (url.includes("/book/ch05"))
        return json({
          document: {
            docId: "ch05",
            kind: "chapter",
            title: "5장 계약",
            revision: 5,
            topicCount: 0,
            sections: [
              { anchor: "s01", heading: "첫 절", topicCount: 0 },
              { anchor: "s03", heading: "계약의 다섯 연결", topicCount: 0 },
            ],
          },
        });
      if (url.endsWith("/topics") && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return json({ topic: { id: 42 } }, 201);
      }
      return json({});
    }),
  );
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Routes>
          <Route path="/new" element={<TopicEditor />} />
          <Route path="/topic/:id" element={<p>topic page</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
  return posts;
}

describe("TopicEditor", () => {
  it("prefills the chapter and section from the query and posts the topic", async () => {
    const posts = setup("/new?docId=ch05&anchor=s03");
    const section = (await screen.findByLabelText("절")) as HTMLSelectElement;
    await waitFor(() => expect(section.value).toBe("s03"));
    expect((screen.getByLabelText("장") as HTMLSelectElement).value).toBe("ch05");
    fireEvent.change(screen.getByPlaceholderText("토론 제목"), { target: { value: "제목" } });
    fireEvent.change(screen.getByPlaceholderText("무엇을 이야기하고 싶은가요? (마크다운)"), {
      target: { value: "본문" },
    });
    fireEvent.change(screen.getByLabelText("유형"), { target: { value: "question" } });
    fireEvent.click(screen.getByRole("button", { name: "토론 열기" }));
    await screen.findByText("topic page");
    expect(posts).toEqual([
      { topic: { title: "제목", body: "본문", kind: "question", docId: "ch05", anchor: "s03" } },
    ]);
  });

  it("omits the book fields for a topic not tied to the book", async () => {
    const posts = setup("/new");
    await screen.findByLabelText("장");
    fireEvent.change(screen.getByPlaceholderText("토론 제목"), { target: { value: "t" } });
    fireEvent.change(screen.getByPlaceholderText("무엇을 이야기하고 싶은가요? (마크다운)"), {
      target: { value: "b" },
    });
    fireEvent.click(screen.getByRole("button", { name: "토론 열기" }));
    await screen.findByText("topic page");
    expect(posts).toEqual([{ topic: { title: "t", body: "b", kind: "general" } }]);
  });
});
