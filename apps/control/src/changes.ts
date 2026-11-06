export const MAX_FILES = 50;
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_TOTAL_BYTES = 1024 * 1024;
const MAX_PATH_LENGTH = 1024;

export const REJECT_CODES = [
  "empty_change",
  "too_many_files",
  "total_too_large",
  "file_too_large",
  "forbidden_path",
  "absolute_path",
  "path_traversal",
  "symlink",
  "submodule",
  "special_file",
  "path_not_utf8",
  "path_control_char",
  "malformed_output",
] as const;
export type RejectCode = (typeof REJECT_CODES)[number];

/** One entry as reported by the container. Untrusted. */
export interface RawEntry {
  pathB64: string;
  status: "added" | "modified" | "deleted";
  type: "file" | "symlink" | "dir" | "other" | "missing";
  size: number;
  /** Reported by the container but ignored: the control plane does not trust it. */
  mode?: number | undefined;
  baseMode?: string | null | undefined;
  contentB64?: string | undefined;
}

export interface ValidChange {
  path: string;
  status: "added" | "modified" | "deleted";
  size: number;
  contentBase64?: string;
}

export type ValidationResult =
  { ok: true; changes: ValidChange[] } | { ok: false; code: RejectCode };

const STATUSES = new Set(["added", "modified", "deleted"]);
const TYPES = new Set(["file", "symlink", "dir", "other", "missing"]);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
// Built from strings so the source has no raw control characters.
const CONTROL = new RegExp(
  "[\\u0000-\\u001f\\u007f-\\u009f" + String.fromCharCode(0x2028, 0x2029) + "]",
);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

class Reject extends Error {
  constructor(readonly code: RejectCode) {
    super(code);
  }
}

function decodeBase64(value: string): Uint8Array | null {
  if (!BASE64.test(value) || value.length % 4 !== 0) return null;
  try {
    const bin = atob(value);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Zero-width and bidirectional formatting characters can disguise a path in review. */
function hasInvisibleFormatting(path: string): boolean {
  for (const ch of path) {
    const c = ch.codePointAt(0) as number;
    if (
      (c >= 0x200b && c <= 0x200f) ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069) ||
      c === 0x2060 ||
      c === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}

function checkPath(pathB64: string): string {
  const bytes = decodeBase64(pathB64);
  if (bytes === null) throw new Reject("malformed_output");
  let path: string;
  try {
    path = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes,
    );
  } catch {
    throw new Reject("path_not_utf8");
  }
  if (CONTROL.test(path) || hasInvisibleFormatting(path))
    throw new Reject("path_control_char");
  if (path.length > MAX_PATH_LENGTH) throw new Reject("malformed_output");
  if (
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[A-Za-z]:/.test(path)
  ) {
    throw new Reject("absolute_path");
  }
  if (path.includes("\\")) throw new Reject("forbidden_path");
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === ".."))
    throw new Reject("path_traversal");
  // Windows and macOS file systems ignore case and trailing dots or spaces.
  const folded = segments.map((s) => s.replace(/[. ]+$/, "").toLowerCase());
  if (folded[0] === ".github" || folded[0] === ".factory")
    throw new Reject("forbidden_path");
  if (folded.some((s) => s === ".git" || /^git~\d+$/.test(s)))
    throw new Reject("forbidden_path");
  return path;
}

function checkEntry(raw: unknown): { change: ValidChange } {
  if (!isRecord(raw)) throw new Reject("malformed_output");
  // `mode` and `baseMode` in the report are ignored: nothing here depends on them.
  const { pathB64, status, type, size, contentB64 } = raw;
  if (
    typeof pathB64 !== "string" ||
    typeof status !== "string" ||
    typeof type !== "string"
  ) {
    throw new Reject("malformed_output");
  }
  if (!STATUSES.has(status) || !TYPES.has(type))
    throw new Reject("malformed_output");
  if (typeof size !== "number" || !Number.isInteger(size) || size < 0)
    throw new Reject("malformed_output");
  if (contentB64 !== undefined && typeof contentB64 !== "string")
    throw new Reject("malformed_output");

  const path = checkPath(pathB64);
  const st = status as ValidChange["status"];

  if (st === "deleted") return { change: { path, status: st, size: 0 } };

  // A "file" claim from the container is not trusted either. It does not need to be:
  // the publisher writes every change as a regular blob (100644, or 100755 when the
  // base tree already has the path executable), never as a symlink or a submodule.
  if (type === "symlink") throw new Reject("symlink");
  if (type === "dir") throw new Reject("submodule");
  if (type === "other" || type === "missing") throw new Reject("special_file");

  if (size > MAX_FILE_BYTES) throw new Reject("file_too_large");
  if (contentB64 === undefined) throw new Reject("malformed_output");
  const content = decodeBase64(contentB64);
  if (content === null || content.byteLength !== size)
    throw new Reject("malformed_output");

  return { change: { path, status: st, size, contentBase64: contentB64 } };
}

/**
 * Validates the container's report of changed files. The report is untrusted data:
 * every field is checked, and any problem rejects the whole change with a fixed code.
 */
export function validateChanges(raw: unknown): ValidationResult {
  try {
    if (!isRecord(raw) || !Array.isArray(raw.entries))
      throw new Reject("malformed_output");
    if (raw.truncated === true) throw new Reject("too_many_files");
    if (raw.entries.length === 0) throw new Reject("empty_change");
    if (raw.entries.length > MAX_FILES) throw new Reject("too_many_files");
    const changes: ValidChange[] = [];
    let total = 0;
    for (const entry of raw.entries) {
      const { change } = checkEntry(entry);
      total += change.size;
      if (total > MAX_TOTAL_BYTES) throw new Reject("total_too_large");
      changes.push(change);
    }
    return { ok: true, changes };
  } catch (error) {
    if (error instanceof Reject) return { ok: false, code: error.code };
    throw error;
  }
}
