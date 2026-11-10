import type { Tier } from "./policy";
import { costUsd, providerOf, type Provider, type TokenUsage } from "./pricing";

export type { Provider } from "./pricing";
export const PROVIDERS: readonly Provider[] = ["anthropic", "openai"];

/**
 * Stage 5 budget. Spend is an estimate: the recorded tokens of each model call times the
 * fixed prices in pricing.ts. No provider API tells the balance.
 */
export interface BudgetConfig {
  /** Monthly limit of each account, in USD. */
  monthlyUsd: Record<Provider, number>;
  /** Most one run may spend on one account. A new run starts only when this much is left. */
  runCapUsd: number;
}

const DEFAULT_MONTHLY_USD = 50;
const DEFAULT_RUN_CAP_USD = 5;

function amount(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function budgetConfig(env: {
  BUDGET_ANTHROPIC_USD?: string | undefined;
  BUDGET_OPENAI_USD?: string | undefined;
  RUN_BUDGET_USD?: string | undefined;
}): BudgetConfig {
  return {
    monthlyUsd: {
      anthropic: amount(env.BUDGET_ANTHROPIC_USD, DEFAULT_MONTHLY_USD),
      openai: amount(env.BUDGET_OPENAI_USD, DEFAULT_MONTHLY_USD),
    },
    runCapUsd: amount(env.RUN_BUDGET_USD, DEFAULT_RUN_CAP_USD),
  };
}

/** Limits an operator set (stage 5). They replace the environment defaults while present. */
export interface BudgetLimits {
  anthropicUsd: number;
  openaiUsd: number;
  runCapUsd: number;
}

/** The most an operator may set, so a typo of a few zeros is refused. */
export const MAX_LIMIT_USD = 100_000;
const LIMIT_KEYS = ["anthropicUsd", "openaiUsd", "runCapUsd"] as const;

/** The three limits from an untrusted request body, or null when anything is off. */
export function parseLimits(body: unknown): BudgetLimits | null {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return null;
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== LIMIT_KEYS.length ||
    !LIMIT_KEYS.every((k) => keys.includes(k))
  )
    return null;
  for (const k of LIMIT_KEYS) {
    const v = record[k];
    if (
      typeof v !== "number" ||
      !Number.isFinite(v) ||
      v < 0 ||
      v > MAX_LIMIT_USD
    )
      return null;
  }
  return {
    anthropicUsd: record.anthropicUsd as number,
    openaiUsd: record.openaiUsd as number,
    runCapUsd: record.runCapUsd as number,
  };
}

export function configFromLimits(limits: BudgetLimits): BudgetConfig {
  return {
    monthlyUsd: { anthropic: limits.anthropicUsd, openai: limits.openaiUsd },
    runCapUsd: limits.runCapUsd,
  };
}

/**
 * The limits in force: the latest an operator set in D1, else the environment defaults.
 * Read on every check, so a change applies to the next model call without a deploy.
 */
export async function loadBudgetConfig(
  env: Parameters<typeof budgetConfig>[0],
  limits: { latestLimits(): Promise<BudgetLimits | null> },
): Promise<BudgetConfig> {
  const stored = await limits.latestLimits();
  return stored === null ? budgetConfig(env) : configFromLimits(stored);
}

/** The billing period: the UTC calendar month that holds `now`. `end` is exclusive. */
export function billingPeriod(now: number): {
  key: string;
  start: number;
  end: number;
} {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return {
    key: `${y}-${String(m + 1).padStart(2, "0")}`,
    start: Date.UTC(y, m, 1),
    end: Date.UTC(y, m + 1, 1),
  };
}

/** USD per provider. null when a row has no price: then the spend is unknown. */
export type Spend = Record<Provider, number | null>;

export function spendByProvider(
  rows: readonly { model: string; usage: TokenUsage }[],
): Spend {
  const out: Spend = { anthropic: 0, openai: 0 };
  for (const row of rows) {
    const provider = providerOf(row.model);
    const cost = costUsd(row.model, row.usage);
    // A model without a price could belong to either account: neither total can be trusted.
    if (provider === null || cost === null)
      return { anthropic: null, openai: null };
    out[provider] = (out[provider] ?? 0) + cost;
  }
  return out;
}

