import { isAlias, parseDocument, visit } from "yaml";

export const TIERS = ["T0", "T1", "T2", "T3"] as const;
export type Tier = (typeof TIERS)[number];

export interface PolicyRule {
  tier: Tier;
  patterns: string[];
}
/** The app id of GitHub Actions. A required check without its own appId must come from it. */
export const ACTIONS_APP_ID = 15368;

export interface RequiredCheck {
  name: string;
  appId: number;
}

export interface Policy {
  requiredChecks: RequiredCheck[];
  autoMergeTiers: Tier[];
  rules: PolicyRule[];
}

export type ParsedPolicy = { ok: true; policy: Policy } | { ok: false };

export const MAX_POLICY_BYTES = 64 * 1024;
const MAX_CHECKS = 50;
const MAX_RULES = 200;
const MAX_PATTERNS = 100;
const MAX_STRING = 200;
const DEFAULT_TIER: Tier = "T2";
const FLOOR_TIER: Tier = "T3";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isTier = (v: unknown): v is Tier =>
  typeof v === "string" && (TIERS as readonly string[]).includes(v);
// Built from strings so the source has no raw control characters.
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]");

const isText = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length >= 1 &&
  v.length <= MAX_STRING &&
  !CONTROL.test(v);

function isPattern(v: unknown): v is string {
  if (!isText(v)) return false;
  if (v.startsWith("/") || v.includes("\\")) return false;
  return !v.split("/").some((segment) => segment === ".." || segment === "");
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const names = Object.keys(value);
  return names.length === keys.length && keys.every((k) => k in value);
}

function toRequiredCheck(v: unknown): RequiredCheck | null {
  if (isText(v)) return { name: v, appId: ACTIONS_APP_ID };
  if (!isRecord(v)) return null;
  const names = Object.keys(v);
  if (
    !names.includes("name") ||
    names.some((k) => k !== "name" && k !== "appId")
  )
    return null;
  if (!isText(v.name)) return null;
  if (v.appId === undefined) return { name: v.name, appId: ACTIONS_APP_ID };
  if (
    typeof v.appId !== "number" ||
    !Number.isSafeInteger(v.appId) ||
    v.appId < 1
  )
    return null;
  return { name: v.name, appId: v.appId };
}

function validate(value: unknown): Policy | null {
  if (!isRecord(value)) return null;
  if (!hasOnlyKeys(value, ["requiredChecks", "autoMergeTiers", "rules"]))
    return null;
  const { requiredChecks, autoMergeTiers, rules } = value;
  if (
    !Array.isArray(requiredChecks) ||
    requiredChecks.length < 1 ||
    requiredChecks.length > MAX_CHECKS
  )
    return null;
  const checks: RequiredCheck[] = [];
  for (const item of requiredChecks) {
    const check = toRequiredCheck(item);
    if (check === null) return null;
    checks.push(check);
  }
  if (
    !Array.isArray(autoMergeTiers) ||
    autoMergeTiers.length > TIERS.length ||
    !autoMergeTiers.every(isTier)
  )
    return null;
  if (!Array.isArray(rules) || rules.length > MAX_RULES) return null;
  const parsedRules: PolicyRule[] = [];
  for (const rule of rules) {
    if (!isRecord(rule) || !hasOnlyKeys(rule, ["tier", "patterns"]))
      return null;
    const { tier, patterns } = rule;
    if (
      !isTier(tier) ||
      !Array.isArray(patterns) ||
      patterns.length < 1 ||
      patterns.length > MAX_PATTERNS ||
      !patterns.every(isPattern)
    )
      return null;
    parsedRules.push({ tier, patterns: [...patterns] });
  }
  return {
    requiredChecks: checks,
    autoMergeTiers: [...autoMergeTiers],
    rules: parsedRules,
  };
}

/**
 * Parses and strictly validates `.factory/policy.yml`. Any problem, including a
 * YAML warning, duplicate key, alias or second document, makes the policy invalid.
 */
export function parsePolicy(text: string): ParsedPolicy {
  if (new TextEncoder().encode(text).length > MAX_POLICY_BYTES)
    return { ok: false };
  let value: unknown;
  try {
    const doc = parseDocument(text, {
      schema: "core",
      uniqueKeys: true,
      merge: false,
      strict: true,
      logLevel: "error",
    });
    if (doc.errors.length > 0 || doc.warnings.length > 0) return { ok: false };
    // Aliases can expand a small file into a huge value, and they hide where a value comes from.
    let alias = false;
    visit(doc, (_key, node) => {
      if (isAlias(node)) alias = true;
    });
    if (alias) return { ok: false };
    value = doc.toJS() as unknown;
  } catch {
    return { ok: false };
  }
  const policy = validate(value);
  return policy === null ? { ok: false } : { ok: true, policy };
}

const REGEX_SPECIAL = /[.+^${}()|[\]\\]/;

/** Glob to regular expression source. `**` crosses `/`; `*` and `?` do not. */
function globSource(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i += 1;
        if (pattern[i + 1] === "/") {
          i += 1;
          out += "(?:.*/)?";
        } else out += ".*";
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += REGEX_SPECIAL.test(c) ? `\\${c}` : c;
  }
  return out;
}

/** Case-insensitive glob match of a repository-relative path. */
export function matchesPattern(pattern: string, path: string): boolean {
  return new RegExp(`^${globSource(pattern.toLowerCase())}$`, "s").test(
    path.toLowerCase(),
  );
}

/**
 * True for files under `.github/` or `.factory/` at the repository root. A segment
 * is compared without case and without trailing dots or spaces, which some file
 * systems ignore.
 */
export function isFloorPath(path: string): boolean {
  const first = path.split("/")[0] ?? "";
  const name = first.toLowerCase().replace(/[. ]+$/, "");
  return name === ".github" || name === ".factory";
}

const rank = (tier: Tier) => TIERS.indexOf(tier);
const higher = (a: Tier, b: Tier): Tier => (rank(a) >= rank(b) ? a : b);

/** The tier of one path: first matching rule, default T2, and never below T3 under the floor paths. */
export function tierOfPath(path: string, policy: Policy): Tier {
  let tier: Tier = DEFAULT_TIER;
  for (const rule of policy.rules) {
    if (rule.patterns.some((p) => matchesPattern(p, path))) {
      tier = rule.tier;
      break;
    }
  }
  return isFloorPath(path) ? higher(tier, FLOOR_TIER) : tier;
}

export interface ChangedFile {
  filename: string;
  previousFilename?: string | undefined;
}

/** The highest tier among all changed paths, old paths of renames included. No files means T3. */
export function classifyPullRequest(
  files: readonly ChangedFile[],
  policy: Policy,
): Tier {
  if (files.length === 0) return "T3";
  let result: Tier = "T0";
  for (const file of files) {
    result = higher(result, tierOfPath(file.filename, policy));
    if (file.previousFilename !== undefined)
      result = higher(result, tierOfPath(file.previousFilename, policy));
  }
  return result;
}
