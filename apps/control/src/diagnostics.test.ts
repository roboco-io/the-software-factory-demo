import { afterEach, describe, expect, it, vi } from "vitest";
import { errorKind, logDiagnostic, safeLabel } from "./diagnostics";
import { filterBetaHeader } from "./outbound-body";

afterEach(() => vi.restoreAllMocks());

describe("diagnostics", () => {
  it("writes one JSON line with only allowed fields", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logDiagnostic("webhook_start_failed", { error: "TypeError" });
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      event: "webhook_start_failed",
      error: "TypeError",
    });
  });

  it("reduces an error to its class, never its message", () => {
    const secret = "sk-ant-api03-secret";
    const kind = errorKind(new RangeError(`bad ${secret}`));
    expect(kind).toBe("RangeError");
    expect(errorKind("text " + secret)).toBe("unknown");
    class Tricky extends Error {
      override name = secret;
    }
    expect(errorKind(new Tricky("x"))).toBe("unknown");
  });

  it("drops values that do not look like a flag name", () => {
    expect(safeLabel("files-api-2025-04-14")).toBe("files-api-2025-04-14");
    expect(safeLabel("sk-ant-api03-Secret_Value")).toBe("invalid");
    expect(safeLabel("a".repeat(65))).toBe("invalid");
    expect(safeLabel('x"\n{')).toBe("invalid");
  });

  it("logs removed beta flags, leaving kept flags alone", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const allowed = filterBetaHeader(new Headers());
    expect(allowed.has("anthropic-beta")).toBe(false);
    expect(log).not.toHaveBeenCalled();
    filterBetaHeader(
      new Headers({
        "anthropic-beta": "code-execution-2025-08-25,Not A Flag!",
      }),
    );
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      event: "beta_removed",
      flags: ["code-execution-2025-08-25", "invalid"],
    });
  });
});
