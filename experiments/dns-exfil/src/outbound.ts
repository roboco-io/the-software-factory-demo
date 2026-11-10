import { WorkerEntrypoint } from "cloudflare:workers";
import { denyAll } from "./deny";

// Every HTTP and HTTPS request from the container arrives here. Nothing is forwarded,
// so the Worker itself never resolves or contacts the requested host.
export class Outbound extends WorkerEntrypoint {
	async fetch(request: Request): Promise<Response> {
		const r = denyAll(request.method, request.url);
		console.log(r.body.trim());
		return new Response(r.body, { status: r.status });
	}
}
