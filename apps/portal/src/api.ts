export type Role = "anonymous" | "observer" | "operator";

export interface Me {
  role: Role;
  login?: string;
}
export interface Counts {
  active: number;
  merged: number;
  needs_human: number;
  failed: number;
}
export interface Project {
  repo: string;
  counts: Counts;
  /** Runs that need a person now. */
  attention: number;
  /** Null when a run used a model without a known price. */
  costUsd: number | null;
}
export interface RunCost {
  status: "measured" | "not_measured" | "unknown";
  totalUsd: number | null;
  implementUsd: number | null;
  reviewUsd: number | null;
}
export interface PathStep {
  state: string;
  at: number;
}
export type ReviewAction = "approve" | "request_changes";
export interface RunSummary {
  id: string;
  repo: string;
  issueNumber: number;
  state: string;
  reasonCode: string | null;
  prNumber: number | null;
  title: string | null;
  tier: string | null;
  headSha: string | null;
  cost: RunCost;
  path: PathStep[];
  createdAt: number;
  updatedAt: number;
}
export interface EventItem {
  id: number;
  ts: number;
  kind: string;
  fromState: string | null;
  toState: string | null;
  reasonCode: string | null;
}
export interface RunsPage {
  runs: RunSummary[];
  nextCursor: string | null;
}
export interface RunDetail {
  run: RunSummary;
  events: EventItem[];
}

/** A failed API call: the HTTP status and the fixed error code the server sent. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "ApiError";
  }
}

export interface Api {
  me(): Promise<Me>;
  projects(): Promise<{ projects: Project[] }>;
  runs(repo: string, cursor?: string): Promise<RunsPage>;
  run(id: string): Promise<RunDetail>;
  stop(id: string): Promise<void>;
  /** Starts the approval. Resolves with the address the browser must go to. */
  review(id: string, action: ReviewAction, headSha: string): Promise<string>;
  logout(): Promise<void>;
}

export function createApi(
  fetchFn: typeof fetch = (...args) => fetch(...args),
): Api {
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetchFn(path, { credentials: "same-origin", ...init });
    } catch {
      throw new ApiError(0, "network");
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const code =
        typeof body === "object" && body !== null && "error" in body
          ? String((body as { error: unknown }).error)
          : "error";
      throw new ApiError(res.status, code);
    }
    return body as T;
  }
  return {
    me: () => call<Me>("/api/me"),
    projects: () => call("/api/projects"),
    runs: (repo, cursor) => {
      const query = new URLSearchParams({ limit: "20" });
      if (cursor !== undefined) query.set("cursor", cursor);
      return call(
        `/api/projects/${repo.split("/").map(encodeURIComponent).join("/")}/runs?${query}`,
      );
    },
    run: (id) => call(`/api/runs/${encodeURIComponent(id)}`),
    stop: async (id) => {
      await call(`/api/runs/${encodeURIComponent(id)}/stop`, {
        method: "POST",
      });
    },
    review: async (id, action, headSha) => {
      const body = await call<{ redirect?: unknown }>(
        `/api/runs/${encodeURIComponent(id)}/review`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, headSha }),
        },
      );
      if (typeof body?.redirect !== "string")
        throw new ApiError(200, "bad_response");
      return body.redirect;
    },
    logout: async () => {
      await call("/api/auth/logout", { method: "POST" });
    },
  };
}

/**
 * Starts the GitHub sign-in. A probe request first finds out whether sign-in is set up, so a
 * missing configuration shows a message in the page instead of a raw JSON error page.
 */
export async function startLogin(
  fetchFn: typeof fetch,
  go: (path: string) => void,
): Promise<void> {
  let res: Response | undefined;
  try {
    res = await fetchFn("/api/auth/login", {
      method: "HEAD",
      redirect: "manual",
    });
  } catch {
    /* Let the browser try the real navigation. */
  }
  if (res?.status === 503) throw new ApiError(503, "auth_not_configured");
  go("/api/auth/login");
}
