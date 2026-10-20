import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { ENGINES, type Budget, type EngineName } from "../agents/types";
import { FACTORY_DIR } from "../paths";

const EngineSchema = z.enum(ENGINES);
const BudgetSchema = z.object({
  maxTurns: z.number().int().positive(),
  timeoutMin: z.number().positive(),
  maxUsd: z.number().positive().optional(),
});
const EngineConfigSchema = z.object({
  modelEnv: z.string().min(1),
  defaultModel: z.string().min(1).nullable(),
  pricePerMTok: z.object({ input: z.number().min(0), output: z.number().min(0) }).nullable(),
});
const RoleSchema = z.object({ engine: EngineSchema, budget: BudgetSchema });
const ConfigSchema = z.object({
  engines: z.object({
    claude: EngineConfigSchema,
    codex: EngineConfigSchema,
    pi: EngineConfigSchema,
  }),
  roles: z.object({
    triage: RoleSchema,
    implement: RoleSchema,
    fix: z.object({ engine: z.literal("same-as-implement"), budget: BudgetSchema }),
    review: RoleSchema.extend({ fallbackOrder: z.array(EngineSchema).min(1) }),
    improve: RoleSchema,
    postmortem: RoleSchema,
  }),
});

export type AgentsConfig = z.infer<typeof ConfigSchema>;

export class AssignmentError extends Error {
  override name = "AssignmentError";
}

export interface RoleAssignment {
  engine: EngineName;
  budget: Budget;
}

export interface Assignment {
  triage: RoleAssignment;
  implement: RoleAssignment;
  fix: RoleAssignment;
  review: RoleAssignment;
}

export function parseAgentsConfig(text: string): AgentsConfig {
  return ConfigSchema.parse(parse(text));
}

export function loadAgentsConfig(file = path.join(FACTORY_DIR, "agents.yml")): AgentsConfig {
  return parseAgentsConfig(readFileSync(file, "utf8"));
}

export function toBudget(b: { maxTurns: number; timeoutMin: number; maxUsd?: number }): Budget {
  const budget: Budget = { maxTurns: b.maxTurns, timeoutMs: Math.round(b.timeoutMin * 60_000) };
  if (b.maxUsd !== undefined) budget.maxUsd = b.maxUsd;
  return budget;
}

function engineFromLabels(labels: string[]): EngineName | null {
  const engines = labels
    .filter((l) => l.startsWith("agent:"))
    .map((l) => l.slice("agent:".length))
    .filter((e): e is EngineName => (ENGINES as readonly string[]).includes(e));
  if (engines.length > 1) throw new AssignmentError(`multiple agent labels: ${engines.join(", ")}`);
  return engines[0] ?? null;
}

export function pickReviewer(cfg: AgentsConfig, implementEngine: EngineName): EngineName {
  const review = cfg.roles.review;
  const chosen =
    review.engine !== implementEngine
      ? review.engine
      : review.fallbackOrder.find((e) => e !== implementEngine);
  if (!chosen || chosen === implementEngine) {
    throw new AssignmentError(`no review engine differs from implement engine ${implementEngine}`);
  }
  return chosen;
}

export function assignEngines(cfg: AgentsConfig, issueLabels: string[]): Assignment {
  const implement = engineFromLabels(issueLabels) ?? cfg.roles.implement.engine;
  const review = pickReviewer(cfg, implement);
  return {
    triage: { engine: cfg.roles.triage.engine, budget: toBudget(cfg.roles.triage.budget) },
    implement: { engine: implement, budget: toBudget(cfg.roles.implement.budget) },
    fix: { engine: implement, budget: toBudget(cfg.roles.fix.budget) },
    review: { engine: review, budget: toBudget(cfg.roles.review.budget) },
  };
}

export function resolveModel(
  cfg: AgentsConfig,
  engine: EngineName,
  env: Record<string, string | undefined>,
): string {
  const e = cfg.engines[engine];
  const fromEnv = env[e.modelEnv]?.trim();
  if (fromEnv) return fromEnv;
  if (e.defaultModel) return e.defaultModel;
  throw new AssignmentError(`${e.modelEnv} must be set for engine ${engine}`);
}

export function estimateCostUsd(
  price: { input: number; output: number } | null,
  usage: { inputTokens: number; outputTokens: number },
): number | undefined {
  if (!price) return undefined;
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
}
