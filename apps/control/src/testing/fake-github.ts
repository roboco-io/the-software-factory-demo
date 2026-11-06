export interface Recorded {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
}

/** A small in-memory stand-in for the GitHub REST endpoints the publisher uses. */
export function createFakeGitHub(opts: {
  token: string;
  baseSha: string;
  failOnce?: string[];
  baseTree?: { path: string; mode: string; type: string }[];
  baseTreeTruncated?: boolean;
}) {
  const calls: Recorded[] = [];
  const refs = new Map<string, string>();
  const prs: {
    number: number;
    head: string;
    title: string;
    body: string;
    html_url: string;
  }[] = [];
  const comments: { body: string }[] = [];
  const failOnce = new Set(opts.failOnce ?? []);
  let counter = 0;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  const fetchFn = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input as string, init);
    const url = new URL(request.url);
    const method = request.method;
    const text = await request.text();
    const body: unknown = text === "" ? undefined : JSON.parse(text);
    const path = url.pathname + url.search;
    calls.push({
      method,
      path,
      auth: request.headers.get("authorization"),
      body,
    });
    if (url.origin !== "https://api.github.com")
      return json(500, { message: "unexpected origin" });
    const key = `${method} ${url.pathname}`;
    if (failOnce.has(key)) {
      failOnce.delete(key);
      return json(502, { message: "bad gateway" });
    }
    const jwtOnly =
      request.headers.get("authorization")?.startsWith("Bearer ") ?? false;
    const auth = request.headers.get("authorization") ?? "";

    if (key === "GET /repos/acme/demo/installation")
      return json(200, { id: 99 });
    if (key === "POST /app/installations/99/access_tokens")
      return json(201, { token: opts.token });
    if (auth !== `Bearer ${opts.token}` && !jwtOnly)
      return json(401, { message: "Bad credentials" });
    if (key === "GET /repos/acme/demo")
      return json(200, { default_branch: "main" });
    if (key === `GET /repos/acme/demo/git/commits/${opts.baseSha}`) {
      return json(200, { sha: opts.baseSha, tree: { sha: "tree-base" } });
    }
    if (key === "GET /repos/acme/demo/git/trees/tree-base") {
      return json(200, {
        truncated: opts.baseTreeTruncated ?? false,
        tree: opts.baseTree ?? [],
      });
    }
    if (key === "POST /repos/acme/demo/git/blobs")
      return json(201, { sha: `blob-${++counter}` });
    if (key === "POST /repos/acme/demo/git/trees")
      return json(201, { sha: "tree-new" });
    if (key === "POST /repos/acme/demo/git/commits")
      return json(201, { sha: `commit-${++counter}` });
    if (key === "POST /repos/acme/demo/git/refs") {
      const ref = (body as { ref: string; sha: string }).ref;
      if (refs.has(ref))
        return json(422, { message: "Reference already exists" });
      refs.set(ref, (body as { sha: string }).sha);
      return json(201, { ref });
    }
    const refGet = /^GET \/repos\/acme\/demo\/git\/ref\/(.+)$/.exec(key);
    if (refGet) {
      const sha = refs.get(`refs/${decodeURIComponent(refGet[1]!)}`);
      return sha
        ? json(200, { object: { sha } })
        : json(404, { message: "Not Found" });
    }
    if (key === "GET /repos/acme/demo/pulls") {
      const head = url.searchParams.get("head") ?? "";
      return json(
        200,
        prs.filter((p) => `acme:${p.head}` === head),
      );
    }
    if (key === "POST /repos/acme/demo/pulls") {
      const b = body as { head: string; title: string; body: string };
      const pr = {
        number: 40 + prs.length,
        head: b.head,
        title: b.title,
        body: b.body,
        html_url: `https://github.com/acme/demo/pull/${40 + prs.length}`,
      };
      prs.push(pr);
      return json(201, pr);
    }
    if (
      method === "GET" &&
      /^\/repos\/acme\/demo\/issues\/\d+\/comments$/.test(url.pathname)
    ) {
      return json(200, comments);
    }
    if (
      method === "POST" &&
      /^\/repos\/acme\/demo\/issues\/\d+\/comments$/.test(url.pathname)
    ) {
      comments.push({ body: (body as { body: string }).body });
      return json(201, { id: comments.length });
    }
    return json(404, { message: `no fake for ${key}` });
  };
  return { fetch: fetchFn as typeof fetch, calls, refs, prs, comments };
}
