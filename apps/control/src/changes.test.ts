import { describe, expect, it } from "vitest";
import {
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  validateChanges,
  type RawEntry,
} from "./changes";

const b64 = (s: string | Uint8Array) =>
  btoa(typeof s === "string" ? s : String.fromCharCode(...s));
const pathB64 = (p: string) =>
  b64(
    new TextEncoder()
      .encode(p)
      .reduce((a, c) => a + String.fromCharCode(c), ""),
  );

function file(
  path: string,
  content = "hello\n",
  over: Partial<RawEntry> = {},
): RawEntry {
  return {
    pathB64: pathB64(path),
    status: "added",
    type: "file",
    mode: 0o100644,
    size: content.length,
    contentB64: b64(content),
    ...over,
  };
}
const wrap = (...entries: RawEntry[]) => ({ truncated: false, entries });
const codeOf = (raw: unknown) => {
  const r = validateChanges(raw);
  return r.ok ? "ok" : r.code;
};

describe("validateChanges: accepted", () => {
  it("accepts a normal change and returns structured files", () => {
    const r = validateChanges(
      wrap(
        file("src/app.ts"),
        file("scripts/run.sh", "#!/bin/sh\n", { mode: 0o100755 }),
        {
          pathB64: pathB64("old.txt"),
          status: "deleted",
          type: "missing",
          mode: 0,
          size: 0,
        },
      ),
    );
    expect(r).toEqual({
      ok: true,
      changes: [
        {
          path: "src/app.ts",
          status: "added",
          contentBase64: b64("hello\n"),
          size: 6,
        },
        {
          path: "scripts/run.sh",
          status: "added",
          contentBase64: b64("#!/bin/sh\n"),
          size: 10,
        },
        { path: "old.txt", status: "deleted", size: 0 },
      ],
    });
  });
  it("accepts non-ASCII UTF-8 paths and binary content", () => {
    const r = validateChanges(
      wrap(file("docs/한글.md"), file("img.bin", "\u0000\u0001", { size: 2 })),
    );
    expect(r.ok).toBe(true);
  });
  it("ignores reported modes: nothing in the output depends on them", () => {
    const r = validateChanges(
      wrap(
        file("bin/tool", "x", { mode: 0o104755, baseMode: "120000" }),
        file("src/run.sh", "x", { mode: 0o100755 }),
      ),
    );
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/mode|100755/);
  });
  it("accepts limits at the boundary", () => {
    const many = Array.from({ length: MAX_FILES }, (_, i) =>
      file(`f/${i}.txt`, "x"),
    );
    expect(codeOf(wrap(...many))).toBe("ok");
    expect(codeOf(wrap(file("big.txt", "a".repeat(MAX_FILE_BYTES))))).toBe(
      "ok",
    );
  });
});

