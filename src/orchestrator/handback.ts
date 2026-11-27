// A person's hand-back (docs/PEOPLE.md): the work is on a branch and the cycle goes on with review,
// check and merging, as for an agent's change. The item command writes the signal; this reads it.
//   metaBranch: a `revision` line by a person with `handback: true` (and the hold released after it).
//   GitHub:  an open pull request labelled `scopesoup:review` that names the item.
//   Jira:    Scope Soup's hand-back comment by a person (`WorkItem.handedBack`) that no `revision` line has adopted yet. It must
//            name the Item's own branch and that branch's head here; taking it on writes a `revision` line naming the comment.
// Each hand-back is taken on once per store. The job it makes stands where an implement session
// would have left it: built, with the branch and its head. Nothing here starts a session.

import { HANDBACK_LABEL, holdStands } from "../model/people.ts";
import { roleOn } from "../store/control.ts";
import type { Change, Ref, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import type { Context } from "./context.ts";
import { errorText } from "./context.ts";
import { afterBuild } from "./cycle.ts";
import type { Job } from "./jobs.ts";
import { workBranch, workspaceKey, BRANCH_PREFIX } from "./paths.ts";
import { atStep, sessionIdOf } from "./jobs.ts";

const SEEN_KEY = "orchestrator.handbacks";

export interface Handback {
  /** What makes it once-only: the item and the commit on the meta branch, the pull request on GitHub, the comment on Jira. */
  key: string;
  item: WorkItem;
  branch: string;
  sha: string;
  /** The person, in words. */
  by: string;
  note?: string;
  change?: Ref;
  /** Jira: the hand-back comment's id. */
  comment?: string;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const open = (item: WorkItem): boolean => item.state !== "done" && item.state !== "abandoned";

/** Pure. The hand-backs the items' logs and the changes show. */
export function findHandbacks(items: readonly WorkItem[], changes: readonly Change[]): Handback[] {
  const found: Handback[] = [];
  const byKey = new Map(items.map((item) => [refKey(item.ref), item]));
  for (const item of items) {
    if (!open(item)) continue;
    // Jira: only a hand-back of the Item's own branch (the host checks it too).
    const handed = item.handedBack;
    if (handed) {
      if (handed.branch === workBranch(item.ref)) found.push({ key: `${refKey(item.ref)}@comment:${handed.id}`, item, branch: handed.branch, sha: handed.sha, by: handed.by.name, comment: handed.id, ...(handed.note ? { note: handed.note } : {}) });
      continue;
    }
    // The newest revision of the log, and only when a person wrote it as a hand-back: Scope Soup's own later work supersedes it.
    const newest = [...(item.log ?? [])].reverse().find((line) => line.kind === "revision");
    if (!newest || newest.by.agent || newest.fields.handback !== true) continue;
    const sha = str(newest.fields.sha);
    const branch = str(newest.fields.branch);
    if (!sha || !branch) continue;
    const note = str(newest.fields.note);
    found.push({ key: `${refKey(item.ref)}@${sha}`, item, branch, sha, by: newest.by.machine ? `${newest.by.who} on ${newest.by.machine}` : newest.by.who, ...(note ? { note } : {}) });
  }
  for (const change of changes) {
    if (change.state !== "open" || !(change.labels ?? []).includes(HANDBACK_LABEL) || !change.branch) continue;
    const item = change.works.map((work) => byKey.get(refKey(work))).find((each) => each !== undefined && each.ref.host === change.ref.host);
    const sha = change.revisions?.[change.revisions.length - 1]?.sha;
    if (!item || !open(item) || !sha) continue;
    found.push({ key: `${refKey(change.ref)}`, item, branch: change.branch, sha, by: change.author.name, change: change.ref });
  }
  return found;
}

function seenKeys(ctx: Context): Set<string> {
  try {
    const value: unknown = JSON.parse(ctx.deps.store.getValue(SEEN_KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : []);
  } catch {
    return new Set();
  }
}

/**
 * Takes on the hand-backs not seen yet: a job at the end of implement, then the next step of the
 * cycle (the review from level 3, else the hand-over).
 * Waits when the item is still held (the person has not released it, or an agent of another machine took
 * it), when a session runs on it, when the role of its next step is not started (review from level 3, else implementors: paused, Stop, start-up) or the level is below 2 (Implement), and when the branch is not here.
 * Returns the items whose hand-back still waits: the tick does not start them as new items meanwhile.
 */
export async function adoptHandbacks(ctx: Context, items: readonly WorkItem[], changes: readonly Change[]): Promise<Set<string>> {
  const pending = new Set<string>();
  const candidates = findHandbacks(items, changes);
  if (candidates.length === 0) return pending;
  const { store, runner, actions } = ctx.deps;
  const seen = seenKeys(ctx);
  const fresh = candidates.filter((candidate) => !seen.has(candidate.key));
  for (const handed of fresh) pending.add(refKey(handed.item.ref));
  if (fresh.length === 0) return pending;
  if (ctx.config.level < 2 || !roleOn(store, ctx.config.level >= 3 ? "review" : "implement")) return pending;
  for (const handed of fresh) {
    const { item } = handed;
    const key = refKey(item.ref);
    const holder = item.holder;
    const held = holdStands(holder, Date.parse(ctx.at));
    if (held && holder?.actor.id !== actions.claimant) continue;
    if (sessionIdOf(ctx.jobs[key])) continue;
    // Jira: a job of the Item already stands, so this hand-back is not taken on over it (nor replayed).
    if (handed.comment && ctx.jobs[key]) continue;
    if (!handed.branch.startsWith(BRANCH_PREFIX) || handed.branch === BRANCH_PREFIX) {
      ctx.say("orchestrator.handback_refused", `The hand-back of ${item.ref.id} names the branch ${handed.branch}, which is not an item branch (${BRANCH_PREFIX}...). Scope Soup does not review it.`, key);
      pending.delete(key);
      continue;
    }
    // The branch must be here, in the repository Scope Soup works from: a hand-back from a clone Scope Soup cannot see waits.
    let head = handed.sha;
    if (runner.head) {
      try {
        head = await runner.head(handed.branch);
      } catch (error) {
        ctx.say("orchestrator.handback_waits", `The hand-back of ${item.ref.id} waits: ${errorText(error)}`, key);
        continue;
      }
    }
    // Jira: the comment names a commit; the branch here must be at exactly that one. Until a hand-back that is, the Item waits.
    if (handed.comment && head !== handed.sha) {
      ctx.say("orchestrator.handback_refused", `The hand-back of ${item.ref.id} names ${handed.sha.slice(0, 9)}, but ${handed.branch} is at ${head.slice(0, 9)} here. Scope Soup does not review it, nor start the Item over it; hand it back again.`, key);
      continue;
    }
    ctx.forget("orchestrator.handback_waits", key);
    const job: Job = {
      item: item.ref, workspace: workspaceKey(item.ref), branch: handed.branch || workBranch(item.ref),
      at: atStep("implement"), failures: 0, fixRounds: 0, startedAt: ctx.at, head,
      implement: {
        done: true,
        summary: `Handed back by ${handed.by}${handed.note ? `: ${handed.note}` : "."}`,
      },
    };
    ctx.jobs[key] = job;
    seen.add(handed.key);
    pending.delete(key);
    store.setValue(SEEN_KEY, JSON.stringify([...seen]));
    ctx.commit("orchestrator.handback", `${handed.by} handed ${item.ref.id} back on ${handed.branch} (${head.slice(0, 9)}). The cycle goes on from the review.`, key, { branch: handed.branch, head });
    // Jira: the revision line names the comment it took on, which supersedes it (and every earlier one) on any machine.
    if (handed.comment) await ctx.act("write the hand-back's revision to the item's log", key, () => actions.appendLog(item.ref, "revision", { sha: head, branch: handed.branch, handback: handed.comment }));
    await ctx.act("continue the cycle after a hand-back", key, () => afterBuild(ctx, job, item));
  }
  return pending;
}
