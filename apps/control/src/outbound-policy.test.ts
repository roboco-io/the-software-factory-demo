import { describe, expect, it } from "vitest";
import {
  decideOutbound,
  injectAnthropicKey,
  injectOpenAIKey,
  selectKey,
  type SandboxPhase,
} from "./outbound-policy";

type Ctx = { repo?: string; phase?: SandboxPhase };
const run: Ctx = { repo: "acme/demo", phase: "implement" };
const review: Ctx = { repo: "acme/demo", phase: "review" };
const decide = (method: string, url: string, ctx: Ctx = run) =>
  decideOutbound({ method, url }, ctx);
const allowed = (method: string, url: string) =>
  expect(decide(method, url)).toMatchObject({ allow: true });
const denied = (method: string, url: string, ctx?: Ctx) =>
  expect(decide(method, url, ctx)).toMatchObject({ allow: false });

describe("outbound policy: Anthropic", () => {
  it("allows only POST /v1/messages and /v1/messages/count_tokens", () => {
    allowed("POST", "https://api.anthropic.com/v1/messages");
    allowed("POST", "https://api.anthropic.com/v1/messages?beta=true");
    allowed("POST", "https://api.anthropic.com/v1/messages/count_tokens");
    expect(decide("POST", "https://api.anthropic.com/v1/messages")).toEqual({
      allow: true,
      target: "anthropic",
    });
  });
  it.each([
    ["GET", "https://api.anthropic.com/v1/messages"],
    ["PUT", "https://api.anthropic.com/v1/messages"],
    ["DELETE", "https://api.anthropic.com/v1/messages"],
    ["POST", "https://api.anthropic.com/v1/models"],
    ["GET", "https://api.anthropic.com/v1/models"],
    ["POST", "https://api.anthropic.com/v1/organizations"],
    ["POST", "https://api.anthropic.com/v1/messages/batches"],
    ["POST", "https://api.anthropic.com/v1/messages/"],
    ["POST", "https://api.anthropic.com/v1/messages/count_tokens/x"],
    ["POST", "https://api.anthropic.com/v1/%6Dessages"],
    ["POST", "https://api.anthropic.com/v1/../v1/models"],
    ["POST", "https://api.anthropic.com/"],
    ["POST", "http://api.anthropic.com/v1/messages"],
    ["POST", "https://api.anthropic.com:8443/v1/messages"],
    ["POST", "https://user:pw@api.anthropic.com/v1/messages"],
    ["POST", "https://api.anthropic.com.evil.test/v1/messages"],
    ["POST", "https://evil.test/api.anthropic.com/v1/messages"],
    ["POST", "https://API.anthropic.com.:443/v1/messages"],
    ["POST", "https://sub.api.anthropic.com/v1/messages"],
  ])("denies %s %s", (m, u) => denied(m, u));
});

