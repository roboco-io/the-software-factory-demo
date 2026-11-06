// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { renderHome } from "./home";

describe("renderHome", () => {
  it("states that the platform is being built", () => {
    const root = document.createElement("main");
    renderHome(root);
    expect(root.querySelector("h1")?.textContent).toBe("Software Factory");
    expect(root.textContent).toContain("준비 중");
  });
});
