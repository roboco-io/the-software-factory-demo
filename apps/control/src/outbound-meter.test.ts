import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestD1, readMigrations } from "./testing/d1";

type Usage = Parameters<
  InstanceType<(typeof import("./d1-repo"))["D1RunRepo"]>["recordUsage"]
>[0];

const holder = vi.hoisted(() => ({
  repo: undefined as undefined | { recordUsage(u: unknown): Promise<void> },
}));

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
vi.mock("./d1-repo", async (orig) => {
  const real = await orig<typeof import("./d1-repo")>();
  return {
    ...real,
    D1RunRepo: class {
      constructor(db: unknown) {
        return holder.repo ?? new real.D1RunRepo(db as never);
      }
    },
  };
});

// These tests are about metering. The budget check has its own tests (outbound-budget.test.ts).
vi.mock("./outbound-budget", () => ({
  checkCallBudget: async () => ({ allow: true }),
}));

import { Outbound } from "./outbound";

const SSE =
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":3,"cache_creation_input_tokens":2,"output_tokens":1}}}\n\n' +
  'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n';

let recorded: Usage[];
let waited: Promise<unknown>[];
let realDb: ReturnType<typeof createTestD1> | undefined;

function make(props: Record<string, unknown>) {
  const ctx = {
    props,
    waitUntil: (p: Promise<unknown>) => void waited.push(p),
  };
  return new Outbound(
    ctx as never,
    {
      ANTHROPIC_API_KEY: "k",
      DB: realDb?.d1 ?? {},
    } as never,
  );
}
const modelReq = () =>
  new Request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m1", max_tokens: 100, messages: [] }),
  });

beforeEach(() => {
  recorded = [];
  waited = [];
  realDb = undefined;
  holder.repo = {
    recordUsage: async (u) => void recorded.push(u as Usage),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(SSE, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    ),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Outbound metering", () => {
  it("model response metered and recorded with phase and model", async () => {
    const res = await make({
      repo: "a/b",
      model: "m1",
      phase: "implement",
      runId: "r1",
    }).fetch(modelReq());
    expect(await res.text()).toBe(SSE);
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
    {
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        runId: "r1",
        phase: "implement",
        model: "m1",
        inputTokens: 10,
        outputTokens: 7,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
      });
      expect(typeof recorded[0]?.ts).toBe("number");
    }
  });

  it("writes a real run_usage row through the real repo", async () => {
    realDb = createTestD1(readMigrations());
    holder.repo = undefined;
    await realDb.d1
      .prepare(
        "INSERT INTO runs (id, repo, issue_number, state, created_at, updated_at) VALUES ('r1','a/b',1,'queued',1,1)",
      )
      .run();
    const res = await make({
      repo: "a/b",
      model: "m1",
      phase: "implement",
      runId: "r1",
    }).fetch(modelReq());
    await res.text();
    await Promise.all(waited);
    const { results } = await realDb.d1
      .prepare("SELECT * FROM run_usage WHERE run_id = ?")
      .bind("r1")
      .all();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      run_id: "r1",
      phase: "implement",
      model: "m1",
      input_tokens: 10,
      output_tokens: 7,
      cache_read_tokens: 3,
      cache_write_tokens: 2,
    });
  });

  it("non-model traffic not metered", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("x", { status: 200 }));
    const res = await make({
      repo: "a/b",
      model: "m1",
      phase: "implement",
      runId: "r1",
    }).fetch(
      new Request(
        "https://github.com/a/b.git/info/refs?service=git-upload-pack",
      ),
    );
    expect(await res.text()).toBe("x");
    expect(waited).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  it("test_no_run_id_refused: a model call with no run to charge never reaches the provider (stage 5)", async () => {
    const res = await make({
      repo: "a/b",
      model: "m1",
      phase: "implement",
    }).fetch(modelReq());
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("DENIED: no_run_bound\n");
    expect(fetch).not.toHaveBeenCalled();
    expect(recorded).toHaveLength(0);
  });

  it("test_record_failure_logged_only: a rejecting recordUsage logs the kind and the response arrives", async () => {
    holder.repo = {
      recordUsage: async () => {
        throw new TypeError("SECRET-CONTENT");
      },
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await make({
      repo: "a/b",
      model: "m1",
      phase: "implement",
      runId: "r1",
    }).fetch(modelReq());
    expect(await res.text()).toBe(SSE);
    await expect(Promise.all(waited)).resolves.toBeDefined();
    const lines = log.mock.calls.map((c) => c.join(" "));
    expect(
      lines.some(
        (l) => l.includes("usage-record-failed") && l.includes("TypeError"),
      ),
    ).toBe(true);
    expect(lines.join("\n")).not.toContain("SECRET-CONTENT");
  });

  it("regression: waitUntil throwing still returns a readable metered response", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const o = make({
      repo: "a/b",
      model: "m1",
      phase: "implement",
      runId: "r1",
    });
    (o as unknown as { ctx: { waitUntil: () => never } }).ctx.waitUntil =
      () => {
        throw new Error("no waitUntil");
      };
    const res = await o.fetch(modelReq());
    expect(await res.text()).toBe(SSE);
  });
});
