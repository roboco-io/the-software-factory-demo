export type Route =
  | { name: "home" }
  | { name: "project"; repo: string }
  | { name: "run"; id: string }
  | { name: "notFound" };

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Maps a path to a screen. Anything that does not fit exactly is notFound. */
export function matchRoute(pathname: string): Route {
  const trimmed = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  if (trimmed === "/") return { name: "home" };
  const parts = trimmed.split("/").slice(1);
  if (parts[0] === "projects") {
    // The project list moved onto the home screen; the old address still opens it.
    if (parts.length === 1) return { name: "home" };
    const [, owner, name] = parts;
    if (
      parts.length === 3 &&
      owner !== undefined &&
      name !== undefined &&
      OWNER.test(owner) &&
      NAME.test(name)
    )
      return { name: "project", repo: `${owner}/${name}` };
  }
  if (parts[0] === "runs" && parts.length === 2 && RUN_ID.test(parts[1]!))
    return { name: "run", id: parts[1]! };
  return { name: "notFound" };
}
