// 로컬 E2E에서 책 목차를 채운다. wrangler dev --test-scheduled의 /__scheduled가 동기화를 실행한다.
export default async function globalSetup(): Promise<void> {
  const res = await fetch(`${process.env.E2E_API_BASE}/__scheduled`);
  if (!res.ok) throw new Error(`book sync failed: ${res.status}`);
  const book = (await (await fetch(`${process.env.E2E_API_BASE}/api/book`)).json()) as {
    documents: unknown[];
  };
  if (book.documents.length === 0) throw new Error("book sync left no documents");
}
