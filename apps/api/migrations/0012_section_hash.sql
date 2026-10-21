-- 절 단위 개정 판정(2026-10-21). 절 본문 해시와, 토론을 연 시점의 절 해시를 저장한다.
-- 기존 행은 NULL이다. 동기화는 해시가 없는 문서를 revision과 관계없이 한 번 다시 읽어 채운다.
-- 해시가 없는 기존 토론은 문서 revision으로 판정한다.
ALTER TABLE book_sections ADD COLUMN hash TEXT;
ALTER TABLE topics ADD COLUMN section_hash TEXT;
