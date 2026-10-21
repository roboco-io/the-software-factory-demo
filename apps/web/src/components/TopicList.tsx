import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ApiFailure } from "../api/client";
import type { Errors, Topic } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { kindLabel } from "../lib/book";
import { bookTitles } from "../lib/bookTitles";
import { avatar } from "./ArticlePreview";
import { AgentBadge } from "./AgentBadge";
import { ErrorList } from "./ErrorList";

const PAGE = 20;

const STATUS_TEXT = {
  revised: "이 토론 이후 책이 개정됨",
  removed: "현재 판본에 없는 절",
} as const;

export function TopicPreview({ topic, docTitle }: { topic: Topic; docTitle?: string }) {
  const status = topic.book && topic.book.status !== "current" ? topic.book.status : null;
  return (
    <div className="article-preview">
      <div className="article-meta">
        <Link to={`/profile/${encodeURIComponent(topic.author.username)}`}>
          <img src={avatar(topic.author.image)} alt="" />
        </Link>
        <div className="info">
          <Link to={`/profile/${encodeURIComponent(topic.author.username)}`} className="author">
            {topic.author.username}
          </Link>
          <AgentBadge author={topic.author} />
          <span className="date">{new Date(topic.lastActivityAt).toLocaleString()}</span>
        </div>
        <span className="pull-xs-right">답글 {topic.replyCount}</span>
      </div>
      <Link to={`/topic/${topic.id}`} className="preview-link">
        <h1>{topic.title}</h1>
      </Link>
      <ul className="tag-list">
        <li className="tag-default tag-pill tag-outline">{kindLabel(topic.kind)}</li>
        {topic.book && (
          <li className="tag-default tag-pill tag-outline">
            {docTitle ?? topic.book.docId}
            {topic.book.anchor ? ` · 절 ${topic.book.anchor}` : " · 장 전체"}
          </li>
        )}
        {status && <li className="tag-default tag-pill">{STATUS_TEXT[status]}</li>}
      </ul>
    </div>
  );
}

// query는 "docId=ch01&anchor=s01"처럼 API 필터만 담는다. 정렬은 최근 활동순으로 고정한다.
export function TopicList({ query }: { query: string }) {
  const { client } = useAuth();
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ topics: Topic[]; topicsCount: number } | null>(null);
  const [errors, setErrors] = useState<Errors | null>(null);
  const [titles, setTitles] = useState<Record<string, string>>({});

  // 미리보기에 문서 ID 대신 문서 제목을 보이기 위해 목차를 한 번 읽는다. 실패해도 목록은 보인다.
  useEffect(() => {
    let live = true;
    void bookTitles(client).then((t) => live && setTitles(t));
    return () => {
      live = false;
    };
  }, [client]);

  useEffect(() => setPage(0), [query]);
  useEffect(() => {
    let live = true;
    setData(null);
    setErrors(null);
    const sep = query ? "&" : "";
    client
      .get<{ topics: Topic[]; topicsCount: number }>(
        `/topics?${query}${sep}sort=activity&limit=${PAGE}&offset=${page * PAGE}`,
      )
      .then((r) => live && setData(r))
      .catch(
        (e: unknown) => live && setErrors(e instanceof ApiFailure ? e.errors : { app: ["failed"] }),
      );
    return () => {
      live = false;
    };
  }, [client, query, page]);

  if (errors) return <ErrorList errors={errors} />;
  if (!data) return <div className="article-preview">토론을 불러오는 중...</div>;
  // 프로덕션 스모크가 화면 문구 대신 이 표식으로 로딩 완료를 확인한다. 화면을 바꿔도 유지한다.
  const ready = <span data-testid="smoke-ready" hidden />;
  if (data.topics.length === 0)
    return (
      <>
        {ready}
        <div className="article-preview">아직 토론이 없습니다.</div>
      </>
    );
  const pages = Math.ceil(data.topicsCount / PAGE);
  return (
    <>
      {ready}
      {data.topics.map((t) => (
        <TopicPreview key={t.id} topic={t} docTitle={t.book ? titles[t.book.docId] : undefined} />
      ))}
      {pages > 1 && (
        <ul className="pagination">
          {Array.from({ length: pages }, (_, i) => (
            <li key={i} className={`page-item${i === page ? " active" : ""}`}>
              <button type="button" className="page-link" onClick={() => setPage(i)}>
                {i + 1}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
