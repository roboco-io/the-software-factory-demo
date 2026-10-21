import type { Client } from "../api/client";
import type { BookDocument } from "../api/types";

// 문서 제목은 자주 바뀌지 않으므로 클라이언트(로그인 세션)마다 한 번만 읽는다. 토론 수처럼 바뀌는 값은 쓰지 않는다.
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
