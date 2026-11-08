import { describe, expect, it, vi } from "vitest";
import { MAX_BODY_BYTES, handleWebhook, type WebhookDeps } from "./webhook";
import type { RunInput } from "./run-types";
import { sign } from "./testing/sign";

const secret = "whsec_test_secret";

function payload(over: Record<string, unknown> = {}) {
  return {
    action: "labeled",
    label: { name: "factory:go" },
    sender: { id: 101, login: "alice", type: "User" },
    repository: { full_name: "acme/demo" },
    issue: {
      number: 7,
      state: "open",
      title: "Add a footer",
      body: "Please add it.",
    },
    ...over,
  };
}

function makeDeps(over: Partial<WebhookDeps> = {}) {
  const seen = new Set<string>();
  const start = vi.fn<(input: RunInput) => Promise<{ runId: string }>>(
    async () => ({
      runId: "run1",
    }),
  );
  const claim = vi.fn(async (id: string) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const release = vi.fn(async (id: string) => void seen.delete(id));
  const deps: WebhookDeps = {
    secret,
    runsEnabled: true,
    operatorIds: ["101"],
    projects: ["acme/demo"],
    deliveries: { claim, release },
    starter: { start },
    ...over,
  };
  return { deps, start, claim, release };
}

async function post(
  deps: WebhookDeps,
  body: unknown,
  opts: {
    event?: string;
    delivery?: string | null;
    signWith?: string | null;
    raw?: string;
  } = {},
) {
  const text = opts.raw ?? JSON.stringify(body);
  const bytes = new TextEncoder().encode(text);
  const headers = new Headers({ "content-type": "application/json" });
  headers.set("x-github-event", opts.event ?? "issues");
  if (opts.delivery !== null)
    headers.set("x-github-delivery", opts.delivery ?? "d-1");
  if (opts.signWith !== null)
    headers.set(
      "x-hub-signature-256",
      await sign(opts.signWith ?? secret, bytes),
    );
  return handleWebhook(
    new Request("https://f.test/api/github/webhook", {
      method: "POST",
      headers,
      body: bytes,
    }),
    deps,
  );
}

describe("webhook", () => {
  it("starts a run for an allowed operator, project and label", async () => {
    const { deps, start } = makeDeps();
    const res = await post(deps, payload());
    expect(res.status).toBe(202);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]![0]).toMatchObject({
      repo: "acme/demo",
      issueNumber: 7,
      title: "Add a footer",
      body: "Please add it.",
      deliveryId: "d-1",
    });
  });

  it("rejects a forged signature with 401 and no side effect", async () => {
    const { deps, start, claim } = makeDeps();
    const res = await post(deps, payload(), { signWith: "attacker-secret" });
    expect(res.status).toBe(401);
    expect(start).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it("rejects a missing signature with 401", async () => {
    const { deps, start } = makeDeps();
    expect((await post(deps, payload(), { signWith: null })).status).toBe(401);
    expect(start).not.toHaveBeenCalled();
  });

  it("verifies the signature before parsing the body", async () => {
    const { deps } = makeDeps();
    const res = await post(deps, null, { raw: "{not json", signWith: "wrong" });
    expect(res.status).toBe(401);
  });

  it("returns 400 for a signed but unparseable body", async () => {
    const { deps } = makeDeps();
    expect((await post(deps, null, { raw: "{not json" })).status).toBe(400);
  });

  it("returns 503 when the secret is missing, without leaking anything", async () => {
    for (const missing of [undefined, ""]) {
      const { deps, start } = makeDeps({ secret: missing });
      const res = await post(deps, payload());
      expect(res.status).toBe(503);
      expect(await res.text()).not.toContain(secret);
      expect(start).not.toHaveBeenCalled();
    }
  });

  it("ignores an unknown sender with 202 and no side effect", async () => {
    const { deps, start, claim } = makeDeps();
    const res = await post(
      deps,
      payload({ sender: { id: 666, login: "mallory", type: "User" } }),
    );
    expect(res.status).toBe(202);
    expect(start).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it("authorizes by numeric id, not by login (a renamed or reused login gets nothing)", async () => {
    const { deps, start } = makeDeps();
    // Same login as the operator, different account id.
    const spoof = await post(
      deps,
      payload({ sender: { id: 202, login: "alice", type: "User" } }),
    );
    expect(spoof.status).toBe(202);
    expect(start).not.toHaveBeenCalled();
    // Operator renamed their login: the id still matches.
    const renamed = await post(
      deps,
      payload({ sender: { id: 101, login: "alice-new", type: "User" } }),
      { delivery: "d-2" },
    );
    expect(renamed.status).toBe(202);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("matches ids exactly and only as numbers", async () => {
    const { deps, start } = makeDeps();
    for (const id of ["101", 1010, 10, 101.5, -101, null, undefined, [101]]) {
      await post(
        deps,
        payload({ sender: { id, login: "alice", type: "User" } }),
      );
    }
    expect(start).not.toHaveBeenCalled();
  });

  it("refuses a bot sender even when the bot id is listed as an operator", async () => {
    const { deps, start } = makeDeps({ operatorIds: ["101", "303"] });
    const byType = await post(
      deps,
      payload({ sender: { id: 101, login: "alice", type: "Bot" } }),
    );
    const byName = await post(
      deps,
      payload({ sender: { id: 303, login: "factory[bot]", type: "User" } }),
      { delivery: "d-2" },
    );
    expect(byType.status).toBe(202);
    expect(byName.status).toBe(202);
    expect(start).not.toHaveBeenCalled();
  });

  it("starts nothing unless RUNS_ENABLED is on (kill switch)", async () => {
    const { deps, start, claim } = makeDeps({ runsEnabled: false });
    const res = await post(deps, payload());
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ code: "runs_disabled" });
    expect(start).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it("answers 202 with a fixed code when the global run cap is full", async () => {
    const { deps, start } = makeDeps();
    start.mockResolvedValueOnce({ outcome: "capacity_full" } as never);
    const res = await post(deps, payload());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      status: "rejected",
      code: "capacity_full",
    });
  });

  it.each(["budget_exhausted", "budget_reserved"])(
    "answers 202 with the fixed code %s when the budget stops new runs (stage 5)",
    async (outcome) => {
      const { deps, start } = makeDeps();
      start.mockResolvedValueOnce({ outcome } as never);
      const res = await post(deps, payload());
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ status: "rejected", code: outcome });
    },
  );

  it("ignores an unlisted repository", async () => {
    const { deps, start } = makeDeps();
    const res = await post(
      deps,
      payload({ repository: { full_name: "acme/other" } }),
    );
    expect(res.status).toBe(202);
    expect(start).not.toHaveBeenCalled();
  });

  it("matches repositories exactly", async () => {
    const { deps, start } = makeDeps();
    for (const full_name of [
      "Acme/demo",
      "acme/demo2",
      "acme/dem",
      "xacme/demo",
    ]) {
      await post(deps, payload({ repository: { full_name } }));
    }
    expect(start).not.toHaveBeenCalled();
  });

  it("ignores the wrong label", async () => {
    const { deps, start } = makeDeps();
    expect((await post(deps, payload({ label: { name: "bug" } }))).status).toBe(
      202,
    );
    expect(
      (await post(deps, payload({ label: { name: "factory:go2" } }))).status,
    ).toBe(202);
    expect(start).not.toHaveBeenCalled();
  });

  it("ignores other actions and other events", async () => {
    const { deps, start } = makeDeps();
    expect((await post(deps, payload({ action: "opened" }))).status).toBe(202);
    expect((await post(deps, payload(), { event: "ping" })).status).toBe(202);
    expect(
      (await post(deps, payload(), { event: "pull_request" })).status,
    ).toBe(202);
    expect(start).not.toHaveBeenCalled();
  });

  it("ignores labels on pull requests and closed issues", async () => {
    const { deps, start } = makeDeps();
    const pr = payload({
      issue: {
        number: 7,
        state: "open",
        title: "t",
        body: "b",
        pull_request: {},
      },
    });
    const closed = payload({
      issue: { number: 7, state: "closed", title: "t", body: "b" },
    });
    expect((await post(deps, pr)).status).toBe(202);
    expect((await post(deps, closed, { delivery: "d-2" })).status).toBe(202);
    expect(start).not.toHaveBeenCalled();
  });

  it("runs nothing when OPERATOR_IDS or PROJECTS are empty", async () => {
    for (const over of [{ operatorIds: [] }, { projects: [] }]) {
      const { deps, start } = makeDeps(over);
      expect((await post(deps, payload())).status).toBe(202);
      expect(start).not.toHaveBeenCalled();
    }
  });

  it("deduplicates by X-GitHub-Delivery", async () => {
    const { deps, start } = makeDeps();
    expect((await post(deps, payload(), { delivery: "same" })).status).toBe(
      202,
    );
    const again = await post(deps, payload(), { delivery: "same" });
    expect(again.status).toBe(202);
    expect(await again.json()).toMatchObject({ status: "duplicate" });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("requires a delivery id for an actionable event", async () => {
    const { deps, start } = makeDeps();
    expect((await post(deps, payload(), { delivery: null })).status).toBe(400);
    expect(start).not.toHaveBeenCalled();
  });

  it("releases the delivery and returns 500 when the run cannot start", async () => {
    const { deps, release, start } = makeDeps();
    start.mockRejectedValueOnce(new Error("boom with secret " + secret));
    const res = await post(deps, payload(), { delivery: "d-9" });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain(secret);
    expect(release).toHaveBeenCalledWith("d-9");
  });

  it("rejects bodies over 1 MB (by header and by streamed size)", async () => {
    const { deps, start } = makeDeps();
    const big = "x".repeat(MAX_BODY_BYTES + 1);
    expect((await post(deps, null, { raw: big })).status).toBe(413);
    const lying = new Request("https://f.test/api/github/webhook", {
      method: "POST",
      headers: { "x-github-event": "issues", "content-length": "10" },
      body: big,
    });
    expect((await handleWebhook(lying, deps)).status).toBe(413);
    expect(start).not.toHaveBeenCalled();
  });

  it("only accepts POST", async () => {
    const { deps } = makeDeps();
    const res = await handleWebhook(
      new Request("https://f.test/api/github/webhook"),
      deps,
    );
    expect(res.status).toBe(405);
  });
  it("logs only the error class when starting a run fails", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { deps, start, release } = makeDeps();
    const secretText = "sk-ant-api03-from-an-error-message";
    start.mockRejectedValueOnce(new TypeError(secretText));
    const res = await post(deps, payload());
    expect(res.status).toBe(500);
    expect(release).toHaveBeenCalledOnce();
    const logged = log.mock.calls.flat().join(" ");
    expect(logged).toContain("webhook_start_failed");
    expect(logged).toContain("TypeError");
    expect(logged).not.toContain(secretText);
    log.mockRestore();
  });
});
