// 로컬 E2E에서 책 목차를 채운다. wrangler dev --test-scheduled의 /__scheduled가 동기화를 실행한다.
// 로컬 workerd가 고정 데이터 서버에 처음 연결할 때 "Network connection lost"로 한 번 실패한 적이 있어
// 문서가 채워지지 않으면 최대 3회 다시 호출한다(scripts/forum-api.sh와 같은 방식). 실패한 동기화는 데이터를 바꾸지 않는다.
export default async function globalSetup(): Promise<void> {
  const base = process.env.E2E_API_BASE;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const res = await fetch(`${base}/__scheduled`);
    if (!res.ok)
      throw new Error(
        `book sync failed: ${res.status}. 재사용한 API 서버가 --test-scheduled 없이 떠 있으면 /__scheduled가 404다. 그 서버를 끄거나 E2E_API_PORT를 바꾼다.`,
      );
    const book = (await (await fetch(`${base}/api/book`)).json()) as { documents: unknown[] };
    if (book.documents.length > 0) return;
  }
  throw new Error("book sync left no documents after 3 attempts");
}
