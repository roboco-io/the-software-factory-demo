import { WorkerEntrypoint } from "cloudflare:workers";

interface OutboundEnv {
	ANTHROPIC_API_KEY: string;
	OPENAI_API_KEY: string;
}

const deny = (why: string) => new Response(`DENIED: ${why}\n`, { status: 403 });

// Every HTTP (80) and HTTPS (443) request from the container arrives here.
// Hosts are matched exactly; methods and paths are limited per host.
export class Outbound extends WorkerEntrypoint<OutboundEnv> {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const host = url.hostname;
		const method = request.method;
		console.log(`outbound ${method} ${url.protocol}//${host}${url.pathname}`);

		if (url.protocol !== "https:") {
			return deny(`plain http to ${host} is blocked`);
		}

		if (host === "api.anthropic.com") {
			if (method === "POST" && (url.pathname === "/v1/messages" || url.pathname === "/v1/messages/count_tokens")) {
				const headers = new Headers(request.headers);
				headers.delete("authorization");
				headers.set("x-api-key", this.env.ANTHROPIC_API_KEY);
				return fetch(new Request(request, { headers }));
			}
			return deny(`${method} ${url.pathname} on ${host}`);
		}

		if (host === "api.openai.com") {
			if (method === "POST" && (url.pathname === "/v1/responses" || url.pathname === "/v1/chat/completions")) {
				const headers = new Headers(request.headers);
				headers.set("authorization", `Bearer ${this.env.OPENAI_API_KEY}`);
				return fetch(new Request(request, { headers }));
			}
			return deny(`${method} ${url.pathname} on ${host}`);
		}

		if (host === "github.com") {
			// Read-only git over HTTPS: ref discovery and fetch only. No push, no API.
			const isInfoRefs = method === "GET" && /\/info\/refs$/.test(url.pathname) && url.searchParams.get("service") === "git-upload-pack";
			const isUploadPack = method === "POST" && /\/git-upload-pack$/.test(url.pathname);
			if (isInfoRefs || isUploadPack) return fetch(request);
			return deny(`${method} ${url.pathname} on github.com (only git-upload-pack allowed)`);
		}

		if (host === "registry.npmjs.org") {
			if (method === "GET" || method === "HEAD") return fetch(request);
			return deny(`${method} on ${host}`);
		}

		return deny(`${host} is not on the allow list`);
	}
}
