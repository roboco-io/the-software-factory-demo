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

describe("Outbound review fixes", () => {
  it("refuses a call while the run already has 4 calls in flight, and frees the slot after each response", async () => {
    const pending: ((r: Response) => void)[] = [];
    upstream.mockImplementation(
      () => new Promise<Response>((resolve) => pending.push(resolve)),
    );
    const waits: Promise<unknown>[] = [];
    const outbound = () =>
      new Outbound(
        {
          props,
          waitUntil: (p: Promise<unknown>) => void waits.push(p),
        } as never,
        { ANTHROPIC_API_KEY: "k", DB: db.d1 } as never,
      );
    const calls = [1, 2, 3, 4].map(() => outbound().fetch(call()));
    for (let i = 0; i < 50 && pending.length < 4; i++)
      await Promise.resolve().then(() => new Promise((r) => setTimeout(r, 0)));
    expect(pending).toHaveLength(4);
    const fifth = await outbound().fetch(call());
    expect(fifth.status).toBe(429);
    expect(await fifth.text()).toBe("DENIED: too_many_calls_in_flight\n");
    for (const resolve of pending) resolve(new Response("{}", { status: 200 }));
    for (const res of await Promise.all(calls)) await res.text();
    await Promise.all(waits);
    expect(db.query("SELECT COUNT(*) AS n FROM run_inflight")).toEqual([
      { n: 0 },
    ]);
  });

  it("records a conservative usage row when the response has no readable usage", async () => {
    const waits: Promise<unknown>[] = [];
    const res = await new Outbound(
      {
        props,
        waitUntil: (p: Promise<unknown>) => void waits.push(p),
      } as never,
      { ANTHROPIC_API_KEY: "k", DB: db.d1 } as never,
    ).fetch(call());
    await res.text();
    await Promise.all(waits);
    expect(
      db.query(
        "SELECT phase, model, input_tokens, output_tokens FROM run_usage WHERE run_id = 'r1'",
      ),
    ).toEqual([
      {
        phase: "implement",
        model: MODEL,
        input_tokens: 100000,
        output_tokens: 16000,
      },
    ]);
  });
});
