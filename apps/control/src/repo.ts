const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** True for a GitHub `owner/name`. Rejects `.`/`..` names and anything with extra slashes. */
export function isValidRepo(value: string): boolean {
  const parts = value.split("/");
  if (parts.length !== 2) return false;
  const [owner, name] = parts as [string, string];
  return OWNER.test(owner) && NAME.test(name) && name !== "." && name !== "..";
}
