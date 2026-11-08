import type { IssueCreator } from "./budget-service";
import {
  createInstallationToken,
  field,
  githubRequest,
  type PublisherConfig,
} from "./github-publisher";
import { isValidRepo } from "./repo";

/** Opens issues with the GitHub App, with a token limited to issues:write on that one repository. */
export function createIssueCreator(config: PublisherConfig): IssueCreator {
  const doFetch = config.fetch ?? fetch;
  return {
    async createIssue(repo, title, body) {
      if (!isValidRepo(repo)) throw new Error("invalid repository");
      const { token } = await createInstallationToken(config, repo, {
        issues: "write",
      });
      if (token === undefined) throw new Error("unexpected GitHub response");
      const r = await githubRequest(
        doFetch,
        token,
        "POST",
        `/repos/${repo}/issues`,
        { body: { title, body } },
      );
      const number = field(r.data, "number");
      if (typeof number !== "number")
        throw new Error("unexpected GitHub response");
      return number;
    },
  };
}
