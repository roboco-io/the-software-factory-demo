import type { ProbeSandbox } from "./sandbox";

export { Outbound } from "./outbound";
export { ProbeSandbox } from "./sandbox";

interface Env {
	SANDBOX: DurableObjectNamespace<ProbeSandbox>;
	PROBE_TOKEN: string;
}

async function authorized(request: Request, token: string): Promise<boolean> {
	const enc = new TextEncoder();
	const [a, b] = await Promise.all([
		crypto.subtle.digest("SHA-256", enc.encode(request.headers.get("authorization") ?? "")),
		crypto.subtle.digest("SHA-256", enc.encode(`Bearer ${token}`)),
	]);
	return crypto.subtle.timingSafeEqual(a, b);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (!env.PROBE_TOKEN || !(await authorized(request, env.PROBE_TOKEN))) {
			return new Response("Unauthorized", { status: 401 });
		}
		const url = new URL(request.url);
		const sb = env.SANDBOX.getByName("probe");
		try {
			if (request.method === "POST" && url.pathname === "/exec") {
				return Response.json(await sb.exec(await request.text(), Number(url.searchParams.get("t") ?? "120")));
			}
			if (request.method === "POST" && url.pathname === "/destroy") return Response.json(await sb.destroy());
			return new Response("Not found", { status: 404 });
		} catch (e) {
			return Response.json({ error: String(e) }, { status: 500 });
		}
	},
};
