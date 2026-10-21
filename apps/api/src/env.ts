export type Env = {
  DB: D1Database;
  JWT_SECRET: string;
  ALLOWED_ORIGINS: string;
  // 프로덕션 Worker secret. deploy.yml이 GitHub production environment secret에서 넣는다. 프리뷰·로컬에는 없다.
  INTAKE_TOKEN?: string;
  // 책 저장소 raw 파일의 기준 URL. 없으면 동기화하지 않는다.
  BOOK_SOURCE_URL?: string;
  // 책 저장소 배포가 동기화를 요청할 때 쓰는 토큰. 프로덕션 Worker secret이며 프리뷰·로컬에는 없다(그러면 /api/book/sync는 항상 404).
  BOOK_SYNC_TOKEN?: string;
};

export type AppEnv = {
  Bindings: Env;
  // agent: 요청이 유효한 에이전트 토큰으로 인증되었는가.
  Variables: { userId: number | null; agent: boolean };
};
