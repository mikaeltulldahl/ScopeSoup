// Is the git remote the repository Scope Soup is meant to write to? A remote that is a fork or a
// mirror would take a push that was meant for another repository.

import type { Git } from "./process.ts";

/**
 * A repository address reduced to `host/path`: lower case, no user, no port, no trailing `.git`
 * or `/`. `https://`, `ssh://` and `git@host:path` forms of one repository give the same text. A
 * local path is kept as a path, with `/` between folders.
 */
export function repositoryKey(address: string): string {
  let text = address.trim();
  const scp = /^[^/@:\s]+@([^/:\s]+):(?!\/\/)(.+)$/.exec(text);
  if (scp) text = `${scp[1]}/${scp[2]}`;
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      text = `${url.hostname}/${decodeURIComponent(url.pathname)}`;
    } catch {
      // Not a URL after all: compared as written.
    }
  } else text = text.replace(/\\/g, "/");
  return text.toLowerCase().replace(/\/+/g, "/").replace(/\/$/, "").replace(/\.git$/, "").replace(/\/$/, "");
}

/** True when the two addresses name the same repository (see `repositoryKey`). */
export function sameRepository(a: string, b: string): boolean {
  return repositoryKey(a) === repositoryKey(b);
}

/**
 * Null when `remote` in `repo` fetches from and pushes to `expected` only, else why not, naming
 * both. A push goes to `pushurl` (or a `pushInsteadOf` rewrite) when one is set, so every push URL
 * is checked as well as the fetch URL.
 */
export async function remoteMismatch(git: Git, repo: string, remote: string, expected: string): Promise<string | null> {
  for (const args of [["remote", "get-url", remote], ["remote", "get-url", "--push", "--all", remote]]) {
    const got = await git(args, repo);
    if (got.code !== 0) return `git ${args.join(" ")} failed in ${repo}: ${got.stderr.trim() || `code ${got.code}`}`;
    const urls = got.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
    if (urls.length === 0) return `git ${args.join(" ")} gave no address in ${repo}`;
    const other = urls.find((url) => !sameRepository(url, expected));
    if (other !== undefined) {
      const what = args.includes("--push") ? "pushes to" : "is";
      return `the remote ${remote} in ${repo} ${what} ${other}, but the configured repository is ${expected}; they are not the same repository`;
    }
  }
  return null;
}
