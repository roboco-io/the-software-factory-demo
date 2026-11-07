import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import { AgentSandbox } from "./agent-sandbox";

function make() {
  const kv = new Map<string, unknown>();
  const intercepted: unknown[] = [];
  const ctx = {
    storage: {
      kv: {
        get: (k: string) => kv.get(k),
        put: (k: string, v: unknown) => void kv.set(k, v),
        delete: (k: string) => kv.delete(k),
      },
    },
    exports: { Outbound: (o: unknown) => (intercepted.push(o), {}) },
    container: {
      running: false,
      images: { agent: "img" },
      start() {},
      interceptAllOutboundHttp: async () => {},
      interceptOutboundHttps: async () => {},
      setInactivityTimeout: async () => {},
      destroy: async () => {},
    },
    blockConcurrencyWhile: async (f: () => unknown) => f(),
  };
  return { sb: new AgentSandbox(ctx as never, {} as never), kv, intercepted };
}

describe("AgentSandbox run id binding", () => {
  it("existing two-argument start works and binds no run id", async () => {
    const { sb, intercepted } = make();
    await sb.start("a/b", "claude-x");
    expect(intercepted[0]).toEqual({
      props: { repo: "a/b", model: "claude-x", phase: "implement" },
    });
  });

  it("regression: a start without run id drops a run id from an older start", async () => {
    const { sb, kv, intercepted } = make();
    kv.set("runId", "old-run");
    await sb.start("a/b", "claude-x");
    expect(kv.has("runId")).toBe(false);
    expect(JSON.stringify(intercepted[0])).not.toContain("old-run");
  });

  it("regression: a non-string stored run id is ignored", async () => {
    const { sb, kv, intercepted } = make();
    kv.set("phase", "implement");
    kv.set("repo", "a/b");
    kv.set("model", "claude-x");
    kv.set("runId", { evil: 1 });
    await (sb as unknown as { ensureRunning(): Promise<void> }).ensureRunning();
    expect(intercepted[0]).toEqual({
      props: { repo: "a/b", model: "claude-x", phase: "implement" },
    });
  });
});
