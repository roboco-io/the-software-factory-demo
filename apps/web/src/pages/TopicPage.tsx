import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ApiFailure } from "../api/client";
import type { BookDocument, BookSection, Errors, Reply, Topic } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { avatar } from "../components/ArticlePreview";
import { ErrorList } from "../components/ErrorList";
import { bookUrl, kindLabel } from "../lib/book";
import { renderMarkdown } from "../lib/markdown";
import { buildThread, MAX_INDENT, type ThreadNode } from "../lib/thread";

type Sort = "old" | "top";
type Doc = BookDocument & { sections: BookSection[] };

const STATUS_TEXT = {
  revised: "이 토론 이후 책이 개정됨",
  removed: "현재 판본에 없는 절",
} as const;

function ReplyForm({
  label = "답글 내용",
  submitLabel,
  initial = "",
  onSubmit,
  onCancel,
}: {
  label?: string;
  submitLabel: string;
  initial?: string;
  onSubmit: (body: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const [body, setBody] = useState(initial);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await onSubmit(body);
      setBody("");
    } catch {
      // 오류는 상위 화면의 ErrorList가 보여 준다. 입력은 그대로 둔다.
    }
  }
  return (
    <form className="card comment-form" onSubmit={submit}>
      <div className="card-block">
        <textarea
          className="form-control"
          placeholder="답글을 쓰세요"
          aria-label={label}
          rows={3}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </div>
      <div className="card-footer">
        <button className="btn btn-sm btn-primary" type="submit">
          {submitLabel}
        </button>{" "}
        {onCancel && (
          <button className="btn btn-sm btn-outline-secondary" type="button" onClick={onCancel}>
            취소
          </button>
        )}
      </div>
    </form>
  );
}

