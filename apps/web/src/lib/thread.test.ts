import { describe, expect, it } from "vitest";
import type { Reply } from "../api/types";
import { buildThread, MAX_INDENT } from "./thread";

const r = (id: number, parentId: number | null): Reply => ({
  id,
  topicId: 1,
  parentId,
  body: `b${id}`,
  author: { username: "u", image: null },
  score: 0,
  voted: false,
  deleted: false,
  createdAt: "2026-10-21T00:00:00.000Z",
  updatedAt: "2026-10-21T00:00:00.000Z",
});

describe("buildThread", () => {
  it("nests replies under parents and keeps the list order among siblings", () => {
    const tree = buildThread([r(3, null), r(1, null), r(2, 1), r(4, 2), r(5, 1)]);
    expect(tree.map((n) => n.reply.id)).toEqual([3, 1]);
    expect(tree[1]!.children.map((n) => n.reply.id)).toEqual([2, 5]);
    expect(tree[1]!.children[0]!.children[0]!.reply.id).toBe(4);
  });

  it("caps the indent depth but keeps deeper replies", () => {
    const list = [r(1, null), r(2, 1), r(3, 2), r(4, 3), r(5, 4), r(6, 5)];
    const depths: number[] = [];
    const walk = (ns: ReturnType<typeof buildThread>) =>
      ns.forEach((n) => {
        depths.push(n.indent);
        walk(n.children);
      });
    walk(buildThread(list));
    expect(depths).toEqual([0, 1, 2, 3, MAX_INDENT, MAX_INDENT]);
    expect(MAX_INDENT).toBe(4);
  });

  it("treats a reply whose parent is missing as top-level", () => {
    expect(buildThread([r(2, 99)]).map((n) => n.reply.id)).toEqual([2]);
  });
});
