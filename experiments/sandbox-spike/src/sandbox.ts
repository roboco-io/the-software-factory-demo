import { Files, SandboxFileError } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";

interface SandboxEnv {
	ANTHROPIC_API_KEY: string;
	OPENAI_API_KEY: string;
	SPIKE_TOKEN: string;
}

const repositoryDirectory = "/workspace/repo";
const taskDirectory = "/workspace/task";
const pidPath = `${taskDirectory}/pid`;
const exitCodePath = `${taskDirectory}/exit-code`;
const inactivityTimeout = 30 * 60 * 1000;
const taskCheckInterval = 60 * 1000;
const taskKey = "task";

const caPath = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const trustEnv: Record<string, string> = {
	NODE_EXTRA_CA_CERTS: caPath,
	GIT_SSL_CAINFO: caPath,
	CURL_CA_BUNDLE: caPath,
	SSL_CERT_FILE: caPath,
};

// Runs the command in its own process group; records pid and exit code.
const taskScript = `dir=$1; shift
setsid sh -c 'echo "$$ $(cat /proc/sys/kernel/random/boot_id)" >"$0/pid"; exec "$@"' \\
	"$dir" "$@" >"$dir/stdout.log" 2>"$dir/stderr.log"
echo "$?" >"$dir/exit-code.tmp" && mv "$dir/exit-code.tmp" "$dir/exit-code"`;

const taskRunningScript = `read -r pid boot <"$1" &&
	[ "$boot" = "$(cat /proc/sys/kernel/random/boot_id)" ] &&
	kill -0 "$pid"`;

export class AgentSandbox extends DurableObject<SandboxEnv> {
	container: NonNullable<DurableObjectState["container"]>;
	files: Files;
	setup: Promise<void> | undefined;
	instance = "basic";

