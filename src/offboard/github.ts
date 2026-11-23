// Offboarding on GitHub, through Scope Soup's own REST client: the repository's labels and the open pull requests from its
// `scopesoup/*` branches; deleting a label and closing a pull request (never merging, never touching a closed one). Tests use a fake
// `OffboardGitHub`; this one is only made with a token from SCOPESOUP_GITHUB_TOKEN.

import { createClient, GitHubError } from "../hosts/github/client.ts";
import type { OffboardGitHub } from "./scan.ts";

interface RestPull {
  number: number;
  title: string;
  state: string;
  head: { ref: string; repo: { full_name: string } | null };
}

export function githubPort(token: string, repo: string): OffboardGitHub {
  const client = createClient({ token, repo });
  const r = client.repoPath;
  return {
    repo,
    labels: async () => (await client.list<{ name: string }>(r("/labels?per_page=100"))).data.map((label) => label.name),
    pulls: async () =>
      (await client.list<RestPull>(r("/pulls?state=open&per_page=100"))).data
        .filter((pull) => pull.state === "open" && pull.head.ref.startsWith("scopesoup/") && pull.head.repo?.full_name.toLowerCase() === repo.toLowerCase())
        .map((pull) => ({ number: pull.number, title: pull.title, head: pull.head.ref })),
    deleteLabel: async (name) => {
      try {
        await client.send("DELETE", r(`/labels/${encodeURIComponent(name)}`));
      } catch (error) {
        if (!(error instanceof GitHubError && error.status === 404)) throw error;
      }
    },
    closePull: async (number) => {
      await client.send("PATCH", r(`/pulls/${number}`), { state: "closed" });
    },
  };
}
