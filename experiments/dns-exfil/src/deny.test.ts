import assert from "node:assert/strict";
import { test } from "node:test";
import { denyAll } from "./deny.ts";

test("every intercepted request is denied with 403", () => {
	const r = denyAll("GET", "https://cloudflare-dns.com/dns-query?dns=AAAB");
	assert.equal(r.status, 403);
});

test("the body names the host the container asked for, so the probe can see what reached the Worker", () => {
	const r = denyAll("POST", "https://dns.google/dns-query");
	assert.equal(r.body, "DENIED-BY-OUTBOUND host=dns.google method=POST path=/dns-query\n");
});

test("query strings are not echoed back (they may carry the marker twice)", () => {
	const r = denyAll("GET", "http://x.example/a?b=c");
	assert.equal(r.body, "DENIED-BY-OUTBOUND host=x.example method=GET path=/a\n");
});