	constructor(ctx: DurableObjectState, env: SandboxEnv) {
		super(ctx, env);
		const container = ctx.container;
		if (!container) throw new Error("No container is configured");
		this.container = container;
		this.files = new Files(container);
		if (container.running) {
			void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(inactivityTimeout));
		}
	}

	async start(instance: string): Promise<{ running: boolean; instance: string }> {
		this.instance = instance;
		await this.startSandbox();
		return { running: this.container.running, instance };
	}

	async cloneRepository(repository: string, directory: string) {
		await this.startSandbox();
		return this.run(["git", "clone", "--depth", "1", "--", repository, directory], "/workspace", trustEnv);
	}

	async exec(script: string, timeoutSec: number) {
		await this.startSandbox();
		return this.run(["/bin/sh", "-c", `timeout ${timeoutSec} sh -c "$0"`, script], "/workspace", trustEnv);
	}

	async startTask(kind: string, input: string, model: string) {
		return this.ctx.blockConcurrencyWhile(async () => {
			await this.startSandbox();
			if ((await this.taskStatus()).state === "running") return "busy";
			await this.files.remove(taskDirectory, { recursive: true, force: true });
			await this.files.mkdir(taskDirectory);
			const { command, env } = this.agentCommand(kind, input, model);
			await this.container.exec(["/bin/sh", "-c", taskScript, "agent", taskDirectory, ...command], {
				cwd: kind === "sh" ? "/workspace" : repositoryDirectory,
				env: { ...trustEnv, ...env },
				stdout: "ignore",
				stderr: "ignore",
			});
			this.ctx.storage.kv.put(taskKey, "started");
			await this.ctx.storage.setAlarm(Date.now() + taskCheckInterval);
			return "started";
		});
	}

	async alarm() {
		if (!this.container.running) return;
		if ((await this.taskStatus()).state === "running") {
			await this.ctx.storage.setAlarm(Date.now() + taskCheckInterval);
			return;
		}
		this.ctx.storage.kv.delete(taskKey);
	}

	async readTask() {
		if (!this.container.running) {
			return this.ctx.storage.kv.get(taskKey) === undefined ? { state: "none" } : { state: "lost" };
		}
		return this.taskStatus();
	}

	async readLog(file: string, tail: number) {
		await this.startSandbox();
		const r = await this.run(["/bin/sh", "-c", `tail -c ${tail} "${taskDirectory}/$0"`, file], "/workspace", {});
		return r.stdout + (r.stderr ? `\n[stderr] ${r.stderr}` : "");
	}

	async readDiff() {
		await this.startSandbox();
		return this.run(["/bin/sh", "-c", "git add --intent-to-add . && git diff HEAD"], repositoryDirectory, {});
	}

	// Looks for the Worker secrets inside the container. Returns booleans only.
	async leakCheck() {
		await this.startSandbox();
		const r = await this.run(
			[
				"/bin/sh",
				"-c",
				`env; for f in /proc/[0-9]*/environ /proc/[0-9]*/cmdline; do cat "$f" 2>/dev/null | tr '\\0' '\\n'; done; cat /workspace/task/*.log 2>/dev/null; cat /root/.bash_history /root/.claude.json /root/.pi/agent/*.json 2>/dev/null; ls -la /root 2>/dev/null; find / -xdev -maxdepth 4 -name '*.env' -o -maxdepth 4 -name '.netrc' 2>/dev/null | head`,
			],
			"/workspace",
			{},
		);
		const hay = r.stdout + r.stderr;
		const probes = (secret: string) => [secret, secret.slice(-16), secret.slice(0, 16)].filter((p) => p.length >= 8);
		const found = (secret: string) => probes(secret).some((p) => hay.includes(p));
		return {
			scannedBytes: hay.length,
			anthropicKeyFound: found(this.env.ANTHROPIC_API_KEY),
			openaiKeyFound: found(this.env.OPENAI_API_KEY),
			spikeTokenFound: found(this.env.SPIKE_TOKEN),
			// whether the placeholder value used for the agent is visible (expected only in agent env)
			envHasAnthropicNameOnly: /ANTHROPIC_API_KEY=/.test(hay),
		};
	}

	async destroy() {
		if (this.container.running) await this.container.destroy();
		this.setup = undefined;
		this.ctx.storage.kv.delete(taskKey);
		return { running: this.container.running };
	}

	agentCommand(kind: string, input: string, model: string): { command: string[]; env: Record<string, string> } {
		if (kind === "claude") {
			return {
				command: [
					"claude", "--print", "--output-format", "stream-json", "--verbose",
					"--dangerously-skip-permissions", "--no-session-persistence",
					"--max-turns", "6", "--max-budget-usd", "0.2",
					"--model", model, "--", input,
				],
				env: {
					ANTHROPIC_API_KEY: "placeholder-injected-by-worker",
					CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
					IS_SANDBOX: "1",
				},
			};
		}
		if (kind === "pi") {
			return {
				command: ["pi", "--mode", "json", "--no-session", "--provider", "openai", "--model", model, "--", input],
				env: {
					OPENAI_API_KEY: "placeholder-injected-by-worker",
					PI_OFFLINE: "1",
					PI_SKIP_VERSION_CHECK: "1",
					PI_TELEMETRY: "0",
				},
			};
		}
		return { command: ["/bin/sh", "-c", input], env: {} };
	}

	async startSandbox() {
		if (this.setup === undefined || !this.container.running) {
			this.setup = this.setUpSandbox().catch((error) => {
				this.setup = undefined;
				throw error;
			});
		}
		await this.setup;
	}

	async setUpSandbox() {
		if (!this.container.running) {
			this.ctx.storage.kv.delete(taskKey);
			this.container.start({
				image: (this.container as unknown as { images: { agent: string } }).images.agent,
				instance: this.instance,
				enableInternet: false,
			} as never);
		}
		try {
			const exportsObj = (this.ctx as unknown as { exports: { Outbound: unknown } }).exports;
			await this.container.interceptAllOutboundHttp(exportsObj.Outbound as never);
			await this.container.interceptOutboundHttps("*", exportsObj.Outbound as never);
			await this.container.setInactivityTimeout(inactivityTimeout);
		} catch (error) {
			await this.container.destroy();
			throw error;
		}
	}

	async taskStatus(): Promise<{ state: string; exitCode?: number }> {
		const exitCode = await this.readOptionalText(exitCodePath);
		if (exitCode !== undefined) return { state: "finished", exitCode: Number.parseInt(exitCode, 10) };
		const pid = await this.readOptionalText(pidPath);
		if (pid === undefined) {
			return this.ctx.storage.kv.get(taskKey) === undefined ? { state: "none" } : { state: "running" };
		}
		const probe = await this.run(["/bin/sh", "-c", taskRunningScript, "probe", pidPath], "/", {});
		if (probe.exitCode === 0) return { state: "running" };
		const late = await this.readOptionalText(exitCodePath);
		if (late !== undefined) return { state: "finished", exitCode: Number.parseInt(late, 10) };
		return { state: "lost" };
	}

	async readOptionalText(path: string) {
		try {
			return await (await this.files.readFile(path)).text();
		} catch (error) {
			if (SandboxFileError.is(error) && error.code === "ENOENT") return undefined;
			throw error;
		}
	}

	async run(command: string[], cwd: string, env: Record<string, string>) {
		const process = await this.container.exec(command, { cwd, env });
		const output = await process.output();
		const decoder = new TextDecoder();
		return {
			exitCode: output.exitCode,
			stdout: decoder.decode(output.stdout),
			stderr: decoder.decode(output.stderr),
		};
	}
}
