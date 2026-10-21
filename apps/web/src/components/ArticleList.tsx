import { useEffect, useState } from "react";
import { ApiFailure } from "../api/client";
import type { Article, Errors } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { ArticlePreview } from "./ArticlePreview";
import { ErrorList } from "./ErrorList";

const PAGE = 10;

export function ArticleList({ query }: { query: string }) {
  const { client } = useAuth();
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ articles: Article[]; articlesCount: number } | null>(null);
  const [errors, setErrors] = useState<Errors | null>(null);

  useEffect(() => setPage(0), [query]);
  useEffect(() => {
    let live = true;
    setData(null);
    setErrors(null);
    const sep = query ? "&" : "";
    client
      .get<{ articles: Article[]; articlesCount: number }>(
        `/articles?${query}${sep}limit=${PAGE}&offset=${page * PAGE}`,
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
  if (!data) return <div className="article-preview">Loading articles...</div>;
  // 프로덕션 스모크가 화면 문구 대신 이 표식으로 로딩 완료를 확인한다. 화면을 바꿔도 유지한다.
  const ready = <span data-testid="smoke-ready" hidden />;
  if (data.articles.length === 0)
    return (
      <>
        {ready}
        <div className="article-preview">No articles are here... yet.</div>
      </>
    );
  const pages = Math.ceil(data.articlesCount / PAGE);
  return (
    <>
      {ready}
      {data.articles.map((a) => (
        <ArticlePreview key={a.slug} article={a} />
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
