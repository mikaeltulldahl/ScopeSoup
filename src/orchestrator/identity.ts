// Who a session's commits are authored by: the session, never the person whose machine it runs on.

export interface SessionIdentity {
  name: string;
  email: string;
}

function clean(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * `Scope Soup implement 12 (sonnet)` with `scopesoup@<machine>.invalid`. The machine name is only a label; the address cannot receive mail.
 * `machine` is the configured machine name (`machineName`), never the computer's host name: the commits are pushed.
 */
export function sessionIdentity(role: string, itemId: string, model: string, machine: string): SessionIdentity {
  return {
    name: `Scope Soup ${clean(role) || "session"} ${clean(itemId) || "unknown"} (${clean(model) || "unknown"})`,
    email: `scopesoup@${clean(machine).toLowerCase() || "machine"}.invalid`,
  };
}

/** Environment variables that make git author and commit as the session. They win over any git configuration. */
export function identityEnv(identity: SessionIdentity): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}
