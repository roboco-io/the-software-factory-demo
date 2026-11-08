import { describe, expect, it } from "vitest";
import { PORTAL_URL, conveyorTarget } from "../public/redirect.js";

const loc = (pathname, search = "", hash = "") => ({ pathname, search, hash });

describe("conveyorTarget", () => {
  it("keeps the landing page when the root has no conveyor route", () => {
    expect(conveyorTarget(loc("/the-software-factory-demo/"))).toBeNull();
    expect(
      conveyorTarget(loc("/the-software-factory-demo/", "", "#top")),
    ).toBeNull();
  });

  it("sends an old conveyor hash route to the same route under /conveyor/", () => {
    expect(
      conveyorTarget(loc("/the-software-factory-demo/", "", "#/topics/12")),
    ).toBe("/conveyor/#/topics/12");
    expect(
      conveyorTarget(
        loc("/the-software-factory-demo/index.html", "?a=1", "#/"),
      ),
    ).toBe("/conveyor/?a=1#/");
  });

  it("sends an old file path to the same path under /conveyor/", () => {
    expect(conveyorTarget(loc("/the-software-factory-demo/llms.txt"))).toBe(
      "/conveyor/llms.txt",
    );
    expect(
      conveyorTarget(loc("/the-software-factory-demo/assets/x.js", "?v=2")),
    ).toBe("/conveyor/assets/x.js?v=2");
  });

  it("sends the removed factory dashboard to the portal", () => {
    expect(conveyorTarget(loc("/the-software-factory-demo/factory/"))).toBe(
      PORTAL_URL,
    );
    expect(
      conveyorTarget(loc("/the-software-factory-demo/factory/index.html")),
    ).toBe(PORTAL_URL);
  });

  it("does not redirect paths outside this site or the root without slash", () => {
    expect(conveyorTarget(loc("/other/llms.txt"))).toBeNull();
    expect(conveyorTarget(loc("/the-software-factory-demox/a"))).toBeNull();
  });

  it("does not send the 404 page itself anywhere", () => {
    expect(
      conveyorTarget(loc("/the-software-factory-demo/404.html")),
    ).toBeNull();
  });
});