describe("validateChanges: rejected classes", () => {
  it("rejects an empty change", () => {
    expect(codeOf(wrap())).toBe("empty_change");
  });
  it("rejects too many files and truncated listings", () => {
    const many = Array.from({ length: MAX_FILES + 1 }, (_, i) =>
      file(`f/${i}.txt`, "x"),
    );
    expect(codeOf(wrap(...many))).toBe("too_many_files");
    expect(codeOf({ truncated: true, entries: [file("a.txt")] })).toBe(
      "too_many_files",
    );
  });
  it("rejects a file over 256 KB (declared size, content omitted)", () => {
    const big: RawEntry = {
      ...file("big.txt", ""),
      size: MAX_FILE_BYTES + 1,
      contentB64: undefined,
    };
    expect(codeOf(wrap(big))).toBe("file_too_large");
  });
  it("rejects more than 1 MB in total", () => {
    const each = "a".repeat(MAX_FILE_BYTES);
    const n = Math.floor(MAX_TOTAL_BYTES / MAX_FILE_BYTES) + 1;
    const files = Array.from({ length: n }, (_, i) => file(`d/${i}.txt`, each));
    expect(n).toBeLessThanOrEqual(MAX_FILES);
    expect(codeOf(wrap(...files))).toBe("total_too_large");
  });
  it("rejects a size that disagrees with the content", () => {
    expect(codeOf(wrap(file("a.txt", "abc", { size: 1 })))).toBe(
      "malformed_output",
    );
  });
  it.each([
    [".github/workflows/ci.yml"],
    [".GitHub/workflows/ci.yml"],
    [".github"],
    [".factory/policy.yml"],
    [".git/config"],
    ["sub/.git/hooks/pre-commit"],
    [".GIT/config"],
    [".git./config"],
    [".git /config"],
    ["GIT~1/config"],
  ])("rejects forbidden path %s", (p) => {
    expect(codeOf(wrap(file(p)))).toBe("forbidden_path");
  });
  it("rejects deletion of protected paths too", () => {
    const del: RawEntry = {
      pathB64: pathB64(".github/CODEOWNERS"),
      status: "deleted",
      type: "missing",
      mode: 0,
      size: 0,
    };
    expect(codeOf(wrap(del))).toBe("forbidden_path");
  });
  it.each([["/etc/passwd"], ["\\windows\\x"], ["C:/x"], ["c:\\x"]])(
    "rejects absolute path %s",
    (p) => {
      expect(codeOf(wrap(file(p)))).toBe("absolute_path");
    },
  );
  it.each([["../x"], ["a/../../x"], ["a/.."], ["./a"], ["a//b"], ["a/"], [""]])(
    "rejects traversal or non-canonical path %j",
    (p) => {
      expect(codeOf(wrap(file(p)))).toBe("path_traversal");
    },
  );
  it("rejects a backslash inside a relative path", () => {
    expect(codeOf(wrap(file("a\\b")))).toBe("forbidden_path");
  });
  it("rejects symlinks", () => {
    expect(
      codeOf(
        wrap(
          file("link", "", { type: "symlink", size: 0, contentB64: undefined }),
        ),
      ),
    ).toBe("symlink");
  });
  it("rejects submodules and directories", () => {
    expect(
      codeOf(
        wrap(
          file("vendor/lib", "", {
            type: "dir",
            size: 0,
            contentB64: undefined,
          }),
        ),
      ),
    ).toBe("submodule");
  });
  it("rejects special files", () => {
    expect(
      codeOf(
        wrap(
          file("fifo", "", { type: "other", size: 0, contentB64: undefined }),
        ),
      ),
    ).toBe("special_file");
  });
  it("does not trust a reported file type over what it can derive", () => {
    // A path reported as a plain file with a submodule base mode is still only a blob.
    expect(codeOf(wrap(file("vendor/lib", "x", { baseMode: "160000" })))).toBe(
      "ok",
    );
  });
  it.each([
    ["a\u200bb"],
    ["a\u200eb"],
    ["a\u200fb"],
    ["a\u202ab"],
    ["a\u202eb"],
    ["a\u2066b"],
    ["a\u2069b"],
    ["a\u2060b"],
    ["a\ufeffb"],
  ])("rejects zero-width and bidi characters in path %j", (p) => {
    expect(codeOf(wrap(file(p)))).toBe("path_control_char");
  });
  it("rejects non-UTF-8 paths", () => {
    const raw = btoa(String.fromCharCode(0x61, 0xff, 0xfe));
    expect(codeOf(wrap({ ...file("x"), pathB64: raw }))).toBe("path_not_utf8");
  });
  it.each([
    ["a\nb"],
    ["a\u0000b"],
    ["a\u001bb"],
    ["a\u007fb"],
    ["a\u0085b"],
    ["a\u2028b"],
  ])("rejects control characters in path %j", (p) => {
    expect(codeOf(wrap(file(p)))).toBe("path_control_char");
  });
  it.each([
    [null],
    [{}],
    [{ entries: "x" }],
    [{ entries: [null] }],
    [{ entries: [{ pathB64: 1 }] }],
    [{ entries: [{ ...file("a"), status: "weird" }] }],
    [{ entries: [{ ...file("a"), size: -1 }] }],
    [{ entries: [{ ...file("a"), contentB64: "!!!" }] }],
  ])("rejects malformed output %j", (raw) => {
    expect(codeOf(raw)).toBe("malformed_output");
  });
});
