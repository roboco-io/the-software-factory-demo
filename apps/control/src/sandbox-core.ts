import { isValidRepo } from "./repo";
import { TRUST_ENV, buildAgentCommand } from "./agent-command";

export const REPO_DIR = "/workspace/repo";
export const TASK_DIR = "/workspace/task";
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const MAX_REPORT_CHARS = 4 * 1024 * 1024;

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ContainerPort {
  /** Runs argv in the container. `background` returns once the process has been spawned. */
  exec(
    command: string[],
    options: { cwd: string; env: Record<string, string>; background?: boolean },
  ): Promise<ExecResult>;
}

export type TaskStatus =
  | { state: "none" | "starting" | "running" | "lost" }
  | { state: "finished"; exitCode: number };

// Runs the command in its own process group; records pid and exit code. Same as the spike.
const TASK_SCRIPT = `dir=$1; shift
setsid sh -c 'echo "$$ $(cat /proc/sys/kernel/random/boot_id)" >"$0/pid"; exec "$@"' \\
	"$dir" "$@" >"$dir/stdout.log" 2>"$dir/stderr.log" </dev/null
echo "$?" >"$dir/exit-code.tmp" && mv "$dir/exit-code.tmp" "$dir/exit-code"`;

const TASK_RUNNING_SCRIPT = `read -r pid boot <"$1" &&
	[ "$boot" = "$(cat /proc/sys/kernel/random/boot_id)" ] &&
	kill -0 "$pid"`;

/**
 * Runs inside the container with node. It prints a JSON report of the net change
 * against the base commit: no `git diff --binary`, only paths, types, modes and
 * content. The control plane treats the report as untrusted data.
 * argv[1] is the 40-hex base commit.
 */
export const COLLECT_SCRIPT = String.raw`
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const MAX_ENTRIES = 200, MAX_FILE = 256 * 1024, MAX_CONTENT_TOTAL = 1024 * 1024 + 1;
const base = process.argv[1];
const git = (args) => execFileSync("git", args, { maxBuffer: 64 * 1024 * 1024 });
git(["reset", "--mixed", "--quiet", base]);
const raw = git(["-c", "core.quotepath=off", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]);
const lines = [];
for (let start = 0, i = 0; i < raw.length; i++) {
  if (raw[i] === 0) { if (i > start) lines.push(raw.subarray(start, i)); start = i + 1; }
}
const entries = [];
let truncated = false, contentTotal = 0;
for (const line of lines) {
  if (entries.length >= MAX_ENTRIES) { truncated = true; break; }
  const xy = line.subarray(0, 2).toString("latin1");
  let pathBytes = line.subarray(3);
  if (pathBytes[pathBytes.length - 1] === 0x2f) pathBytes = pathBytes.subarray(0, pathBytes.length - 1);
  let status = "modified";
  if (xy.includes("D")) status = "deleted";
  else if (xy.includes("?") || xy.includes("A")) status = "added";
  const entry = { pathB64: pathBytes.toString("base64"), status, type: "missing", mode: 0, size: 0 };
  if (status !== "deleted") {
    let st = null;
    try { st = fs.lstatSync(pathBytes); } catch { st = null; }
    if (st) {
      entry.type = st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
      entry.mode = st.mode & 0o7777;
      entry.size = st.size;
      if (entry.type === "file" && st.size <= MAX_FILE && contentTotal + st.size <= MAX_CONTENT_TOTAL) {
        entry.contentB64 = fs.readFileSync(pathBytes).toString("base64");
        contentTotal += st.size;
      }
    }
  }
  entries.push(entry);
}
process.stdout.write(JSON.stringify({ truncated, entries }));
`;

export class SandboxController {
  constructor(private readonly container: ContainerPort) {}

  private async run(
    command: string[],
    cwd: string,
    env: Record<string, string>,
  ) {
    return this.container.exec(command, { cwd, env });
  }

  async clone(repo: string): Promise<{ ok: boolean; baseSha?: string }> {
    if (!isValidRepo(repo)) throw new Error("invalid repository name");
    await this.run(["rm", "-rf", REPO_DIR], "/workspace", {});
    const cloned = await this.run(
      [
        "git",
        "clone",
        "--depth",
        "1",
        "--",
        `https://github.com/${repo}.git`,
        REPO_DIR,
      ],
      "/workspace",
      { ...TRUST_ENV },
    );
    if (cloned.exitCode !== 0) return { ok: false };
    const head = await this.run(["git", "rev-parse", "HEAD"], REPO_DIR, {});
    const baseSha = head.stdout.trim();
    if (head.exitCode !== 0 || !SHA_PATTERN.test(baseSha)) return { ok: false };
    return { ok: true, baseSha };
  }

  async readTaskStatus(): Promise<TaskStatus> {
    const exit = await this.readOptional(`${TASK_DIR}/exit-code`);
    if (exit !== undefined)
      return { state: "finished", exitCode: Number.parseInt(exit, 10) };
    const pid = await this.readOptional(`${TASK_DIR}/pid`);
    if (pid === undefined) {
      // The marker is written before the process is spawned, so it covers the gap
      // before the pid file exists.
      const marker = await this.readOptional(`${TASK_DIR}/started`);
      return marker === undefined ? { state: "none" } : { state: "starting" };
    }
    const probe = await this.run(
      ["/bin/sh", "-c", TASK_RUNNING_SCRIPT, "probe", `${TASK_DIR}/pid`],
      "/",
      {},
    );
    if (probe.exitCode === 0) return { state: "running" };
    const late = await this.readOptional(`${TASK_DIR}/exit-code`);
    if (late !== undefined)
      return { state: "finished", exitCode: Number.parseInt(late, 10) };
    return { state: "lost" };
  }

  async startAgent(input: {
    prompt: string;
    model: string;
  }): Promise<"started" | "busy"> {
    if ((await this.readTaskStatus()).state === "running") return "busy";
    const { command, env } = buildAgentCommand(input);
    await this.run(["rm", "-rf", TASK_DIR], "/workspace", {});
    await this.run(["mkdir", "-p", TASK_DIR], "/workspace", {});
    await this.run(["touch", `${TASK_DIR}/started`], "/workspace", {});
    await this.container.exec(
      ["/bin/sh", "-c", TASK_SCRIPT, "agent", TASK_DIR, ...command],
      {
        cwd: REPO_DIR,
        env,
        background: true,
      },
    );
    return "started";
  }

  /** Returns the raw JSON report. The caller validates it as untrusted data. */
  async collectChanges(baseSha: string): Promise<unknown> {
    if (!SHA_PATTERN.test(baseSha)) throw new Error("invalid base commit");
    const result = await this.run(
      ["node", "-e", COLLECT_SCRIPT, baseSha],
      REPO_DIR,
      {},
    );
    if (result.exitCode !== 0 || result.stdout.length > MAX_REPORT_CHARS) {
      throw new Error("collect failed");
    }
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Error("collect output is not JSON");
    }
  }

  private async readOptional(path: string): Promise<string | undefined> {
    const r = await this.run(["cat", path], "/", {});
    return r.exitCode === 0 ? r.stdout.trim() : undefined;
  }
}