describe("outbound policy: GitHub", () => {
  it("allows ref discovery and upload-pack for the run's repo only", () => {
    allowed(
      "GET",
      "https://github.com/acme/demo/info/refs?service=git-upload-pack",
    );
    allowed(
      "GET",
      "https://github.com/acme/demo.git/info/refs?service=git-upload-pack",
    );
    allowed("POST", "https://github.com/acme/demo/git-upload-pack");
    allowed("POST", "https://github.com/acme/demo.git/git-upload-pack");
    allowed(
      "GET",
      "https://GitHub.com/ACME/Demo.git/info/refs?service=git-upload-pack",
    );
  });
  it("never allows receive-pack", () => {
    denied(
      "GET",
      "https://github.com/acme/demo/info/refs?service=git-receive-pack",
    );
    denied("POST", "https://github.com/acme/demo/git-receive-pack");
    denied("POST", "https://github.com/acme/demo.git/git-receive-pack");
  });
  it("denies other repositories, including look-alikes", () => {
    denied(
      "GET",
      "https://github.com/acme/other/info/refs?service=git-upload-pack",
    );
    denied("POST", "https://github.com/other/demo/git-upload-pack");
    denied("POST", "https://github.com/acme/demo2/git-upload-pack");
    denied("POST", "https://github.com/acme/demo/../other/git-upload-pack");
    denied("POST", "https://github.com/acme/demo%2Fx/git-upload-pack");
    denied("POST", "https://github.com/acme/demo/x/git-upload-pack");
    denied("POST", "https://github.com/xacme/demo/git-upload-pack");
  });
  it("denies every other path, method, query and github host", () => {
    denied("GET", "https://github.com/acme/demo");
    denied("GET", "https://github.com/acme/demo/info/refs");
    denied(
      "GET",
      "https://github.com/acme/demo/info/refs?service=git-upload-pack&x=1",
    );
    denied("POST", "https://github.com/acme/demo/git-upload-pack?x=1");
    denied("GET", "https://github.com/acme/demo/git-upload-pack");
    denied(
      "POST",
      "https://github.com/acme/demo/info/refs?service=git-upload-pack",
    );
    denied("PUT", "https://github.com/acme/demo/git-upload-pack");
    denied("DELETE", "https://github.com/acme/demo/git-upload-pack");
    denied("GET", "https://api.github.com/repos/acme/demo");
    denied("POST", "https://api.github.com/repos/acme/demo/pulls");
    denied("GET", "https://raw.githubusercontent.com/acme/demo/main/README.md");
    denied("GET", "https://gist.github.com/x");
    denied(
      "GET",
      "https://github.com.evil.test/acme/demo/info/refs?service=git-upload-pack",
    );
    denied(
      "GET",
      "http://github.com/acme/demo/info/refs?service=git-upload-pack",
    );
    denied(
      "GET",
      "https://github.com:444/acme/demo/info/refs?service=git-upload-pack",
    );
  });
  it("denies GitHub entirely when no repo is bound to the run", () => {
    denied(
      "GET",
      "https://github.com/acme/demo/info/refs?service=git-upload-pack",
      {},
    );
    denied("POST", "https://github.com/acme/demo/git-upload-pack", {
      repo: "",
    });
    denied("POST", "https://github.com/acme/demo/git-upload-pack", {
      repo: "not a repo",
    });
    denied("POST", "https://github.com/acme/demo/git-upload-pack", {
      repo: "acme/../x",
    });
  });
});

describe("outbound policy: everything else", () => {
  it.each([
    ["GET", "https://example.com/"],
    ["POST", "https://attacker.example.net/collect"],
    ["GET", "https://registry.npmjs.org/is-odd"],
    ["GET", "https://api.openai.com/v1/models"],
    ["POST", "https://api.openai.com/v1/responses"],
    ["GET", "http://example.com/"],
    ["GET", "https://1.1.1.1/"],
    ["GET", "https://169.254.169.254/latest/meta-data/"],
    ["GET", "http://169.254.169.254/"],
    ["GET", "https://[::1]/"],
    ["GET", "ftp://github.com/acme/demo"],
    ["GET", "not a url"],
    ["CONNECT", "https://github.com/acme/demo/git-upload-pack"],
  ])("denies %s %s", (m, u) => denied(m, u));
});

describe("injectAnthropicKey", () => {
  it("removes the placeholder and injects the real key", () => {
    const original = new Headers({
      "x-api-key": "placeholder-injected-by-worker",
      authorization: "Bearer placeholder",
      "anthropic-version": "2023-06-01",
    });
    const out = injectAnthropicKey(original, "sk-real");
    expect(out.get("x-api-key")).toBe("sk-real");
    expect(out.has("authorization")).toBe(false);
    expect(out.get("anthropic-version")).toBe("2023-06-01");
    expect(original.get("x-api-key")).toBe("placeholder-injected-by-worker");
    expect([...out.values()].join(" ")).not.toContain("placeholder");
  });
});

