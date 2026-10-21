import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Reply, Topic } from "../api/types";
import { API_BASE } from "../api/client";
import { AuthProvider } from "../auth/AuthContext";
import { TopicPage } from "./TopicPage";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const topic: Topic = {
  id: 7,
  title: "계약은 누가 쓰는가",
  body: "**굵게** <img src=x onerror=alert(1)>",
  kind: "argument",
  author: { username: "alice", image: null },
  book: { docId: "ch05", anchor: "s03", revision: 4, status: "revised" },
  replyCount: 3,
  createdAt: "2026-10-21T00:00:00.000Z",
  updatedAt: "2026-10-21T00:00:00.000Z",
  lastActivityAt: "2026-10-21T00:00:00.000Z",
};

const reply = (over: Partial<Reply>): Reply => ({
  id: 1,
  topicId: 7,
  parentId: null,
  body: "r",
  author: { username: "bob", image: null },
  score: 0,
  voted: false,
  deleted: false,
  createdAt: "2026-10-21T00:00:00.000Z",
  updatedAt: "2026-10-21T00:00:00.000Z",
  ...over,
});

type Call = { url: string; method: string; body?: unknown };

function setup(replies: Reply[], loggedInAs?: string, failReport = false) {
  const calls: Call[] = [];
  if (loggedInAs) localStorage.setItem(`jwt:${API_BASE}`, "tok");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (url.endsWith("/user"))
        return json({
          user: { username: loggedInAs, email: "e", token: "tok", bio: null, image: null },
        });
      if (url.includes("/book/ch05"))
        return json({
          document: {
            docId: "ch05",
            kind: "chapter",
            title: "5장 계약",
            revision: 5,
            topicCount: 1,
            sections: [{ anchor: "s03", heading: "계약의 다섯 연결", topicCount: 1 }],
          },
        });
      if (url.includes("/replies?")) return json({ replies });
      if (url.endsWith("/topics/7")) return json({ topic });
      if (url.includes("/report"))
        return failReport
          ? json({ errors: { reason: ["can't be blank"] } }, 422)
          : json({ report: { id: 1 } }, 201);
      if (url.includes("/vote")) return json({ reply: { ...replies[0]!, score: 1, voted: true } });
      if (url.endsWith("/replies") && method === "POST")
        return json(
          {
            reply: reply({
              id: 99,
              body: "새 답글",
              parentId:
                (JSON.parse(String(init!.body)) as { reply: { parentId?: number } }).reply
                  .parentId ?? null,
            }),
          },
          201,
        );
      return json({});
    }),
  );
  render(
    <MemoryRouter initialEntries={["/topic/7"]}>
      <AuthProvider>
        <Routes>
          <Route path="/topic/:id" element={<TopicPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
  return calls;
}

describe("TopicPage", () => {
  it("renders the sanitized body, the book link with section title and the revision notice", async () => {
    setup([]);
    expect(await screen.findByRole("heading", { name: "계약은 누가 쓰는가" })).toBeInTheDocument();
    const body = screen.getByTestId("topic-body");
    expect(body.querySelector("strong")?.textContent).toBe("굵게");
    expect(body.querySelector("img[onerror]")).toBeNull();
    expect(screen.getByText("반론")).toBeInTheDocument();
    expect(
      await screen.findByRole("link", { name: /5장 계약 · 계약의 다섯 연결/ }),
    ).toHaveAttribute("href", "/book/ch05?anchor=s03");
    expect(screen.getByText(/이 토론 이후 책이 개정됨/)).toBeInTheDocument();
  });

  it("shows nested replies and deleted placeholders", async () => {
    setup([
      reply({ id: 1, body: "부모" }),
      reply({ id: 2, parentId: 1, body: "자식" }),
      reply({ id: 3, deleted: true, body: "" }),
      reply({ id: 4, parentId: 3, body: "남은 자식" }),
    ]);
    const parent = (await screen.findByText("부모")).closest("[data-reply]")!;
    expect(within(parent as HTMLElement).getByText("자식")).toBeInTheDocument();
    expect(screen.getByText("삭제된 답글입니다.")).toBeInTheDocument();
  });

  it("switches to the top sort", async () => {
    const calls = setup([]);
    await screen.findByRole("heading", { name: "계약은 누가 쓰는가" });
    fireEvent.click(screen.getByRole("button", { name: "추천순" }));
    await waitFor(() => expect(calls.some((c) => c.url.includes("/replies?sort=top"))).toBe(true));
  });

  it("lets a signed-in user reply to a reply and vote on someone else's reply", async () => {
    const calls = setup(
      [reply({ id: 1, body: "부모", author: { username: "bob", image: null } })],
      "carol",
    );
    const parent = (await screen.findByText("부모")).closest("[data-reply]") as HTMLElement;
    fireEvent.click(within(parent).getByRole("button", { name: "추천 0" }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith("/replies/1/vote") && c.method === "POST")).toBe(
        true,
      ),
    );
    fireEvent.click(within(parent).getByRole("button", { name: "답글" }));
    fireEvent.change(within(parent).getByPlaceholderText("답글을 쓰세요"), {
      target: { value: "대댓글" },
    });
    fireEvent.click(within(parent).getByRole("button", { name: "답글 달기" }));
    await waitFor(() => {
      const post = calls.find((c) => c.url.endsWith("/topics/7/replies") && c.method === "POST");
      expect(post?.body).toEqual({ reply: { body: "대댓글", parentId: 1 } });
    });
  });

  it("does not offer voting on your own reply", async () => {
    setup([reply({ id: 1, body: "내 답글", author: { username: "carol", image: null } })], "carol");
    const mine = (await screen.findByText("내 답글")).closest("[data-reply]") as HTMLElement;
    await waitFor(() =>
      expect(within(mine).getByRole("button", { name: "삭제" })).toBeInTheDocument(),
    );
    expect(within(mine).queryByRole("button", { name: /추천/ })).toBeNull();
  });

  it("keeps the reason and shows no success notice when a report fails", async () => {
    setup([reply({ id: 1, body: "부모" })], "carol", true);
    const parent = (await screen.findByText("부모")).closest("[data-reply]") as HTMLElement;
    fireEvent.click(within(parent).getByRole("button", { name: "신고" }));
    const box = within(parent).getByPlaceholderText("답글을 쓰세요");
    fireEvent.change(box, { target: { value: "  " } });
    fireEvent.click(within(parent).getByRole("button", { name: "신고하기" }));
    expect(await screen.findByText("reason can't be blank")).toBeInTheDocument();
    expect(screen.queryByText("신고를 접수했습니다.")).toBeNull();
    expect(
      (within(parent).getByPlaceholderText("답글을 쓰세요") as HTMLTextAreaElement).value,
    ).toBe("  ");
  });

  it("shows the notice only after a successful report", async () => {
    setup([reply({ id: 1, body: "부모" })], "carol");
    const parent = (await screen.findByText("부모")).closest("[data-reply]") as HTMLElement;
    fireEvent.click(within(parent).getByRole("button", { name: "신고" }));
    fireEvent.change(within(parent).getByPlaceholderText("답글을 쓰세요"), {
      target: { value: "광고" },
    });
    fireEvent.click(within(parent).getByRole("button", { name: "신고하기" }));
    expect(await screen.findByText("신고를 접수했습니다.")).toBeInTheDocument();
  });

  it("asks before deleting a reply and does nothing when cancelled", async () => {
    const calls = setup(
      [reply({ id: 1, body: "내 답글", author: { username: "carol", image: null } })],
      "carol",
    );
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const mine = (await screen.findByText("내 답글")).closest("[data-reply]") as HTMLElement;
    fireEvent.click(await within(mine).findByRole("button", { name: "삭제" }));
    expect(confirm).toHaveBeenCalled();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("marks the active sort and labels the reply box", async () => {
    setup([], "carol");
    await screen.findByRole("heading", { name: "계약은 누가 쓰는가" });
    expect(screen.getByRole("button", { name: "작성순" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "추천순" })).toHaveAttribute("aria-pressed", "false");
    expect(await screen.findByLabelText("답글 내용")).toBeInTheDocument();
  });
});
