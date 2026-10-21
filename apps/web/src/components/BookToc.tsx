import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ApiFailure } from "../api/client";
import type { BookDocument, Errors } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { ErrorList } from "./ErrorList";

export function BookToc() {
  const { client } = useAuth();
  const [data, setData] = useState<{ documents: BookDocument[]; syncedAt: string | null } | null>(
    null,
  );
  const [errors, setErrors] = useState<Errors | null>(null);

  useEffect(() => {
    let live = true;
    client
      .get<{ documents: BookDocument[]; syncedAt: string | null }>("/book")
      .then((r) => live && setData(r))
      .catch(
        (e: unknown) => live && setErrors(e instanceof ApiFailure ? e.errors : { app: ["failed"] }),
      );
    return () => {
      live = false;
    };
  }, [client]);

  if (errors) return <ErrorList errors={errors} />;
  if (!data) return <p>목차를 불러오는 중...</p>;
  if (data.documents.length === 0) return <p>책 목차를 아직 가져오지 못했습니다.</p>;
  return (
    <>
      <ul className="book-toc">
        {data.documents.map((d) => (
          <li key={d.docId}>
            <Link to={`/book/${d.docId}`}>
              {d.title} <span className="counter">({d.topicCount})</span>
            </Link>
          </li>
        ))}
      </ul>
      {data.syncedAt && (
        <p className="counter">마지막 동기화 {new Date(data.syncedAt).toLocaleString()}</p>
      )}
    </>
  );
}
