import { describe, expect, it } from "vitest";
import { PLACEHOLDER_API_KEY } from "./agent-command";
import { validateChanges } from "./changes";
import {
  COLLECT_SCRIPT,
  REPO_DIR,
  SandboxController,
  type ContainerPort,
  type ExecResult,
} from "./sandbox-core";
import { PI_MODELS_PATH } from "./review-command";
import { nodeModule } from "./testing/node";

interface Call {
  command: string[];
  cwd: string;
  env: Record<string, string>;
  background?: boolean | undefined;
}

function fakeContainer(reply: (c: Call) => Partial<ExecResult> = () => ({})) {
  const calls: Call[] = [];
  const port: ContainerPort = {
    async exec(command, options) {
      const call = { command, ...options };
      calls.push(call);
      return { exitCode: 0, stdout: "", stderr: "", ...reply(call) };
    },
  };
  return { port, calls };
}

const REAL_SECRETS = [
  "sk-ant-REAL-KEY-123456",
  "ghs_REALTOKEN123456",
  "whsec_REALSECRET",
];

describe("SandboxController", () => {
  it("clones over https for the one validated repository and returns the base commit", async () => {
    const sha = "a".repeat(40);
    const { port, calls } = fakeContainer((c) =>
      c.command[0] === "git" && c.command[1] === "rev-parse"
        ? { stdout: sha + "\n" }
        : {},
    );
    const r = await new SandboxController(port).clone("acme/demo");
    expect(r).toEqual({ ok: true, baseSha: sha });
    const clone = calls.find((c) => c.command[1] === "clone")!;
    expect(clone.command).toEqual([
      "git",
      "clone",
      "--depth",
      "1",
      "--",
      "https://github.com/acme/demo.git",
      REPO_DIR,
    ]);
    expect(clone.env.GIT_SSL_CAINFO).toContain("cloudflare-containers-ca.crt");
  });

  it("refuses repository names that are not owner/name", async () => {
    const { port } = fakeContainer();
    for (const bad of [
      "a",
      "a/b/c",
      "a/b;rm",
      "-u/x",
      "a/../b",
      "a b/c",
      "https://x/y",
    ]) {
      await expect(new SandboxController(port).clone(bad)).rejects.toThrow();
    }
  });

  it("reports a failed clone", async () => {
    const { port } = fakeContainer((c) =>
      c.command[1] === "clone" ? { exitCode: 128 } : {},
    );
    expect(await new SandboxController(port).clone("acme/demo")).toEqual({
      ok: false,
    });
  });

  it("passes no real secret in any exec env or argv, only the placeholder key", async () => {
    const { port, calls } = fakeContainer((c) => {
      if (c.command[0] === "cat") return { exitCode: 1 };
      if (c.command[1] === "rev-parse") return { stdout: "b".repeat(40) };
      return {};
    });
    const sandbox = new SandboxController(port);
    await sandbox.clone("acme/demo");
    await sandbox.startAgent({ prompt: "do it", model: "claude-sonnet-5-5" });
    await sandbox.readTaskStatus();
    await sandbox.collectChanges("b".repeat(40)).catch(() => undefined);
    const surface = JSON.stringify(
      calls.map((c) => ({ command: c.command, env: c.env })),
    );
    for (const secret of REAL_SECRETS) expect(surface).not.toContain(secret);
    const agent = calls.find((c) => c.background)!;
    expect(agent.env.ANTHROPIC_API_KEY).toBe(PLACEHOLDER_API_KEY);
    for (const c of calls) {
      for (const name of Object.keys(c.env))
        expect(name).not.toMatch(
          /GITHUB|(?<!OUTPUT_)TOKEN|SECRET|PRIVATE|OPENAI/,
        );
      if (c.env.ANTHROPIC_API_KEY !== undefined)
        expect(c.env.ANTHROPIC_API_KEY).toBe(PLACEHOLDER_API_KEY);
    }
  });

  it("starts pi, not Claude Code, for an OpenAI implementer (stage 5)", async () => {
    const { port, calls } = fakeContainer((c) => {
      if (c.command[0] === "cat") return { exitCode: 1 };
      return {};
    });
    await new SandboxController(port).startAgent({
      prompt: "do it",
      model: "gpt-6.1-terra",
    });
    const agent = calls.find((c) => c.background)!;
    expect(agent.command).toContain("pi");
    expect(agent.command).not.toContain("claude");
    expect(agent.command).toContain("--append-system-prompt");
    expect(agent.env.OPENAI_API_KEY).toBe(PLACEHOLDER_API_KEY);
    expect(agent.env.ANTHROPIC_API_KEY).toBeUndefined();
    // pi's settings (output cap) are written before the agent starts.
    const settings = calls.findIndex(
      (c) => c.command[0] === "node" && c.command.includes(PI_MODELS_PATH),
    );
    expect(settings).toBeGreaterThanOrEqual(0);
    expect(settings).toBeLessThan(calls.indexOf(agent));
    expect(
      JSON.parse(calls[settings]!.command.at(-1)!).providers.openai
        .modelOverrides["gpt-6.1-terra"].maxTokens,
    ).toBe(16000);
  });

  it("returns the tail of the agent's output for failure diagnostics", async () => {
    const { port, calls } = fakeContainer((c) =>
      c.command[0] === "tail"
        ? { stdout: c.command.at(-1)!.endsWith("stderr.log") ? "err" : "out" }
        : {},
    );
    expect(await new SandboxController(port).readFailureOutput()).toEqual({
      stderr: "err",
      stdout: "out",
    });
    for (const c of calls.filter((x) => x.command[0] === "tail"))
      expect(c.command.slice(0, 3)).toEqual(["tail", "-c", "4000"]);
  });

  it("starts the agent in the background with the prompt as a single argv element", async () => {
    const { port, calls } = fakeContainer((c) =>
      c.command[0] === "cat" ? { exitCode: 1 } : {},
    );
    const prompt = "$(touch /pwned) `x` ' \" ; && \n";
    expect(
      await new SandboxController(port).startAgent({
        prompt,
        model: "claude-sonnet-5-5",
      }),
    ).toBe("started");
    const agent = calls.find((c) => c.background)!;
    expect(agent.command.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(agent.command).toContain(prompt);
    expect(agent.command[2]).not.toContain("touch");
    expect(agent.cwd).toBe(REPO_DIR);
  });

  it("does not start a second agent while one is running", async () => {
    const { port, calls } = fakeContainer((c) => {
      if (c.command[0] === "cat" && c.command[1]?.endsWith("/exit-code"))
        return { exitCode: 1 };
      if (c.command[0] === "cat") return { stdout: "123 boot\n" };
      return { exitCode: 0 };
    });
    expect(
      await new SandboxController(port).startAgent({
        prompt: "p",
        model: "claude-sonnet-5-5",
      }),
    ).toBe("busy");
    expect(calls.some((c) => c.background)).toBe(false);
  });

  it("reads task status: finished, running, lost, none", async () => {
    const mk = (
      exit: string | null,
      pid: string | null,
      alive: boolean,
      lateExit: string | null = null,
    ) => {
      let exitReads = 0;
      return fakeContainer((c) => {
        if (c.command[0] === "cat" && c.command[1]?.endsWith("/exit-code")) {
          exitReads++;
          const v = exitReads === 1 ? exit : lateExit;
          return v === null ? { exitCode: 1 } : { stdout: v };
        }
        if (c.command[0] === "cat")
          return pid === null ? { exitCode: 1 } : { stdout: pid };
        if (c.command[0] === "/bin/sh") return { exitCode: alive ? 0 : 1 };
        return {};
      }).port;
    };
    expect(
      await new SandboxController(mk("0", null, false)).readTaskStatus(),
    ).toEqual({ state: "finished", exitCode: 0 });
    expect(
      await new SandboxController(mk(null, "1 b", true)).readTaskStatus(),
    ).toEqual({ state: "running" });
    expect(
      await new SandboxController(mk(null, "1 b", false)).readTaskStatus(),
    ).toEqual({ state: "lost" });
    expect(
      await new SandboxController(mk(null, "1 b", false, "3")).readTaskStatus(),
    ).toEqual({ state: "finished", exitCode: 3 });
    expect(
      await new SandboxController(mk(null, null, false)).readTaskStatus(),
    ).toEqual({ state: "none" });
  });

  it("reports starting (not none) when the start marker exists but the pid file does not yet", async () => {
    const { port } = fakeContainer((c) => {
      if (c.command[0] !== "cat") return {};
      return c.command[1]?.endsWith("/started")
        ? { stdout: "" }
        : { exitCode: 1 };
    });
    expect(await new SandboxController(port).readTaskStatus()).toEqual({
      state: "starting",
    });
  });

  it("writes the start marker before it spawns the agent", async () => {
    const { port, calls } = fakeContainer((c) =>
      c.command[0] === "cat" ? { exitCode: 1 } : {},
    );
    await new SandboxController(port).startAgent({
      prompt: "p",
      model: "claude-sonnet-5-5",
    });
    const marker = calls.findIndex((c) => c.command[0] === "touch");
    const spawn = calls.findIndex((c) => c.background);
    expect(marker).toBeGreaterThan(-1);
    expect(marker).toBeLessThan(spawn);
  });

  it("collectChanges validates the base commit and parses JSON output", async () => {
    const { port, calls } = fakeContainer(() => ({
      stdout: '{"truncated":false,"entries":[]}',
    }));
    const sandbox = new SandboxController(port);
    expect(await sandbox.collectChanges("c".repeat(40))).toEqual({
      truncated: false,
      entries: [],
    });
    expect(calls[0]!.command.slice(0, 2)).toEqual(["node", "-e"]);
    await expect(sandbox.collectChanges("main; rm -rf /")).rejects.toThrow();
    const bad = new SandboxController(
      fakeContainer(() => ({ stdout: "not json" })).port,
    );
    await expect(bad.collectChanges("c".repeat(40))).rejects.toThrow();
    const failed = new SandboxController(
      fakeContainer(() => ({ exitCode: 1 })).port,
    );
    await expect(failed.collectChanges("c".repeat(40))).rejects.toThrow();
  });
});

// Runs the real in-container script against a real temporary git repository.
describe("COLLECT_SCRIPT against a real git repository", () => {
  const cp = nodeModule<{
    execFileSync(
      file: string,
      args: string[],
      o?: {
        cwd?: string;
        encoding?: string;
        env?: Record<string, string | undefined>;
      },
    ): string;
  }>("node:child_process");
  const fs = nodeModule<{
    mkdtempSync(p: string): string;
    writeFileSync(
      p: string,
      d: string | Uint8Array,
      o?: { mode?: number },
    ): void;
    mkdirSync(p: string, o?: { recursive: boolean }): void;
    symlinkSync(t: string, p: string): void;
    rmSync(p: string, o: { recursive: boolean; force: boolean }): void;
    chmodSync(p: string, m: number): void;
  }>("node:fs");
  const os = nodeModule<{ tmpdir(): string }>("node:os");
  const env = {
    ...(globalThis as unknown as { process: { env: Record<string, string> } })
      .process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  const git = (cwd: string, ...args: string[]) =>
    cp.execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
      { cwd, encoding: "utf8", env },
    );

  function scenario() {
    const dir = fs.mkdtempSync(`${os.tmpdir()}/collect-`);
    git(dir, "init", "-q", "-b", "main");
    fs.writeFileSync(`${dir}/keep.txt`, "keep\n");
    fs.writeFileSync(`${dir}/gone.txt`, "gone\n");
    fs.writeFileSync(`${dir}/tool.sh`, "#!/bin/sh\n", { mode: 0o755 });
    fs.chmodSync(`${dir}/tool.sh`, 0o755);
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "base");
    const base = git(dir, "rev-parse", "HEAD").trim();
    return { dir, base };
  }
  const collect = (dir: string, base: string) =>
    JSON.parse(
      cp.execFileSync("node", ["-e", COLLECT_SCRIPT, base], {
        cwd: dir,
        encoding: "utf8",
        env,
      }),
    ) as unknown;

  it("reports added, modified and deleted files, including after the agent committed", () => {
    const { dir, base } = scenario();
    try {
      fs.writeFileSync(`${dir}/keep.txt`, "changed\n");
      fs.rmSync(`${dir}/gone.txt`, { recursive: false, force: true });
      fs.mkdirSync(`${dir}/src/한글`, { recursive: true });
      fs.writeFileSync(`${dir}/src/한글/new.ts`, "export {}\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "agent commit");
      fs.writeFileSync(`${dir}/late.txt`, "late\n");
      const report = validateChanges(collect(dir, base));
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      const byPath = Object.fromEntries(report.changes.map((c) => [c.path, c]));
      expect(Object.keys(byPath).sort()).toEqual([
        "gone.txt",
        "keep.txt",
        "late.txt",
        "src/한글/new.ts",
      ]);
      expect(byPath["gone.txt"]!.status).toBe("deleted");
      expect(byPath["keep.txt"]!.status).toBe("modified");
      expect(byPath["late.txt"]!.status).toBe("added");
      expect(atob(byPath["keep.txt"]!.contentBase64!)).toBe("changed\n");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flags symlinks and reports executables as plain changes", () => {
    const { dir, base } = scenario();
    try {
      fs.writeFileSync(`${dir}/tool.sh`, "#!/bin/sh\necho hi\n");
      fs.symlinkSync("/etc/passwd", `${dir}/link`);
      let r = validateChanges(collect(dir, base));
      expect(r).toEqual({ ok: false, code: "symlink" });
      fs.rmSync(`${dir}/link`, { recursive: false, force: true });
      r = validateChanges(collect(dir, base));
      expect(r.ok && r.changes[0]).toMatchObject({ path: "tool.sh" });
      fs.writeFileSync(`${dir}/new.sh`, "x");
      fs.chmodSync(`${dir}/new.sh`, 0o755);
      // The mode is decided later from the GitHub tree, so a new +x file is just a file here.
      expect(validateChanges(collect(dir, base)).ok).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flags a nested git repository as a submodule and protected paths", () => {
    const { dir, base } = scenario();
    try {
      fs.mkdirSync(`${dir}/vendor/lib`, { recursive: true });
      git(`${dir}/vendor/lib`, "init", "-q");
      fs.writeFileSync(`${dir}/vendor/lib/a.txt`, "a");
      git(`${dir}/vendor/lib`, "add", ".");
      git(`${dir}/vendor/lib`, "commit", "-q", "-m", "x");
      expect(validateChanges(collect(dir, base))).toEqual({
        ok: false,
        code: "submodule",
      });
      fs.rmSync(`${dir}/vendor`, { recursive: true, force: true });
      fs.mkdirSync(`${dir}/.github/workflows`, { recursive: true });
      fs.writeFileSync(`${dir}/.github/workflows/x.yml`, "on: push");
      expect(validateChanges(collect(dir, base))).toEqual({
        ok: false,
        code: "forbidden_path",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports an empty change when nothing changed", () => {
    const { dir, base } = scenario();
    try {
      expect(validateChanges(collect(dir, base))).toEqual({
        ok: false,
        code: "empty_change",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
