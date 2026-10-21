-- 포럼 전환 5단계(설계 6.4절): RealWorld 글을 책과 연결하지 않은 일반 토론으로, 댓글을 최상위 답글로 옮긴다.
-- 원본 테이블(articles, comments, tags, favorites)은 지우지 않는다. 삭제는 이전 결과를 프로덕션에서 확인한 뒤 별도 마이그레이션으로 한다.
-- legacy_* 열은 원본과의 대응이며 유일하다. 아래 INSERT는 다시 실행해도 같은 결과가 나오므로,
-- 이 마이그레이션 뒤에 새로 쓰인 글이 있으면 테이블 삭제 전에 같은 INSERT를 한 번 더 실행해 옮길 수 있다.
ALTER TABLE topics ADD COLUMN legacy_article_id INTEGER;
CREATE UNIQUE INDEX topics_legacy_article_idx ON topics (legacy_article_id);
ALTER TABLE replies ADD COLUMN legacy_comment_id INTEGER;
CREATE UNIQUE INDEX replies_legacy_comment_idx ON replies (legacy_comment_id);

-- 글 → 토론. 요약(description)은 본문 첫 문단으로 붙인다. 태그·즐겨찾기는 옮기지 않는다.
-- 최근 활동 시각은 글 작성 시각과 마지막 댓글 시각 중 늦은 쪽이다.
INSERT INTO topics (title, body, kind, author_id, created_at, updated_at, last_activity_at, legacy_article_id)
SELECT
  a.title,
  CASE WHEN a.description <> '' THEN a.description || char(10) || char(10) || a.body ELSE a.body END,
  'general',
  a.author_id,
  a.created_at,
  a.updated_at,
  MAX(a.created_at, COALESCE((SELECT MAX(c.created_at) FROM comments c WHERE c.article_id = a.id), a.created_at)),
  a.id
FROM articles a
WHERE true
ORDER BY a.id
ON CONFLICT (legacy_article_id) DO NOTHING;

-- 댓글 → 최상위 답글. 댓글 작성 순서를 유지한다.
INSERT INTO replies (topic_id, parent_id, author_id, body, created_at, updated_at, legacy_comment_id)
SELECT t.id, NULL, c.author_id, c.body, c.created_at, c.updated_at, c.id
FROM comments c JOIN topics t ON t.legacy_article_id = c.article_id
WHERE true
ORDER BY c.id
ON CONFLICT (legacy_comment_id) DO NOTHING;