export function TopicPage() {
  const { id = "" } = useParams();
  const { user, client } = useAuth();
  const navigate = useNavigate();
  const [topic, setTopic] = useState<Topic | null>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [replies, setReplies] = useState<Reply[]>([]);
  const [sort, setSort] = useState<Sort>("old");
  const [open, setOpen] = useState<{ id: number; mode: "reply" | "edit" | "report" } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors | null>(null);

  const fail = (e: unknown) => setErrors(e instanceof ApiFailure ? e.errors : { app: ["failed"] });

  // 정렬을 빠르게 바꾸면 늦게 온 이전 응답이 덮어쓰지 않도록 마지막 요청만 반영한다.
  const latest = useRef(0);
  const loadReplies = useCallback(() => {
    const seq = ++latest.current;
    return client
      .get<{ replies: Reply[] }>(`/topics/${id}/replies?sort=${sort}`)
      .then((r) => {
        if (seq === latest.current) setReplies(r.replies);
      })
      .catch(fail);
  }, [client, id, sort]);

  useEffect(() => {
    let live = true;
    setTopic(null);
    setDoc(null);
    client
      .get<{ topic: Topic }>(`/topics/${id}`)
      .then((r) => {
        if (!live) return;
        setTopic(r.topic);
        if (r.topic.book)
          client
            .get<{ document: Doc }>(`/book/${encodeURIComponent(r.topic.book.docId)}`)
            .then((d) => live && setDoc(d.document))
            .catch(() => live && setDoc(null));
      })
      .catch((e: unknown) => live && fail(e));
    return () => {
      live = false;
    };
  }, [client, id]);

  useEffect(() => {
    void loadReplies();
  }, [loadReplies]);

  async function post(body: string, parentId?: number) {
    setErrors(null);
    try {
      await client.post(`/topics/${id}/replies`, {
        reply: parentId === undefined ? { body } : { body, parentId },
      });
      setOpen(null);
      await loadReplies();
    } catch (e) {
      fail(e);
      throw e;
    }
  }

  // 실패하면 오류를 보여 주고 다시 던진다. 폼은 실패 시 입력을 지우지 않고, 성공 안내는 성공했을 때만 뜬다.
  async function act(fn: () => Promise<unknown>) {
    setErrors(null);
    setNotice(null);
    try {
      await fn();
      setOpen(null);
      await loadReplies();
    } catch (e) {
      fail(e);
      throw e;
    }
  }
  const run = (fn: () => Promise<unknown>) => void act(fn).catch(() => undefined);

  if (!topic)
    return (
      <div className="container page">
        <ErrorList errors={errors} />
      </div>
    );

  const book = topic.book;
  const section = book?.anchor ? doc?.sections.find((s) => s.anchor === book.anchor) : undefined;
  const bookLabel = book
    ? `${doc?.title ?? book.docId}${book.anchor ? ` · ${section?.heading ?? book.anchor}` : ""}`
    : null;
  const original = book ? bookUrl(book.docId, book.anchor) : null;
  const mine = user?.username === topic.author.username;

  const renderNode = (n: ThreadNode) => {
    const r = n.reply;
    const own = user?.username === r.author.username;
    return (
      <div key={r.id} data-reply={r.id}>
        <div className="card">
          <div className="card-block">
            {r.deleted ? (
              <p className="card-text">
                <em>삭제된 답글입니다.</em>
              </p>
            ) : (
              <div
                className="card-text"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(r.body) }}
              />
            )}
          </div>
          <div className="card-footer reply-actions">
            {!r.deleted && (
              <>
                <Link
                  to={`/profile/${encodeURIComponent(r.author.username)}`}
                  className="comment-author"
                >
                  <img src={avatar(r.author.image)} className="comment-author-img" alt="" />{" "}
                  {r.author.username}
                </Link>{" "}
                <span className="date-posted">{new Date(r.createdAt).toLocaleString()}</span>{" "}
              </>
            )}
            {!r.deleted && user && !own && (
              <button
                type="button"
                className={`btn btn-sm ${r.voted ? "btn-primary" : "btn-outline-primary"}`}
                aria-pressed={r.voted}
                onClick={() =>
                  run(() =>
                    r.voted
                      ? client.del(`/replies/${r.id}/vote`)
                      : client.post(`/replies/${r.id}/vote`),
                  )
                }
              >
                추천 {r.score}
              </button>
            )}
            {!r.deleted && (!user || own) && <span>추천 {r.score} </span>}
            {user && (
              <button
                type="button"
                className="btn btn-sm btn-outline-secondary"
                onClick={() => setOpen({ id: r.id, mode: "reply" })}
              >
                답글
              </button>
            )}
            {own && !r.deleted && (
              <>
                <button
                  type="button"
                  className="btn btn-sm btn-outline-secondary"
                  onClick={() => setOpen({ id: r.id, mode: "edit" })}
                >
                  수정
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-outline-danger"
                  onClick={() => {
                    if (window.confirm("이 답글을 삭제할까요?"))
                      run(() => client.del(`/replies/${r.id}`));
                  }}
                >
                  삭제
                </button>
              </>
            )}
            {user && !own && !r.deleted && (
              <button
                type="button"
                className="btn btn-sm btn-outline-secondary"
                onClick={() => setOpen({ id: r.id, mode: "report" })}
              >
                신고
              </button>
            )}
          </div>
        </div>
        {open?.id === r.id && open.mode === "reply" && (
          <ReplyForm
            submitLabel="답글 달기"
            onSubmit={(b) => post(b, r.id)}
            onCancel={() => setOpen(null)}
          />
        )}
        {open?.id === r.id && open.mode === "edit" && (
          <ReplyForm
            submitLabel="수정 저장"
            initial={r.body}
            onSubmit={(b) => act(() => client.put(`/replies/${r.id}`, { reply: { body: b } }))}
            onCancel={() => setOpen(null)}
          />
        )}
        {open?.id === r.id && open.mode === "report" && (
          <ReplyForm
            label="신고 사유"
            submitLabel="신고하기"
            onSubmit={(reason) =>
              act(() => client.post(`/replies/${r.id}/report`, { report: { reason } })).then(() =>
                setNotice("신고를 접수했습니다."),
              )
            }
            onCancel={() => setOpen(null)}
          />
        )}
        {open?.id === r.id && <ErrorList errors={errors} />}
        {n.children.length > 0 && (
          <div className={`reply-children${n.indent >= MAX_INDENT ? " flat" : ""}`}>
            {n.children.map(renderNode)}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="article-page">
      <div className="banner">
        <div className="container">
          <h1>{topic.title}</h1>
          <div className="article-meta">
            <Link to={`/profile/${encodeURIComponent(topic.author.username)}`}>
              <img src={avatar(topic.author.image)} alt="" />
            </Link>
            <div className="info">
              <Link to={`/profile/${encodeURIComponent(topic.author.username)}`} className="author">
                {topic.author.username}
              </Link>
              <span className="date">{new Date(topic.createdAt).toLocaleString()}</span>
            </div>
            {mine && (
              <>
                <Link className="btn btn-outline-secondary btn-sm" to={`/topic/${topic.id}/edit`}>
                  토론 수정
                </Link>{" "}
                <button
                  className="btn btn-outline-danger btn-sm"
                  type="button"
                  onClick={() =>
                    window.confirm("토론과 모든 답글을 삭제할까요?") &&
                    client
                      .del(`/topics/${topic.id}`)
                      .then(() => navigate("/"))
                      .catch(fail)
                  }
                >
                  토론 삭제
                </button>
              </>
            )}
            {user && !mine && (
              <button
                className="btn btn-outline-secondary btn-sm"
                type="button"
                onClick={() => setOpen({ id: 0, mode: "report" })}
              >
                토론 신고
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="container page">
        <div className="row article-content">
          <div className="col-md-12">
            <ul className="tag-list">
              <li className="tag-default tag-pill tag-outline">{kindLabel(topic.kind)}</li>
              {book && bookLabel && (
                <li className="tag-default tag-pill tag-outline">
                  <Link
                    to={`/book/${encodeURIComponent(book.docId)}${book.anchor ? `?anchor=${encodeURIComponent(book.anchor)}` : ""}`}
                  >
                    {bookLabel}
                  </Link>
                </li>
              )}
              {book && book.status !== "current" && (
                <li className="tag-default tag-pill">
                  {STATUS_TEXT[book.status]}
                  {original && (
                    <>
                      {" "}
                      <a href={original} target="_blank" rel="noreferrer">
                        현재 판본 보기
                      </a>
                    </>
                  )}
                </li>
              )}
            </ul>
            <div
              data-testid="topic-body"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(topic.body) }}
            />
          </div>
        </div>
        {open?.id === 0 && open.mode === "report" && (
          <ReplyForm
            label="신고 사유"
            submitLabel="신고하기"
            onSubmit={(reason) =>
              act(() => client.post(`/topics/${topic.id}/report`, { report: { reason } })).then(
                () => setNotice("신고를 접수했습니다."),
              )
            }
            onCancel={() => setOpen(null)}
          />
        )}
        <hr />
        <div className="row">
          <div className="col-xs-12 col-md-8 offset-md-2">
            <ErrorList errors={errors} />
            {notice && <p role="status">{notice}</p>}
            <div className="feed-toggle">
              <ul className="nav nav-pills outline-active">
                {(["old", "top"] as const).map((s) => (
                  <li className="nav-item" key={s}>
                    <button
                      type="button"
                      className={`nav-link btn btn-link${sort === s ? " active" : ""}`}
                      aria-pressed={sort === s}
                      onClick={() => setSort(s)}
                    >
                      {s === "old" ? "작성순" : "추천순"}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            {user ? (
              <ReplyForm submitLabel="답글 달기" onSubmit={(b) => post(b)} />
            ) : (
              <p>
                <Link to="/login">로그인</Link>하거나 <Link to="/register">가입</Link>하면 답글을 달
                수 있습니다.
              </p>
            )}
            {buildThread(replies).map(renderNode)}
          </div>
        </div>
      </div>
    </div>
  );
}
