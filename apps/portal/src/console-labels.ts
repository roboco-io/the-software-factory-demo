const DAY_MS = 86_400_000;
const AUTHORIZE = "https://github.com/login/oauth/authorize";

export interface RunCostLike {
  status: string;
  totalUsd: number | null;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** Cost text for one run. A status without a number never shows a number. */
export function moneyText(cost: RunCostLike): string {
  if (cost.status === "not_measured") return "측정 전";
  if (cost.status === "measured" && cost.totalUsd !== null)
    return usd(cost.totalUsd);
  return "계산 불가";
}

/** A project's total. Null means at least one run used a model without a known price. */
export const costUsdText = (costUsd: number | null): string =>
  costUsd === null ? "계산 불가" : usd(costUsd);

/** Same rule as the API: waiting for approval, or stuck or failed within the last 7 days. */
export function isAttention(
  run: { state: string; updatedAt: number },
  now: number,
): boolean {
  if (run.state === "awaiting_approval") return true;
  return (
    (run.state === "needs_human" || run.state === "failed") &&
    now - run.updatedAt <= 7 * DAY_MS
  );
}

/** Attention runs first; the order inside each group is kept. */
export function sortAttentionFirst<
  T extends { state: string; updatedAt: number },
>(runs: readonly T[], now: number): T[] {
  return [
    ...runs.filter((r) => isAttention(r, now)),
    ...runs.filter((r) => !isAttention(r, now)),
  ];
}

export const shortSha = (sha: string) => sha.slice(0, 7);

/** True only for the GitHub OAuth authorize address, the one place the approval may send the browser. */
export function isGithubAuthorize(url: unknown): url is string {
  return (
    typeof url === "string" &&
    url.startsWith(AUTHORIZE) &&
    (url.length === AUTHORIZE.length || url[AUTHORIZE.length] === "?")
  );
}
