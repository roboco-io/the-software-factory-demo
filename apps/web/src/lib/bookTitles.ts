import type { Client } from "../api/client";
import type { BookDocument } from "../api/types";

// 문서 제목은 자주 바뀌지 않으므로 API 클라이언트마다 한 번만 읽는다. 클라이언트는 AuthContext가 앱이 열려 있는 동안
// 하나만 만들므로 사실상 페이지를 새로 열 때까지 유지된다. 토론 수처럼 바뀌는 값은 여기서 쓰지 않는다.
const cache = new WeakMap<Client, Promise<Record<string, string>>>();

export function bookTitles(client: Client): Promise<Record<string, string>> {
  let p = cache.get(client);
  if (!p) {
    p = client
      .get<{ documents?: BookDocument[] }>("/book")
      .then((r) => Object.fromEntries((r.documents ?? []).map((d) => [d.docId, d.title])))
      .catch(() => {
        cache.delete(client);
        return {};
      });
    cache.set(client, p);
  }
  return p;
}
