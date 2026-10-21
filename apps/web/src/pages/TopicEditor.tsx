import { useEffect, useRef, useState, type FormEvent } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { ApiFailure } from "../api/client";
import type { BookDocument, BookSection, Errors, Topic, TopicKind } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { ErrorList } from "../components/ErrorList";
import { kindLabel } from "../lib/book";

const KINDS: TopicKind[] = ["general", "question", "argument", "case"];

// 새 토론(/new?docId=&anchor=)과 토론 수정(/topic/:id/edit). 책 연결은 처음 열 때만 정하고 수정할 수 없다(계약).
export function TopicEditor() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const { user, ready, client } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    title: "",
    body: "",
    kind: "general" as TopicKind,
    docId: params.get("docId") ?? "",
    anchor: params.get("anchor") ?? "",
  });
  const [docs, setDocs] = useState<BookDocument[]>([]);
  const [sections, setSections] = useState<BookSection[]>([]);
  const [errors, setErrors] = useState<Errors | null>(null);
  // 수정할 토론을 불러오기 전에 사용자가 입력을 시작했으면 늦게 온 응답으로 덮어쓰지 않는다.
  const touched = useRef(false);
  const editing = id !== undefined;

  const fail = (e: unknown) => setErrors(e instanceof ApiFailure ? e.errors : { app: ["failed"] });

  useEffect(() => {
    client
      .get<{ documents: BookDocument[] }>("/book")
      .then((r) => setDocs(r.documents))
      .catch(fail);
  }, [client]);

  useEffect(() => {
    if (!editing) return;
    client
      .get<{ topic: Topic }>(`/topics/${id}`)
      .then(({ topic: t }) => {
        if (touched.current) return;
        setForm({
          title: t.title,
          body: t.body,
          kind: t.kind,
          docId: t.book?.docId ?? "",
          anchor: t.book?.anchor ?? "",
        });
      })
      .catch(fail);
  }, [client, editing, id]);

  useEffect(() => {
    if (!form.docId) {
      setSections([]);
      return;
    }
    let live = true;
    client
      .get<{ document: { sections: BookSection[] } }>(`/book/${encodeURIComponent(form.docId)}`)
      .then((r) => live && setSections(r.document.sections))
      .catch(() => live && setSections([]));
    return () => {
      live = false;
    };
  }, [client, form.docId]);

  if (ready && !user) return <Navigate to="/login" />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErrors(null);
    try {
      if (editing) {
        await client.put(`/topics/${id}`, {
          topic: { title: form.title, body: form.body, kind: form.kind },
        });
        navigate(`/topic/${id}`);
        return;
      }
      const topic: Record<string, string> = { title: form.title, body: form.body, kind: form.kind };
      if (form.docId) topic.docId = form.docId;
      if (form.docId && form.anchor) topic.anchor = form.anchor;
      const r = await client.post<{ topic: Topic }>("/topics", { topic });
      navigate(`/topic/${r.topic.id}`);
    } catch (err) {
      fail(err);
    }
  }

  return (
    <div className="editor-page">
      <div className="container page">
        <div className="row">
          <div className="col-md-10 offset-md-1 col-xs-12">
            <h1>{editing ? "토론 수정" : "새 토론"}</h1>
            <ErrorList errors={errors} />
            <form onSubmit={submit}>
              <fieldset className="form-group">
                <label htmlFor="topic-doc">장</label>
                <select
                  id="topic-doc"
                  className="form-control"
                  value={form.docId}
                  disabled={editing}
                  onChange={(e) => setForm({ ...form, docId: e.target.value, anchor: "" })}
                >
                  <option value="">책과 연결하지 않음</option>
                  {docs.map((d) => (
                    <option key={d.docId} value={d.docId}>
                      {d.title}
                    </option>
                  ))}
                </select>
              </fieldset>
              <fieldset className="form-group">
                <label htmlFor="topic-anchor">절</label>
                <select
                  id="topic-anchor"
                  className="form-control"
                  value={form.anchor}
                  disabled={editing || !form.docId}
                  onChange={(e) => setForm({ ...form, anchor: e.target.value })}
                >
                  <option value="">장 전체</option>
                  {sections.map((s) => (
                    <option key={s.anchor} value={s.anchor}>
                      {s.heading}
                    </option>
                  ))}
                </select>
              </fieldset>
              <fieldset className="form-group">
                <label htmlFor="topic-kind">유형</label>
                <select
                  id="topic-kind"
                  className="form-control"
                  value={form.kind}
                  onChange={(e) => setForm({ ...form, kind: e.target.value as TopicKind })}
                >
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {kindLabel(k)}
                    </option>
                  ))}
                </select>
              </fieldset>
              <fieldset className="form-group">
                <input
                  className="form-control form-control-lg"
                  placeholder="토론 제목"
                  aria-label="토론 제목"
                  value={form.title}
                  onChange={(e) => {
                    touched.current = true;
                    setForm({ ...form, title: e.target.value });
                  }}
                />
              </fieldset>
              <fieldset className="form-group">
                <textarea
                  className="form-control"
                  rows={8}
                  placeholder="무엇을 이야기하고 싶은가요? (마크다운)"
                  aria-label="토론 본문"
                  value={form.body}
                  onChange={(e) => {
                    touched.current = true;
                    setForm({ ...form, body: e.target.value });
                  }}
                />
              </fieldset>
              <button className="btn btn-lg pull-xs-right btn-primary" type="submit">
                {editing ? "수정 저장" : "토론 열기"}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
