// The board's one warning about an unprotected main branch on a GitHub remote. Protection on the remote is what holds a force push
// or a skipped hook where Scope Soup cannot (`docs/RUNNING.md`, the onboarding skill). The host says yes, no or "cannot tell"
// (`RepositoryPort.branchProtected`); only a plain no gives the warning, so no token, no rights, no network or no GitHub shows nothing.
// A person dismisses it for that repository and branch, for everyone (the dismissal is kept with the store).

import type { RepositoryPort } from "../ports/host.ts";

/** What the board shows. */
export interface BranchProtectionWarning {
  repo: string;
  branch: string;
  text: string;
}

export interface BranchProtection {
  /** The warning, or null: protected, dismissed, or not known. Reads the host at most once an hour. */
  read(): Promise<BranchProtectionWarning | null>;
  /** Dismisses the warning for this repository and branch. */
  dismiss(): void;
}

export interface BranchProtectionDeps {
  port: RepositoryPort;
  repo: string;
  /** The main branch; read on each look, since the project's configuration may change. */
  branch: () => string;
  /** The text kept by `saveDismissed` ("" for none). */
  loadDismissed: () => string | null;
  saveDismissed: (value: string) => void;
  /** Milliseconds since the epoch. */
  now: () => number;
}

const LOOK_EVERY_MS = 60 * 60_000;

export function createBranchProtection(deps: BranchProtectionDeps): BranchProtection {
  let looked: { branch: string; at: number; protectedOnHost: boolean | null } | null = null;
  const keyOf = (branch: string) => `${deps.repo}#${branch}`;
  return {
    async read() {
      const branch = deps.branch();
      if (deps.loadDismissed() === keyOf(branch)) return null;
      if (!looked || looked.branch !== branch || deps.now() - looked.at >= LOOK_EVERY_MS) {
        let answer: boolean | null = null;
        try {
          answer = await deps.port.branchProtected(branch);
        } catch {
          // Unknown stays unknown.
        }
        looked = { branch, at: deps.now(), protectedOnHost: answer };
      }
      if (looked.protectedOnHost !== false) return null;
      return {
        repo: deps.repo,
        branch,
        text: `The ${branch} branch of ${deps.repo} has no protection on GitHub. Scope Soup keeps its own pushes safe, but an agent whose command rules cannot name a flag could force-push it. Protect it in the repository's settings (no force pushes, and required checks if you like).`,
      };
    },
    dismiss() {
      deps.saveDismissed(keyOf(deps.branch()));
    },
  };
}
