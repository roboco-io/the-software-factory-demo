import { describe, expect, it } from "vitest";
import { api, register } from "./helpers";

// 포럼 전환 5단계 ③: RealWorld 글·댓글·태그·즐겨찾기·팔로우·피드 경로는 없다. 계정·프로필 경로는 남는다.
describe("removed RealWorld routes", () => {
  it.each([
    ["GET", "/articles"],
    ["GET", "/articles/feed"],
    ["GET", "/articles/some-slug"],
    ["GET", "/articles/some-slug/comments"],
    ["POST", "/articles/some-slug/favorite"],
    ["GET", "/tags"],
    ["POST", "/profiles/someone/follow"],
  ])("%s %s → 404", async (method, path) => {
    const { token } = await register("rr");
    const res = await api(path, { method, token, body: method === "GET" ? undefined : {} });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ errors: { route: ["not found"] } });
  });

  it("keeps the profile route", async () => {
    const u = await register("rp");
    expect((await api(`/profiles/${u.username}`)).status).toBe(200);
  });
});
