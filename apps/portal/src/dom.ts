export type Child = Node | string | null | undefined | false;
export type Attrs = Readonly<Record<string, string | undefined>>;

/**
 * Builds an element. Strings become text nodes, so data never reaches the HTML parser.
 * Event-handler and style attributes are refused: the page's CSP forbids them anyway.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (value === undefined) continue;
    if (/^on/i.test(name) || name.toLowerCase() === "style")
      throw new Error(`attribute ${name} is not allowed`);
    el.setAttribute(name, value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(
      typeof child === "string" ? document.createTextNode(child) : child,
    );
  }
  return el;
}

/** A link to a page of this app. The app's router handles the click. */
export const link = (href: string, ...children: Child[]) =>
  h("a", { href, "data-link": "" }, ...children);

const GITHUB_REPO =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

/** An external link to the repository's issue or pull request, or null when the name is not a plain owner/name. */
export function githubLink(
  repo: string,
  kind: "issues" | "pull",
  number: number | null,
  text: string,
): HTMLAnchorElement | null {
  if (number === null || !Number.isSafeInteger(number) || number < 1)
    return null;
  if (!GITHUB_REPO.test(repo)) return null;
  return h(
    "a",
    {
      href: `https://github.com/${repo}/${kind}/${number}`,
      target: "_blank",
      rel: "noopener noreferrer",
    },
    text,
  );
}

/** `owner/name` as a path under /projects. */
export const projectPath = (repo: string) =>
  `/projects/${repo.split("/").map(encodeURIComponent).join("/")}`;
export const runPath = (id: string) => `/runs/${encodeURIComponent(id)}`;

export function formatTime(ts: number): { text: string; iso: string } {
  const date = new Date(ts);
  if (!Number.isFinite(ts) || Number.isNaN(date.getTime()))
    return { text: "-", iso: "" };
  return { text: date.toLocaleString("ko-KR"), iso: date.toISOString() };
}
