import { afterEach, describe, expect, it } from "vitest";
import type { Run } from "./data";
import { renderDashboard } from "./view";

const base: Run = {
  ts: "2026-10-20T01:05:00Z",
  issue: 66,
  role: "postmortem",
  engine: "codex",
  ok: true,
  costUsd: null,
  failureReason: null,
};
const now = new Date("2026-10-21T00:00:00Z");

function render(runs: Run[]): HTMLElement {
  const root = document.createElement("main");
  document.body.append(root);
  renderDashboard(root, runs, [], now, () => {});
  return root;
}

afterEach(() => document.body.replaceChildren());

describe("incidents panel", () => {
  it("shows an empty message when no incident is recorded", () => {
    const root = render([]);
    expect(root.textContent).toContain("기록된 장애 없음");
  });

  it("links the issue and cause PR and shows recovery minutes and revert state", () => {
    const root = render([
      {
        ...base,
        incident: {
          key: "66#1",
          kind: "smoke",
          phase: "followup",
          detectedAt: "2026-10-20T01:00:00Z",
          recoveredAt: "2026-10-20T01:45:00Z",
          causePr: 65,
          reverted: true,
          classification: "test_gap",
        },
      },
    ]);
    const panel = root.querySelector('section[aria-labelledby="incidents-heading"]')!;
    expect(panel).not.toBeNull();
    const hrefs = [...panel.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("https://github.com/roboco-io/the-software-factory-demo/issues/66");
    expect(hrefs).toContain("https://github.com/roboco-io/the-software-factory-demo/pull/65");
    expect(panel.textContent).toContain("test_gap");
    expect(panel.textContent).toContain("45분");
    expect(panel.textContent).toContain("되돌림");
    expect(panel.textContent).not.toContain("기록된 장애 없음");
  });

  it("names the postmortem role in Korean in the role tables", () => {
    const root = render([base]);
    const details = root.querySelector("details")!;
    expect(details.textContent).toContain("포스트모템");
    expect(details.textContent).not.toContain("postmortem");
  });
});
