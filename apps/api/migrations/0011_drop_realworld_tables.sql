-- 포럼 전환 5단계(설계 6.4절): RealWorld 전용 테이블을 지운다. 되돌릴 수 없는 변경이다.
-- 선행 확인(2026-10-21, 프로덕션 읽기 쿼리): 글 12개·댓글 0개가 모두 토론·답글로 옮겨져 있다(마이그레이션 0010, 미이전 0건).
-- RealWorld 쓰기 경로는 PR #104에서 제거되어 이후 새 행이 생길 수 없다.
-- 복구 수단: 삭제 전 D1 Time Travel 북마크와 전체 내보내기를 남겼다(PR 본문 참고).
-- topics.legacy_article_id, replies.legacy_comment_id는 옛 id만 담고 외래 키가 아니므로 그대로 둔다.
DROP TABLE favorites;
DROP TABLE article_tags;
DROP TABLE comments;
DROP TABLE tags;
DROP TABLE articles;
