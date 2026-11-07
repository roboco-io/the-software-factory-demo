import type { D1Like } from "./d1-repo";
import { getRun, listRuns } from "./run-query";

export interface ConsoleReadDeps {
  db: D1Like;
  publicRepos: string[];
  now(): number;
}

const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });

const ID = /^[A-Za-z0-9._-]{1,128}$/;
const notFound = () => json({ error: "not_found" }, 404);

export async function handleConsoleRead(
  request: Request,
  deps: ConsoleReadDeps,
): Promise<Response | null> {
  const parts = new URL(request.url).pathname.split("/");
  // ["", "api", "runs", id?]
  if (parts[1] !== "api" || parts[2] !== "runs") return null;
  if (parts.length > 4) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "method_not_allowed" }, 405, {
      allow: "GET, HEAD",
    });
  }
  const opts = { publicRepos: deps.publicRepos, now: deps.now() };
  if (parts.length === 3) return json(await listRuns(deps.db, opts));
  const id = parts[3] ?? "";
  if (!ID.test(id)) return notFound();
  const run = await getRun(deps.db, id, opts);
  return run === null ? notFound() : json(run);
}
