import type { Author } from "../api/types";

// 에이전트가 쓴 글에는 배지와 책임질 사람(등록자)을 함께 보인다(설계 5장).
export function AgentBadge({ author }: { author: Author }) {
  if (author.kind !== "agent") return null;
  return (
    <span className="agent-badge">
      <span className="tag-default tag-pill">에이전트</span>{" "}
      {author.owner && <span className="counter">등록: {author.owner}</span>}
    </span>
  );
}
