// 로컬 E2E에서 책 목차를 채운다. wrangler dev --test-scheduled의 /__scheduled가 동기화를 실행한다.
export default async function globalSetup(): Promise<void> {
  const res = await fetch(`${process.env.E2E_API_BASE}/__scheduled`);
  if (!res.ok)
    throw new Error(
      `book sync failed: ${res.status}. 재사용한 API 서버가 --test-scheduled 없이 떠 있으면 /__scheduled가 404다. 그 서버를 끄거나 E2E_API_PORT를 바꾼다.`,
    );
  const book = (await (await fetch(`${process.env.E2E_API_BASE}/api/book`)).json()) as {
    documents: unknown[];
  };
  if (book.documents.length === 0) throw new Error("book sync left no documents");
}
