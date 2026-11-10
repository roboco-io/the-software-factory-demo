import { DurableObject } from "cloudflare:workers";

// Starts the container exactly as apps/control/src/agent-sandbox.ts does:
// enableInternet false, all HTTP and all HTTPS intercepted by the Outbound entrypoint.
export class ProbeSandbox extends DurableObject {
	container: NonNullable<DurableObjectState["container"]>;

	constructor(ctx: DurableObjectState, env: unknown) {
		super(ctx, env as never);
		const c = ctx.container;
		if (!c) throw new Error("No container is configured");
		this.container = c;
	}

	async ensure() {
		if (!this.container.running) {
			this.container.start({
				image: (this.container as unknown as { images: { probe: string } }).images.probe,
				instance: "basic",
				enableInternet: false,
			} as never);
		}
		const exportsObj = (this.ctx as unknown as { exports: { Outbound: unknown } }).exports;
		await this.container.interceptAllOutboundHttp(exportsObj.Outbound as never);
		await this.container.interceptOutboundHttps("*", exportsObj.Outbound as never);
		await this.container.setInactivityTimeout(10 * 60 * 1000);
	}

	async exec(script: string, timeoutSec: number) {
		await this.ensure();
		const p = await this.container.exec(["/bin/sh", "-c", `timeout ${timeoutSec} sh -c "$0"`, script], {
			cwd: "/",
			env: { CURL_CA_BUNDLE: "/etc/cloudflare/certs/cloudflare-containers-ca.crt" },
		});
		const out = await p.output();
		const d = new TextDecoder();
		return { exitCode: out.exitCode, stdout: d.decode(out.stdout), stderr: d.decode(out.stderr) };
	}

	async destroy() {
		if (this.container.running) await this.container.destroy();
		return { running: this.container.running };
	}
}