describe("outbound policy: OpenAI", () => {
  const openai = (method: string, url: string, ctx: Ctx = review) =>
    decideOutbound({ method, url }, ctx);

  it("allows only POST https://api.openai.com/v1/responses in the review phase", () => {
    expect(openai("POST", "https://api.openai.com/v1/responses")).toEqual({
      allow: true,
      target: "openai",
    });
  });
  it.each([
    ["GET", "https://api.openai.com/v1/responses"],
    ["PUT", "https://api.openai.com/v1/responses"],
    ["DELETE", "https://api.openai.com/v1/responses/resp_1"],
    ["GET", "https://api.openai.com/v1/responses/resp_1"],
    ["POST", "https://api.openai.com/v1/responses/resp_1/cancel"],
    ["POST", "https://api.openai.com/v1/responses/"],
    ["POST", "https://api.openai.com/v1/responses?x=1"],
    ["POST", "https://api.openai.com/v1/chat/completions"],
    ["POST", "https://api.openai.com/v1/files"],
    ["POST", "https://api.openai.com/v1/embeddings"],
    ["POST", "https://api.openai.com/v1/conversations"],
    ["POST", "https://api.openai.com/v1/%72esponses"],
    ["POST", "https://api.openai.com/v1/../v1/files"],
    ["POST", "http://api.openai.com/v1/responses"],
    ["POST", "https://api.openai.com:8443/v1/responses"],
    ["POST", "https://user:pw@api.openai.com/v1/responses"],
    ["POST", "https://api.openai.com.evil.test/v1/responses"],
    ["POST", "https://evil.test/api.openai.com/v1/responses"],
    ["POST", "https://sub.api.openai.com/v1/responses"],
  ])("denies %s %s", (m, u) => {
    expect(openai(m, u)).toMatchObject({ allow: false });
  });

  it("review sandbox cannot reach Anthropic and vice versa", () => {
    for (const path of ["/v1/messages", "/v1/messages/count_tokens"]) {
      expect(
        openai("POST", `https://api.anthropic.com${path}`, review),
      ).toMatchObject({ allow: false });
      expect(
        openai("POST", `https://api.anthropic.com${path}`, run),
      ).toMatchObject({ allow: true, target: "anthropic" });
    }
    expect(
      openai("POST", "https://api.openai.com/v1/responses", run),
    ).toMatchObject({ allow: false });
  });

  it("a sandbox without a phase reaches neither provider", () => {
    const none: Ctx = { repo: "acme/demo" };
    expect(
      openai("POST", "https://api.openai.com/v1/responses", none),
    ).toMatchObject({ allow: false });
    expect(
      openai("POST", "https://api.anthropic.com/v1/messages", none),
    ).toMatchObject({ allow: false });
  });

  it("keeps the per-repo GitHub clone rule in both phases", () => {
    for (const ctx of [run, review]) {
      expect(
        openai("POST", "https://github.com/acme/demo/git-upload-pack", ctx),
      ).toMatchObject({ allow: true, target: "github" });
      expect(
        openai("POST", "https://github.com/acme/other/git-upload-pack", ctx),
      ).toMatchObject({ allow: false });
    }
  });
});

describe("selectKey", () => {
  const env = { ANTHROPIC_API_KEY: "sk-ant-X", OPENAI_API_KEY: "sk-oai-Y" };
  it("gives each target only its own provider's key", () => {
    expect(selectKey("anthropic", env)).toBe("sk-ant-X");
    expect(selectKey("openai", env)).toBe("sk-oai-Y");
    expect(selectKey("github", env)).toBeUndefined();
    expect(
      selectKey("openai", { ANTHROPIC_API_KEY: "sk-ant-X" }),
    ).toBeUndefined();
    expect(
      selectKey("anthropic", { OPENAI_API_KEY: "sk-oai-Y" }),
    ).toBeUndefined();
    expect(selectKey("openai", { OPENAI_API_KEY: "" })).toBeUndefined();
  });
});

describe("injectOpenAIKey", () => {
  it("removes the placeholder and account routing headers and sets the real key", () => {
    const original = new Headers({
      authorization: "Bearer placeholder-injected-by-outbound",
      "openai-organization": "org-other",
      "openai-project": "proj-other",
      "x-api-key": "placeholder",
      "content-type": "application/json",
    });
    const out = injectOpenAIKey(original, "sk-real");
    expect(out.get("authorization")).toBe("Bearer sk-real");
    expect(out.has("openai-organization")).toBe(false);
    expect(out.has("openai-project")).toBe(false);
    expect(out.has("x-api-key")).toBe(false);
    expect(out.get("content-type")).toBe("application/json");
    expect(original.get("authorization")).toContain("placeholder");
  });
});
