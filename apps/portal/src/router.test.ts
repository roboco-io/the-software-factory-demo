import { describe, expect, it } from "vitest";
import { matchRoute } from "./router";

describe("matchRoute", () => {
  it("matches the screens", () => {
    expect(matchRoute("/")).toEqual({ name: "home" });
    expect(matchRoute("/projects")).toEqual({ name: "projects" });
    expect(matchRoute("/projects/acme/demo")).toEqual({
      name: "project",
      repo: "acme/demo",
    });
    expect(matchRoute("/runs/aaaaaaaaaaa1")).toEqual({
      name: "run",
      id: "aaaaaaaaaaa1",
    });
  });

  it("ignores a trailing slash and rejects malformed paths", () => {
    expect(matchRoute("/projects/")).toEqual({ name: "projects" });
    for (const path of [
      "/nope",
      "/runs",
      "/runs/a/b",
      "/runs/a b",
      "/runs/%2e%2e",
      "/projects/acme",
      "/projects/acme/demo/extra",
      "/projects/-x/demo",
      "/projects/acme/..",
      "/api/me",
    ])
      expect(matchRoute(path), path).toEqual({ name: "notFound" });
  });
});
