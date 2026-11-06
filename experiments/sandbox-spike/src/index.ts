import type { AgentSandbox } from "./sandbox";

export { Outbound } from "./outbound";
export { AgentSandbox } from "./sandbox";

interface Env {
	SANDBOX: DurableObjectNamespace<AgentSandbox>;
	SPIKE_TOKEN: string;
}

const nameRe = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

async function authorized(request: Request, token: string): Promise<boolean> {
	const given = request.headers.get("authorization") ?? "";
	const enc = new TextEncoder();
	const [a, b] = await Promise.all([
		crypto.subtle.digest("SHA-256", enc.encode(given)),
		crypto.subtle.digest("SHA-256", enc.encode(`Bearer ${token}`)),
	]);
	return crypto.subtle.timingSafeEqual(a, b);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (!(await authorized(request, env.SPIKE_TOKEN))) {
			return new Response("Unauthorized", { status: 401 });
		}
		const url = new URL(request.url);
		const m = /^\/s\/([^/]+)\/([a-z]+)$/.exec(url.pathname);
		if (!m || !nameRe.test(m[1])) return new Response("Not found", { status: 404 });
		const [, name, action] = m;
		const sb = env.SANDBOX.getByName(name);
		const q = url.searchParams;
		try {
			const key = `${request.method} ${action}`;
			switch (key) {
				case "POST start":
					return Response.json(await sb.start(q.get("instance") ?? "basic"));
				case "POST clone":
					return Response.json(await sb.cloneRepository(await request.text(), q.get("dir") ?? "/workspace/repo"));
				case "POST exec":
					return Response.json(await sb.exec(await request.text(), Number(q.get("t") ?? "60")));
				case "POST task": {
					const r = await sb.startTask(q.get("kind") ?? "sh", await request.text(), q.get("model") ?? "");
					return Response.json({ state: r }, { status: r === "busy" ? 409 : 202 });
				}
				case "GET task":
					return Response.json(await sb.readTask());
				case "GET log":
					return new Response(await sb.readLog(q.get("file") ?? "stdout.log", Number(q.get("tail") ?? "20000")));
				case "GET diff":
					return Response.json(await sb.readDiff());
				case "GET leak":
					return Response.json(await sb.leakCheck());
				case "POST destroy":
					return Response.json(await sb.destroy());
			}
			return new Response("Method not allowed", { status: 405 });
		} catch (error) {
			console.error("request failed", String(error));
			return Response.json({ error: String(error) }, { status: 500 });
		}
	},
};
