import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Topic } from "../api/types";
import { AuthProvider } from "../auth/AuthContext";
import { TopicList } from "./TopicList";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const topic = (over: Partial<Topic>): Topic => ({
  id: 1,
  title: "t",
  body: "b",
  kind: "question",
  author: { username: "u", image: null },
  book: null,
  replyCount: 0,
  createdAt: "2026-10-21T00:00:00.000Z",
  updatedAt: "2026-10-21T00:00:00.000Z",
  lastActivityAt: "2026-10-21T00:00:00.000Z",
  ...over,
});

function setup(topics: Topic[], status = 200) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ topics, topicsCount: topics.length }), { status });
    }),
  );
  render(
    <MemoryRouter>
      <AuthProvider>
        <TopicList query="docId=ch01&anchor=s01" />
      </AuthProvider>
    </MemoryRouter>,
  );
  return urls;
}

describe("TopicList", () => {
  it("requests topics by recent activity with the given filter", async () => {
    const urls = setup([]);
    await waitFor(() => expect(urls.some((u) => u.includes("/topics?"))).toBe(true));
    const url = urls.find((u) => u.includes("/topics?"))!;
    expect(url).toContain("docId=ch01&anchor=s01");
    expect(url).toContain("sort=activity");
  });

  it("shows kind, book link state and reply count, and links to the topic", async () => {
    setup([
      topic({
        id: 7,
        title: "개정 질문",
        replyCount: 3,
        book: { docId: "ch01", anchor: "s01", revision: 11, status: "revised" },
      }),
      topic({
        id: 8,
        title: "사라진 절",
        kind: "argument",
        book: { docId: "ch02", anchor: "s02", revision: 5, status: "removed" },
      }),
    ]);
    await screen.findByText("개정 질문");
    expect(screen.getByText("개정 질문").closest("a")?.getAttribute("href")).toBe("/topic/7");
    expect(screen.getByText("질문")).toBeInTheDocument();
    expect(screen.getByText("반론")).toBeInTheDocument();
    expect(screen.getByText("이 토론 이후 책이 개정됨")).toBeInTheDocument();
    expect(screen.getByText("현재 판본에 없는 절")).toBeInTheDocument();
    expect(screen.getByText("답글 3")).toBeInTheDocument();
  });

  it("renders the smoke marker after loading, also for an empty list, but not on failure", async () => {
    setup([]);
    await waitFor(() => expect(screen.getByTestId("smoke-ready")).toBeInTheDocument());
    expect(screen.getByText("아직 토론이 없습니다.")).toBeInTheDocument();
  });

  it("does not render the smoke marker when loading fails", async () => {
    setup([], 500);
    await waitFor(() => expect(document.querySelector(".error-messages")).not.toBeNull());
    expect(screen.queryByTestId("smoke-ready")).toBeNull();
  });

  it("reads the book titles once for several lists sharing a client", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        urls.push(String(input));
        return new Response(JSON.stringify({ topics: [], topicsCount: 0 }), { status: 200 });
      }),
    );
    render(
      <MemoryRouter>
        <AuthProvider>
          <TopicList query="docId=ch01" />
          <TopicList query="docId=ch02" />
        </AuthProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(urls.filter((u) => u.includes("/topics?")).length).toBe(2));
    expect(urls.filter((u) => u.endsWith("/book")).length).toBe(1);
  });

  it("labels topics written by an agent with its owner", async () => {
    setup([
      topic({
        id: 9,
        title: "에이전트 요약",
        author: { username: "reader", image: null, kind: "agent", owner: "alice" },
      }),
    ]);
    await screen.findByText("에이전트 요약");
    expect(screen.getByText("에이전트")).toBeInTheDocument();
    expect(screen.getByText("등록: alice")).toBeInTheDocument();
  });
});
