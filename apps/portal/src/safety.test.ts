import { describe, expect, it } from "vitest";
import headers from "../public/_headers?raw";
import indexHtml from "../index.html?raw";

const sources = import.meta.glob<string>(["./*.ts", "!./*.test.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});

describe("portal source", () => {
  it("never writes data as HTML or evaluates code", () => {
    const forbidden = [
      /\binnerHTML\b/,
      /\bouterHTML\b/,
      /\binsertAdjacentHTML\b/,
      /\bdocument\.write\b/,
      /\beval\s*\(/,
      /\bnew Function\b/,
      /\bsetTimeout\s*\(\s*["'`]/,
      /\bdangerouslySetInnerHTML\b/,
    ];
    expect(Object.keys(sources).length).toBeGreaterThan(5);
    for (const [file, code] of Object.entries(sources))
      for (const pattern of forbidden)
        expect(code, `${file} ${pattern}`).not.toMatch(pattern);
  });

  it("does not set inline styles or event-handler attributes", () => {
    for (const [file, code] of Object.entries(sources)) {
      expect(code, file).not.toMatch(/setAttribute\(\s*["']style["']/);
      expect(code, file).not.toMatch(/setAttribute\(\s*["']on/i);
    }
  });

  it("has an index.html without inline scripts, styles or handlers", () => {
    expect(indexHtml).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(indexHtml).not.toMatch(/<style/i);
    expect(indexHtml).not.toMatch(/\son[a-z]+\s*=/i);
    expect(indexHtml).not.toMatch(/style\s*=/i);
  });
});

describe("Content-Security-Policy in public/_headers", () => {
  const csp = /Content-Security-Policy:\s*(.+)/i.exec(headers)?.[1] ?? "";
  const directive = (name: string) =>
    csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith(`${name} `) || d === name);

  it("is set for every path", () => {
    expect(headers).toMatch(/^\/\*\s*$/m);
    expect(csp).not.toBe("");
  });

  it("allows only this origin by default, with no inline or eval script", () => {
    expect(directive("default-src")).toBe("default-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(directive("script-src")).toBe("script-src 'self'");
    expect(directive("frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive("object-src")).toBe("object-src 'none'");
    expect(directive("base-uri")).toBe("base-uri 'none'");
  });

  it("also sends the basic hardening headers", () => {
    expect(headers).toMatch(/X-Content-Type-Options:\s*nosniff/i);
    expect(headers).toMatch(/Referrer-Policy:/i);
  });
});
