// The main branch only moves forward ("Enforced in code instead of prose"). From level 2 a session
// may push to the main branch itself, so after every session Scope Soup fetches the remote's main and compares it with the commit
// it last saw there. A main that moved other than fast-forward (a force push, rewritten history) pauses the three agent roles
// (triage, implementors, review) with the reason and an event each, so the loop stops until a person has looked and resumes them.

import { refKey } from "../model/types.ts";
import { applyControl } from "../store/control.ts";
import type { Context } from "./context.ts";
import { errorText } from "./context.ts";
import type { Job } from "./jobs.ts";

/** JSON `{ [repository]: commit }`: where the remote's main was when Scope Soup last looked from each repository. */
export const MAIN_SEEN_KEY = "orchestrator.main_seen";

function readSeen(ctx: Context): Record<string, string> {
  try {
    const parsed = JSON.parse(ctx.deps.store.getValue(MAIN_SEEN_KEY) ?? "{}") as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/**
 * Fetches the remote's main from the repository that has the job's branch and checks that it moved only fast-forward since
 * Scope Soup last saw it there. `after` says when this is ("after the implement session for 12"). Returns the commit main is at
 * now, or null when it could not be read (said once as an event; nothing is paused for a fetch that failed).
 */
export async function watchMain(ctx: Context, job: Job, after: string): Promise<string | null> {
  const { runner, store } = ctx.deps;
  if (!runner.fetchMain) return null;
  const key = refKey(job.item);
  const name = `${ctx.config.remote}/${ctx.config.mainBranch}`;
  let repo: string;
  let main: string;
  try {
    ({ repo, main } = await runner.fetchMain(job.branch));
  } catch (error) {
    ctx.say("orchestrator.main_unread", `Could not read ${name} ${after}: ${errorText(error)}`, key);
    return null;
  }
  ctx.forget("orchestrator.main_unread", key);
  const seen = readSeen(ctx);
  const last = seen[repo];
  if (last === main) return main;
  let forward: boolean | null = true;
  if (last !== undefined) {
    try {
      forward = runner.contains ? await runner.contains(job.branch, last, main) : true;
    } catch (error) {
      ctx.say("orchestrator.main_unread", `Could not tell whether ${name} moved fast-forward ${after}: ${errorText(error)}`, key);
      return main;
    }
  }
  const record = (): void => store.setValue(MAIN_SEEN_KEY, JSON.stringify({ ...seen, [repo]: main }));
  if (forward === true) {
    store.tx(() => {
      record();
      ctx.commit(
        "orchestrator.main_moved",
        last === undefined ? `${name} is at ${main.slice(0, 7)} (triage from ${repo}).` : `${name} moved fast-forward from ${last.slice(0, 7)} to ${main.slice(0, 7)} ${after}.`,
        key, { from: last ?? null, to: main, repo },
      );
    });
    return main;
  }
  // Rewritten: the commit seen last is not in main's history any more (or is gone). The new main is recorded, so a person's
  // Resuming after looking is not undone by the same finding at the next session.
  const reason = `${name} did not move fast-forward ${after}: it was at ${last!.slice(0, 7)} and is now at ${main.slice(0, 7)}, which ${forward === null ? "is not built on it (that commit is no longer there)" : "does not contain it"}. Someone forced it or rewrote its history. Agents are paused (triage, implementors and review): look at ${name}, then press Resume on their lanes.`;
  store.tx(() => {
    record();
    ctx.commit("orchestrator.main_rewritten", reason, key, { from: last, to: main, repo });
    applyControl(store, "agents.pause", ctx.at, "main-guard", "scopesoup");
  });
  return main;
}
