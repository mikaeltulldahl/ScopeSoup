// Migrating the meta branch to this Scope Soup's format (decision 63): one commit, made only by the machine that
// holds the merge queue lease, so two laptops never migrate at once. The lease is the one merging uses
// (src/orchestrator/mergeQueue.ts, `refs/scopesoup/merge-queue` on the remote); it is taken for the migration alone, at any level,
// and let go right after. A meta branch that is not shared (no remote) needs no lease, and neither does a project that
// switched the lease off (SCOPESOUP_MERGE_QUEUE=off: one machine only).

import { META_FORMAT, writeProblem } from "./format.ts";
import type { MigrationResult, Writer } from "./writer.ts";

/** The part of the merge queue lease (src/orchestrator/mergeQueue.ts) the migration uses. */
export interface MigrationLease {
  acquire(at: string, minutes: number): Promise<{ held: true; until: string } | { held: false; why: string }>;
  release(at: string): Promise<void>;
  peek(at: string): Promise<{ holder: string } | null>;
}

export interface MigrateOptions {
  writer: Writer;
  /** The merge queue lease; null when there is none (SCOPESOUP_MERGE_QUEUE=off). Not used when the meta branch has no remote. */
  lease: MigrationLease | null;
  /** This machine's name, as the lease names its holder. */
  machine: string;
  now: () => string;
  /** How long the lease is taken for. Default 10 minutes: one commit and one push (whose time limit is 5 minutes). */
  leaseMinutes?: number;
}

/** What one try did: the writer's result, or why it waits for the lease. */
export type MetaMigration = MigrationResult | { state: "lease"; why: string };

/**
 * One try. Reads the local meta ref's format first (no fetch, no lease): only an older one goes on. Then the lease, then
 * the writer's migration, which fetches and checks the format again on top of the remote's before it commits.
 */
export async function migrateMetaFormat(options: MigrateOptions): Promise<MetaMigration> {
  const { writer, machine, now } = options;
  const found = await writer.format();
  if (found === null) return { state: "empty" };
  if (!found.ok) return { state: "unreadable", why: writeProblem(found) as string };
  if (found.format > META_FORMAT) return { state: "newer", why: writeProblem(found) as string };
  if (found.format === META_FORMAT) return { state: "current" };
  const lease = (await writer.shares()) ? options.lease : null;
  if (lease === null) return writer.migrate();
  // This machine merges now: the lease is that merge's, and letting it go after the migration would end its hold.
  if ((await lease.peek(now()))?.holder === machine) return { state: "lease", why: "this machine holds the merge queue lease for a merge; the migration waits until it is let go" };
  const taken = await lease.acquire(now(), options.leaseMinutes ?? 10);
  if (!taken.held) return { state: "lease", why: `the migration waits for the merge queue lease: ${taken.why}` };
  try {
    return await writer.migrate();
  } finally {
    await lease.release(now());
  }
}

/** One line for the console and the event log about a try, or null when there is nothing to say. */
export function describeMigration(result: MetaMigration): string | null {
  switch (result.state) {
    case "migrated":
      return `The meta branch was migrated from format ${result.from} to format ${result.to} in commit ${result.commit.slice(0, 12)}${result.sharing.state === "pending" ? `; it is not on the remote yet: ${result.sharing.problem ?? "it goes with the next push"}` : ""}.`;
    case "newer":
    case "unreadable":
      return result.why;
    case "waiting":
    case "lease":
      return `The meta branch is an older format than this Scope Soup's (${META_FORMAT}); ${result.why}. It is tried again.`;
    default:
      return null;
  }
}
