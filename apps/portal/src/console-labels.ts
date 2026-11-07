const DAY_MS = 86_400_000;
const AUTHORIZE = "https://github.com/login/oauth/authorize";

export interface RunCostLike {
  status: string;
  totalUsd: number | null;
}

/** An amount under a cent keeps four places, so a real cost does not read as $0.00. */
const usd = (n: number) => `$${n.toFixed(n > 0 && n < 0.01 ? 4 : 2)}`;

export interface TokenUsageLike {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const tokenTotal = (t: TokenUsageLike): number =>
  t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;

export const tokenCount = (n: number): string => n.toLocaleString("en-US");

/** A short count for a run card: exact below ten thousand, then in 만 and 억. */
export function tokenCountShort(n: number): string {
  if (n < 10_000) return tokenCount(n);
  if (n < 100_000_000) return `${(n / 10_000).toFixed(1)}만`;
  return `${(n / 100_000_000).toFixed(1)}억`;
}

/** Cost text for one run. A status without a number never shows a number. */
export function moneyText(cost: RunCostLike): string {
  if (cost.status === "not_measured") return "측정 전";
  if (cost.status === "measured" && cost.totalUsd !== null)
    return usd(cost.totalUsd);
  return "계산 불가";
}

/** One line for a run card. All four kinds of token count toward the number. */
export function costLine(
  cost: RunCostLike & {
    tokens: { implement: TokenUsageLike; review: TokenUsageLike } | null;
  },
): string {
  if (cost.tokens === null) return "토큰과 비용 측정 전";
  const total =
    tokenTotal(cost.tokens.implement) + tokenTotal(cost.tokens.review);
  const money =
    cost.status === "measured" ? moneyText(cost) : `비용 ${moneyText(cost)}`;
  return `토큰 ${tokenCountShort(total)} · ${money}`;
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

export const shortSha = (sha: string) => sha.slice(0, 7);

/** True only for the GitHub OAuth authorize address, the one place the approval may send the browser. */
export function isGithubAuthorize(url: unknown): url is string {
  return (
    typeof url === "string" &&
    url.startsWith(AUTHORIZE) &&
    (url.length === AUTHORIZE.length || url[AUTHORIZE.length] === "?")
  );
}
