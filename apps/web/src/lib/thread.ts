import type { Reply } from "../api/types";

// 화면 들여쓰기 상한(설계 4.1절). 저장 깊이에는 제한이 없고, 더 깊은 답글은 같은 들여쓰기로 보인다.
export const MAX_INDENT = 4;

export type ThreadNode = { reply: Reply; indent: number; children: ThreadNode[] };

// API의 평면 목록을 parentId로 트리로 묶는다. 형제 순서는 목록 순서(정렬 결과)를 따른다.
export function buildThread(replies: Reply[]): ThreadNode[] {
  const byId = new Map<number, ThreadNode>();
  for (const reply of replies) byId.set(reply.id, { reply, indent: 0, children: [] });
  const roots: ThreadNode[] = [];
  for (const reply of replies) {
    const node = byId.get(reply.id)!;
    const parent = reply.parentId === null ? undefined : byId.get(reply.parentId);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const setIndent = (nodes: ThreadNode[], depth: number) => {
    for (const n of nodes) {
      n.indent = Math.min(depth, MAX_INDENT);
      setIndent(n.children, depth + 1);
    }
  };
  setIndent(roots, 0);
  return roots;
}
