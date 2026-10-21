import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "./auth/AuthContext";
import { Footer } from "./components/Footer";
import { Header } from "./components/Header";
import { Home } from "./pages/Home";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

function renderAll() {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ topics: [], topicsCount: 0, documents: [], syncedAt: null }),
          { status: 200 },
        ),
    ),
  );
  return render(
    <AuthProvider>
      <MemoryRouter>
        <Header />
        <Home />
        <Footer />
      </MemoryRouter>
    </AuthProvider>,
  );
}

describe("site name", () => {
  it("uses Conveyor in the page title", () => {
    const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
    expect(html).toContain("<title>Conveyor — Software Factory Demo</title>");
  });

  it("shows lowercase conveyor in header, banner and footer", () => {
    const { container } = renderAll();
    expect(container.querySelector(".navbar-brand")?.textContent).toBe("conveyor");
    expect(container.querySelector(".banner h1")?.textContent).toBe("conveyor");
    expect(container.querySelector("footer")?.textContent).toContain("conveyor");
  });

  it("does not show conduit anywhere", () => {
    const { container } = renderAll();
    expect(container.textContent?.toLowerCase()).not.toContain("conduit");
  });
});
