// Pure part of the Outbound handler: deny everything, say which host arrived.
export function denyAll(method: string, rawUrl: string): { status: number; body: string } {
	const url = new URL(rawUrl);
	return {
		status: 403,
		body: `DENIED-BY-OUTBOUND host=${url.hostname} method=${method} path=${url.pathname}\n`,
	};
}
