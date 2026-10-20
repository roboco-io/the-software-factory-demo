import type { AgentAdapter, EngineName } from "../agents/types";
import type { AgentsConfig } from "../config/agents";
import type { SpawnFn } from "../exec/process";
import type { GitPort } from "../git/port";
import type { GitHubPort } from "../github/port";
import type { PostmortemPolicy } from "../policy/postmortem";
import type { RiskPolicy } from "../policy/risk";
import type { RunStore } from "../runs/store";

export const DEFAULT_BOT_LOGIN = "roboco-software-factory-bot[bot]";

export interface Settings {
  owner: string;
  repo: string;
  workdir: string;
  botLogin: string;
  botEmail: string;
  paused: boolean;
  dailyLimit: number;
  webUrl: string;
  workersSubdomain: string;
  runUrl: string;
  runId: number | null;
  token: string | null;
  bundlePath: string | null;
  env: Record<string, string | undefined>;
}

export interface StageDeps {
  gh: GitHubPort;
  runs: RunStore;
  git: GitPort;
  spawn: SpawnFn;
  adapterFor(engine: EngineName, model: string): AgentAdapter;
  agents: AgentsConfig;
  policy: RiskPolicy;
  postmortem: PostmortemPolicy;
  settings: Settings;
  now(): Date;
  log(msg: string): void;
}

export function loadSettings(env: NodeJS.ProcessEnv): Settings {
  const [owner = "roboco-io", repo = "the-software-factory-demo"] = (env.GITHUB_REPOSITORY ?? "")
    .split("/")
    .filter(Boolean);
  const botLogin = env.FACTORY_BOT_LOGIN || DEFAULT_BOT_LOGIN;
  const userId = env.FACTORY_BOT_USER_ID?.trim();
  const limit = Number.parseInt(env.FACTORY_DAILY_LIMIT ?? "", 10);
  const runId = Number.parseInt(env.GITHUB_RUN_ID ?? "", 10);
  return {
    owner,
    repo,
    workdir: env.FACTORY_WORKDIR || process.cwd(),
    botLogin,
    botEmail: `${userId ? `${userId}+` : ""}${botLogin}@users.noreply.github.com`,
    paused: (env.FACTORY_PAUSED ?? "").trim().toLowerCase() === "true",
    dailyLimit: Number.isFinite(limit) && limit > 0 ? limit : 20,
    webUrl: env.WEB_URL || "https://roboco.io/the-software-factory-demo/",
    workersSubdomain: env.WORKERS_SUBDOMAIN || "roboco",
    runUrl: Number.isFinite(runId)
      ? `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${owner}/${repo}/actions/runs/${runId}`
      : "",
    runId: Number.isFinite(runId) ? runId : null,
    token: env.FACTORY_TOKEN || env.GITHUB_TOKEN || null,
    bundlePath: env.FACTORY_BUNDLE || null,
    env,
  };
}
