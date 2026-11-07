import { field, githubRequest } from "./github-publisher";

export interface UserGitHub {
  exchangeCode(code: string): Promise<string>;
  getUser(token: string): Promise<{ id: string; login: string }>;
  getPullHead(
    token: string,
    repo: string,
    prNumber: number,
  ): Promise<{ headSha: string; open: boolean }>;
  postReview(
    token: string,
    repo: string,
    prNumber: number,
    review: {
      commitId: string;
      event: "APPROVE" | "REQUEST_CHANGES";
      body: string;
    },
  ): Promise<void>;
}

const TOKEN_URL = "https://github.com/login/oauth/access_token";

/**
 * GitHub calls made with a user's OAuth token. Errors are fixed strings or
 * GitHubError (method, route, status): never the token, the secret or a response body.
 */
export function createUserGitHub(config: {
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
}): UserGitHub {
  const doFetch = config.fetch ?? fetch;

  // Wraps a call so any failure becomes a message without secrets.
  async function safe<T>(label: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof Error && error.name === "GitHubError") throw error;
      throw new Error(`GitHub ${label} failed`);
    }
  }

  return {
    exchangeCode: (code) =>
      safe("token exchange", async () => {
        const response = await doFetch(TOKEN_URL, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "user-agent": "software-factory-control",
          },
          body: JSON.stringify({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            code,
          }),
        });
        let data: unknown;
        try {
          data = JSON.parse(await response.text());
        } catch {
          data = undefined;
        }
        const token = field(data, "access_token");
        if (!response.ok || typeof token !== "string" || token === "") {
          throw new Error("token exchange rejected");
        }
        return token;
      }),

    getUser: (token) =>
      safe("user lookup", async () => {
        const r = await githubRequest(doFetch, token, "GET", "/user");
        const id = field(r.data, "id");
        const login = field(r.data, "login");
        if (
          (typeof id !== "number" && typeof id !== "string") ||
          typeof login !== "string"
        ) {
          throw new Error("unexpected GitHub response");
        }
        return { id: String(id), login };
      }),

    getPullHead: (token, repo, prNumber) =>
      safe("pull lookup", async () => {
        const r = await githubRequest(
          doFetch,
          token,
          "GET",
          `/repos/${repo}/pulls/${prNumber}`,
        );
        const sha = field(r.data, "head", "sha");
        const state = field(r.data, "state");
        if (typeof sha !== "string" || typeof state !== "string") {
          throw new Error("unexpected GitHub response");
        }
        return { headSha: sha, open: state === "open" };
      }),

    postReview: (token, repo, prNumber, review) =>
      safe("review", async () => {
        await githubRequest(
          doFetch,
          token,
          "POST",
          `/repos/${repo}/pulls/${prNumber}/reviews`,
          {
            body: {
              commit_id: review.commitId,
              event: review.event,
              body: review.body,
            },
          },
        );
      }),
  };
}
