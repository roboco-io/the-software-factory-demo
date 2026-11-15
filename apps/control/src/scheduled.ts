import { parseList } from "./config";
import { runDependabotSweep, type SweepResult } from "./dependabot-sweep";
import { errorKind, logDiagnostic } from "./diagnostics";
import type { ControlEnv } from "./env";
import { D1SwitchRepo } from "./factory-switch";
import { createDependabotGitHub } from "./github-dependabot";
import { createPullClient } from "./github-pulls";

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MIN_AGE_DAYS = 3;
const MAX_MIN_AGE_DAYS = 30;

/** Whole days from DEPENDABOT_MIN_AGE_DAYS. Anything else is the default, never zero. */
export function minAgeDays(value: string | undefined): number {
  if (value === undefined || !/^\d{1,2}$/.test(value.trim()))
    return DEFAULT_MIN_AGE_DAYS;
  const days = Number(value.trim());
  return days <= MAX_MIN_AGE_DAYS ? days : DEFAULT_MIN_AGE_DAYS;
}

/**
 * The daily pass (Cron Trigger). It merges qualifying Dependabot pull requests in the
 * repositories of DEPENDABOT_PROJECTS that are also in PROJECTS. Unset, with runs
 * disabled, or with the factory stopped, it does nothing.
 */
export async function runScheduled(
  env: ControlEnv,
  options: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<SweepResult[] | null> {
  const managed = parseList(env.PROJECTS);
  const projects = parseList(env.DEPENDABOT_PROJECTS).filter((repo) =>
    managed.includes(repo),
  );
  if (projects.length === 0) return null;
  const skip = (code: string) => {
    logDiagnostic("dependabot_sweep_skipped", { code });
    return null;
  };
  if (env.RUNS_ENABLED !== "true") return skip("runs_disabled");
  if (
    env.GITHUB_APP_ID === undefined ||
    env.GITHUB_APP_ID === "" ||
    env.GITHUB_APP_PRIVATE_KEY === undefined
  )
    return skip("not_configured");
  try {
    if (env.DB !== undefined && (await new D1SwitchRepo(env.DB).paused()))
      return skip("factory_paused");
    const now = options.now ?? Date.now;
    const config = {
      appId: env.GITHUB_APP_ID,
      privateKeyPem: env.GITHUB_APP_PRIVATE_KEY,
      nowSeconds: () => Math.floor(now() / 1000),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    };
    return await runDependabotSweep({
      now,
      minAgeMs: minAgeDays(env.DEPENDABOT_MIN_AGE_DAYS) * DAY_MS,
      projects,
      github: createDependabotGitHub(config),
      pulls: createPullClient(config),
      log: logDiagnostic,
    });
  } catch (error) {
    logDiagnostic("dependabot_sweep_failed", { error: errorKind(error) });
    return null;
  }
}