export interface ProviderBudget {
  limitUsd: number;
  /** null when the spend is unknown. */
  spentUsd: number | null;
  /** What the active runs may still spend on this account, up to the run cap each. */
  reservedUsd: number;
  /** Less than one run's cap is left (or the spend is unknown). Switching and stopping go by this. */
  exhausted: boolean;
  /** A new run or review may start on this account now. */
  available: boolean;
}

export interface BudgetStatus {
  period: string;
  runCapUsd: number;
  providers: Record<Provider, ProviderBudget>;
}

export function assessBudget(
  config: BudgetConfig,
  period: string,
  spent: Spend,
  reserved: Record<Provider, number>,
): BudgetStatus {
  const one = (p: Provider): ProviderBudget => {
    const limitUsd = config.monthlyUsd[p];
    const spentUsd = spent[p];
    const reservedUsd = reserved[p];
    const exhausted =
      spentUsd === null || spentUsd + config.runCapUsd > limitUsd;
    return {
      limitUsd,
      spentUsd,
      reservedUsd,
      exhausted,
      available:
        !exhausted && spentUsd + reservedUsd + config.runCapUsd <= limitUsd,
    };
  };
  return {
    period,
    runCapUsd: config.runCapUsd,
    providers: { anthropic: one("anthropic"), openai: one("openai") },
  };
}

export const allExhausted = (s: BudgetStatus): boolean =>
  PROVIDERS.every((p) => s.providers[p].exhausted);

/** paused: both accounts reached their limit. single_engine: one did. */
export function budgetMode(
  s: BudgetStatus,
): "normal" | "single_engine" | "paused" {
  if (allExhausted(s)) return "paused";
  return PROVIDERS.some((p) => s.providers[p].exhausted)
    ? "single_engine"
    : "normal";
}

/** The model each account runs in each role. Every model must have a price entry. */
export interface EngineModels {
  implement: Record<Provider, string>;
  review: Record<Provider, string>;
}

export type ImplementChoice =
  | { kind: "engine"; provider: Provider; model: string }
  /** Both accounts reached their limit: new runs stop. */
  | { kind: "exhausted" }
  /** An account has room, but active runs hold it for now. */
  | { kind: "reserved" };

/** Claude implements while Anthropic has room; then pi on OpenAI. */
export function chooseImplementer(
  status: BudgetStatus,
  models: EngineModels,
): ImplementChoice {
  for (const provider of PROVIDERS) {
    if (status.providers[provider].available)
      return { kind: "engine", provider, model: models.implement[provider] };
  }
  return allExhausted(status) ? { kind: "exhausted" } : { kind: "reserved" };
}

export type ReviewChoice =
  | { kind: "engine"; provider: Provider; model: string; singleEngine: boolean }
  | { kind: "wait" };

const SINGLE_ENGINE_TIERS: readonly Tier[] = ["T0", "T1"];

/**
 * The other engine reviews when it has room. When only the implementer's engine is left,
 * a different model of that engine reviews T0 and T1 in a fresh session; T2, T3 and an
 * unknown tier wait until the other engine has room again.
 */
export function chooseReviewer(
  tier: Tier | undefined,
  implementModel: string,
  status: BudgetStatus,
  models: EngineModels,
): ReviewChoice {
  const own = providerOf(implementModel);
  for (const provider of PROVIDERS) {
    if (provider === own || !status.providers[provider].available) continue;
    return {
      kind: "engine",
      provider,
      model: models.review[provider],
      singleEngine: false,
    };
  }
  if (
    own !== null &&
    tier !== undefined &&
    SINGLE_ENGINE_TIERS.includes(tier) &&
    status.providers[own].available &&
    models.review[own] !== implementModel
  ) {
    return {
      kind: "engine",
      provider: own,
      model: models.review[own],
      singleEngine: true,
    };
  }
  return { kind: "wait" };
}
