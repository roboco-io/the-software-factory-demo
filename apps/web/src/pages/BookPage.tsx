import { useEffect, useState } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router";
import { ApiFailure } from "../api/client";
import type { BookDocument, BookSection, Errors } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { ErrorList } from "../components/ErrorList";
import { TopicList } from "../components/TopicList";
import { bookUrl } from "../lib/book";

type Doc = BookDocument & { sections: BookSection[] };

// 패턴은 문서 patterns 하나의 절(앵커 pNN)이다(2026-10-21). 이전 패턴별 문서 링크는 그 절로 보낸다.
export function BookPage() {
  const { docId = "" } = useParams();
  if (/^p\d+$/.test(docId))
    return <Navigate replace to={`/book/patterns?anchor=${encodeURIComponent(docId)}`} />;
  return <BookDocumentPage docId={docId} />;
}

function BookDocumentPage({ docId }: { docId: string }) {
  const [params] = useSearchParams();
  const anchor = params.get("anchor");
  const { client } = useAuth();
  const [doc, setDoc] = useState<Doc | null>(null);
  const [errors, setErrors] = useState<Errors | null>(null);

  useEffect(() => {
    let live = true;
    setDoc(null);
    setErrors(null);
    client
      .get<{ document: Doc }>(`/book/${encodeURIComponent(docId)}`)
      .then((r) => live && setDoc(r.document))
      .catch(
        (e: unknown) => live && setErrors(e instanceof ApiFailure ? e.errors : { app: ["failed"] }),
      );
    return () => {
      live = false;
    };
  }, [client, docId]);

  if (errors)
    return (
      <div className="container page">
        <ErrorList errors={errors} />
      </div>
    );
  if (!doc) return <div className="container page">불러오는 중...</div>;
  const section = anchor ? doc.sections.find((s) => s.anchor === anchor) : undefined;
  const link = bookUrl(doc.docId, anchor);
  const filter = `docId=${encodeURIComponent(doc.docId)}${anchor ? `&anchor=${encodeURIComponent(anchor)}` : ""}`;
  return (
    <div className="book-page">
      <div className="banner">
        <div className="container">
          <h1>{doc.title}</h1>
          <p>
            판본 {doc.revision}
            {link && (
              <>
                {" · "}
                <a href={link} target="_blank" rel="noreferrer">
                  {anchor ? "책에서 이 절 읽기" : "책에서 읽기"}
                </a>
              </>
            )}
          </p>
        </div>
      </div>
      <div className="container page">
        <div className="row">
          <div className="col-md-9">
            <h2>{section ? section.heading : anchor ? `${anchor} 절` : "이 장의 토론"}</h2>
            <p>
              <Link
                className="btn btn-sm btn-outline-primary"
                to={`/new?docId=${encodeURIComponent(doc.docId)}${anchor ? `&anchor=${encodeURIComponent(anchor)}` : ""}`}
              >
                {anchor ? "이 절에서 토론 열기" : "이 장에서 토론 열기"}
              </Link>
            </p>
            <TopicList query={filter} />
          </div>
          <div className="col-md-3">
            <div className="sidebar">
              <h2>절</h2>
              <ul className="book-toc">
                <li>
                  <Link to={`/book/${doc.docId}`}>
                    장 전체 <span className="counter">({doc.topicCount})</span>
                  </Link>
                </li>
                {doc.sections.map((s) => (
                  <li key={s.anchor}>
                    <Link to={`/book/${doc.docId}?anchor=${encodeURIComponent(s.anchor)}`}>
                      {s.heading} <span className="counter">({s.topicCount})</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
