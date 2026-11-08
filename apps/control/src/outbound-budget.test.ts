import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { D1RunRepo } from "./d1-repo";
import { createTestD1, readMigrations } from "./testing/d1";

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

import { Outbound } from "./outbound";

const MODEL = "claude-sonnet-5-5";
let db: ReturnType<typeof createTestD1>;
let upstream: ReturnType<typeof vi.fn>;

function make(props: Record<string, unknown>) {
  return new Outbound(
    { props, waitUntil: () => undefined } as never,
    { ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k", DB: db.d1 } as never,
  );
}
const call = (model = MODEL) =>
  new Request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 100, messages: [] }),
  });
/** Fake usage: `usd` dollars of Sonnet input tokens, recorded now. */
async function spend(runId: string, usd: number) {
  await new D1RunRepo(db.d1 as never).recordUsage({
    runId,
    phase: "implement",
    model: MODEL,
    inputTokens: Math.round((usd / 2) * 1_000_000),
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ts: Date.now(),
  });
}

beforeEach(async () => {
  db = createTestD1(readMigrations());
  const runs = new D1RunRepo(db.d1 as never);
  for (const id of ["r1", "old"])
    await runs.createRun(
      { id, repo: "a/b", issueNumber: id === "r1" ? 1 : 2, ts: 1 },
      9,
    );
  upstream = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", upstream);
});
afterEach(() => vi.unstubAllGlobals());

const props = { repo: "a/b", model: MODEL, phase: "implement", runId: "r1" };

describe("Outbound budget check (fake usage)", () => {
  it("forwards the call while the run and the month have room", async () => {
    await spend("r1", 4.99);
    const res = await make(props).fetch(call());
    expect(res.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("refuses the call once the run spent its $5 cap, without reaching the provider", async () => {
    await spend("r1", 5);
    const res = await make(props).fetch(call());
    expect(res.status).toBe(402);
    expect(await res.text()).toBe("DENIED: run_budget_exceeded\n");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses the call once the account reached its $50 monthly limit", async () => {
    for (let i = 0; i < 10; i++) await spend("old", 5);
    const res = await make(props).fetch(call());
    expect(res.status).toBe(402);
    expect(await res.text()).toBe("DENIED: monthly_budget_exceeded\n");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses a model without a price, because its spend cannot be counted", async () => {
    const res = await make({ ...props, model: "mystery" }).fetch(
      call("mystery"),
    );
    expect(res.status).toBe(402);
    expect(await res.text()).toBe("DENIED: model_not_priced\n");
  });

  it("refuses a model call from a sandbox with no run to charge", async () => {
    const noRun = { repo: props.repo, model: props.model, phase: props.phase };
    const res = await make(noRun).fetch(call());
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("DENIED: no_run_bound\n");
  });

  it("fails closed when the budget cannot be read", async () => {
    const broken = new Outbound(
      { props, waitUntil: () => undefined } as never,
      {
        ANTHROPIC_API_KEY: "k",
        DB: {
          prepare: () => {
            throw new Error("D1 down");
          },
        },
      } as never,
    );
    const res = await broken.fetch(call());
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("DENIED: budget_unavailable\n");
    expect(upstream).not.toHaveBeenCalled();
  });
});
