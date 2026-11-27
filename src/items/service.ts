// The item commands (docs/PEOPLE.md, "Claiming and handing back"): file, claim, hand back, release, list.
// One set of rules over the host ports, used by the command line (directly on the meta ref or on
// GitHub) and by the server's endpoints (meta branch, when the server is up). It writes through the
// existing writers: a `claimed`, `revision` and `released` line on the meta branch, an assignee, a pull
// request and a label on GitHub, an assignee and a hand-back comment on Jira. A refusal is a `Refused` with the reason in words.

import { FROM_CLAUDE_CODE, HANDBACK_LABEL, holdStands, PERSON_HOLD_YEARS } from "../model/people.ts";
import { isPriority, PRIORITIES } from "../model/priority.ts";
import type { Priority, Ref, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import { inertText } from "../orchestrator/hostText.ts";
import { workBranch } from "../orchestrator/paths.ts";
import type { WorkPort, WriteOutcome, WritePort } from "../ports/host.ts";
import type { RemoteBranches } from "./remoteBranch.ts";

export { FROM_CLAUDE_CODE, HANDBACK_LABEL };

/** Why a command did nothing. The text is for the person at the terminal. */
export class Refused extends Error {}

export interface Backend {
  kind: "metaBranch" | "github" | "jira";
  /** The host id in refs. */
  host: string;
  /** Meta branch: this machine's name; a person's claim is `name@machine`. */
  machine?: string;
  /** The person: the name given or read from the config or git (meta branch), the token's login (GitHub), the token's account (Jira: Cloud's account id, Data Center's user name). */
  who: string;
  /** The person as people read them, when `who` is an id (Jira's display name). */
  name?: string;
  /** Jira: the agent whose live claim stands on the issue (`scopesoup.claim`), whoever wrote it; nothing when none does. */
  agentClaim?: (ref: Ref) => Promise<string | undefined>;
  /** Jira: waits the agents' claim settle time, so a claim written just before an assignee showed can be seen. */
  settle?: () => Promise<void>;
  /**
   * Jira: the writes go through another account's token (the server's, for the board's picked person), so the host does not say
   * who acted: a hand-back's comment and property name the person, and a release always leaves a comment that names them.
   */
  onBehalf?: boolean;
  work: WorkPort;
  write: WritePort;
  now: () => Date;
  /** The branch changes go to; a hand-back's pull request targets it. */
  mainBranch: string;
  /** The project's remote, where a hand-back reads the Item's branch. Without it nothing can be handed back. */
  branches?: RemoteBranches;
}

export interface Row {
  id: string;
  ref: string;
  title: string;
  state: string;
  priority?: Priority;
  /** Who holds it, in words; absent when nobody does. */
  holder?: string;
  holderKind?: "person" | "agent";
  mine: boolean;
  /** A hold whose clock has run out (an agent's): it counts as free. */
  free: boolean;
  /** Nobody holds it but it has a change (a person handed it back, or an agent built it): it is on its way through review and merging, not free. */
  inReview?: boolean;
}

const open = (item: WorkItem): boolean => item.state !== "done" && item.state !== "abandoned";

/** The id as the user typed it (`A-3`, `#12`, `12`, or a ref key) on this backend's host. */
export function itemRef(backend: Pick<Backend, "kind" | "host">, name: string): Ref {
  const prefix = `${backend.host}:work:`;
  let id = name.trim();
  if (id.startsWith(prefix)) id = id.slice(prefix.length);
  if (backend.kind === "github") id = id.replace(/^#/, "");
  if (id === "" || /[\s/\\]/.test(id)) throw new Refused(`"${name}" is not an item id.`);
  if (backend.kind === "github" && !/^\d+$/.test(id)) throw new Refused(`"${name}" is not an issue number.`);
  if (backend.kind === "jira") {
    if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(id)) throw new Refused(`"${name}" is not a Jira issue key (DEMO-12).`);
    id = id.toUpperCase();
  }
  return { host: backend.host, kind: "work", id };
}

/** The hold is this person's, whatever machine wrote it: a person is not tied to a machine (only agents are). */
const isMe = (backend: Who, item: WorkItem): boolean => {
  const actor = item.holder?.actor;
  if (!actor || actor.bot) return false;
  const at = actor.id.lastIndexOf("@");
  return (backend.kind === "metaBranch" && at > 0 ? actor.id.slice(0, at) : actor.id) === backend.who;
};

/** Who acts: enough of a backend to say whether a hold is theirs. */
type Who = Pick<Backend, "kind" | "who" | "name">;

/** The person in words. */
const shown = (backend: Who): string => backend.name ?? backend.who;

/** A hold counts while it has no end (an assignee), it is a person's (no stall timer), or its end is ahead. */
const live = (item: WorkItem, now: Date): boolean => holdStands(item.holder, now.getTime());

async function fetchItem(backend: Backend, ref: Ref): Promise<WorkItem> {
  const item = await backend.work.getWork(ref);
  if (!item) throw new Refused(`There is no item ${ref.id} on ${backend.host}.`);
  return item;
}

const wording = (item: WorkItem): string => `${item.ref.id} "${item.title}"`;

/** The command a refusal suggests, for the person at the terminal; the board has buttons instead and leaves it out. */
const hint = (board: boolean, command: string): string => (board ? "" : `: ${command}`);

/** Whether this person holds the item now. */
export const holdsIt = (backend: Who, item: WorkItem, now: Date): boolean => isMe(backend, item) && live(item, now);

const agentWorking = (item: WorkItem, name: string): string => `${wording(item)} is held by ${name}, an agent that is working on it. Claim does not take it from the agent: wait for it, or pick a state for it on its board (Backlog, for one) to interrupt the agent.`;

/**
 * Why this person cannot claim the item now; nothing when they can (or hold it already). The same words refuse `item claim`
 * and explain a board's Claim button that cannot be pressed (`board`: without the command-line hints).
 */
export function whyNotClaim(backend: Who, item: WorkItem, now: Date, board = false): string | undefined {
  if (!open(item)) return `${wording(item)} is ${item.state}.`;
  if (!item.holder || !live(item, now) || isMe(backend, item)) return undefined;
  const who = item.holder.actor;
  if (who.bot) return agentWorking(item, who.name);
  return `${wording(item)} is held by ${who.name}. Ask them, or release it first (anyone may)${hint(board, `item release ${item.ref.id}`)}${board ? "." : ""}`;
}

/** Why this person cannot hand the item back now; nothing when they can. Only the holder hands an item back. */
export function whyNotHandBack(backend: Who, item: WorkItem, now: Date, board = false): string | undefined {
  if (!open(item)) return `${wording(item)} is ${item.state}.`;
  if (holdsIt(backend, item, now)) return undefined;
  if (item.holder && live(item, now)) return `${wording(item)} is held by ${item.holder.actor.name}${item.holder.actor.bot ? " (an agent)" : ""}, not by ${shown(backend)}. Only the holder hands an item back.`;
  return `${wording(item)} is not held by anyone. Claim it first${hint(board, `item claim ${item.ref.id}`)}${board ? "." : ""}`;
}

/** Why this person cannot release the item's hold; nothing when they can. Anyone releases a person's hold, nobody an agent's. */
export function whyNotRelease(item: WorkItem, now: Date): string | undefined {
  const holder = item.holder;
  if (!holder || !live(item, now)) return `${wording(item)} is not held by anyone.`;
  if (holder.actor.bot) return agentWorking(item, holder.actor.name);
  return undefined;
}

const refuse = (why: string | undefined): void => {
  if (why !== undefined) throw new Refused(why);
};

export function farUntil(now: Date): string {
  const end = new Date(now.getTime());
  end.setUTCFullYear(end.getUTCFullYear() + PERSON_HOLD_YEARS);
  return end.toISOString();
}

const byPerson = (backend: Backend) => ({ who: backend.who, agent: false });

// --- new ---

export interface NewItem {
  title: string;
  body?: string;
  priority?: string;
  labels?: string[];
  /** Straight to To do (decision 120); otherwise it lands in Backlog, unless the person claims it (then they chose it). */
  todo?: boolean;
  /** The person holds the item from the start: one write, so Scope Soup cannot pick it up in between. */
  claim?: boolean;
  /** With `claim`: where the hold came from (`claude-code`). */
  from?: string;
}

export async function createItem(backend: Backend, input: NewItem): Promise<{ ref: Ref; shared: WriteOutcome["shared"]; message: string }> {
  if (!backend.write.createWork) throw new Refused(`Items cannot be filed on ${backend.host}: it is read-only here.`);
  const title = input.title.trim();
  if (title === "") throw new Refused("Give the item a title (--title).");
  if (input.priority !== undefined && input.priority !== "" && !isPriority(input.priority)) throw new Refused(`The priority must be one of ${PRIORITIES.join(", ")}.`);
  const priority = input.priority ? (input.priority as Priority) : undefined;
  // On Jira the text goes out inert, as Scope Soup's other writes there: no mention, no closing keyword.
  const jira = backend.kind === "jira";
  const done = await backend.write.createWork({
    title: jira ? inertText(title) : title,
    ...(input.body?.trim() ? { body: jira ? inertText(input.body) : input.body } : {}),
    ...(input.labels && input.labels.length > 0 ? { labels: input.labels } : {}),
    ...(priority && backend.kind !== "github" ? { priority } : {}),
    lane: input.todo || input.claim ? "todo" : "backlog",
    // metaBranch: the item and its first lines (`created`, and the person's `claimed`) are one commit. GitHub: the assignee is part of the create call.
    ...(backend.kind === "metaBranch"
      ? {
        log: [
          { kind: "created", by: byPerson(backend) },
          ...(input.claim ? [{ kind: "claimed", by: byPerson(backend), fields: { until: farUntil(backend.now()), ...(input.from ? { from: input.from } : {}) } }] : []),
        ],
      }
      : input.claim ? { assignees: [backend.who] } : {}),
  });
  const notes: string[] = [];
  if (input.claim) notes.push(`${shown(backend)} holds it; Scope Soup will not start it`);
  if (priority && backend.kind === "github") notes.push("GitHub has no priority field; it was not kept (add a label if you want one)");
  if (done.shared === "pending") notes.push(`not shared yet${done.problem ? ` (${done.problem})` : ""}; it goes with the next round`);
  return { ref: done.work, shared: done.shared, message: `Filed ${done.work.id}: ${title}${notes.length > 0 ? `. Note: ${notes.join("; ")}` : ""}` };
}

// --- claim ---

export interface ClaimOptions {
  /** Where the hold came from (`claude-code`), written in the claim. */
  from?: string;
}

export async function claimItem(backend: Backend, name: string, options: ClaimOptions = {}): Promise<{ ref: Ref; shared: WriteOutcome["shared"]; message: string }> {
  const ref = itemRef(backend, name);
  const now = backend.now();
  const item = await fetchItem(backend, ref);
  refuse(whyNotClaim(backend, item, now));
  if (backend.kind === "github") {
    if (!backend.write.setAssignees) throw new Refused(`Items cannot be taken on ${backend.host}: it is read-only here.`);
    if (isMe(backend, item)) return { ref, shared: "shared", message: `${wording(item)} is already yours.` };
    await backend.write.setAssignees(ref, [backend.who], []);
    return { ref, shared: "shared", message: `${backend.who} holds ${wording(item)} (assigned on GitHub). Scope Soup will not start it.` };
  }
  if (backend.kind === "jira") {
    if (!backend.write.setAssignees) throw new Refused(`Items cannot be taken on ${backend.host}: it is read-only here.`);
    if (isMe(backend, item)) return { ref, shared: "shared", message: `${wording(item)} is already yours.` };
    await backend.write.setAssignees(ref, [backend.who], []);
    // An agent's claim checks for an assignee before it writes; one written meanwhile stands, and the assignee is taken off again.
    await backend.settle?.();
    const agent = await backend.agentClaim?.(ref);
    if (agent) {
      await backend.write.setAssignees(ref, [], [backend.who]);
      throw new Refused(`${wording(item)} was taken by ${agent} first, an agent that is working on it. It is not yours.`);
    }
    return { ref, shared: "shared", message: `${shown(backend)} holds ${wording(item)} (assigned on Jira). Scope Soup will not start it.` };
  }
  if (!backend.write.appendLog) throw new Refused(`Items cannot be taken on ${backend.host}: it is read-only here.`);
  if (isMe(backend, item) && live(item, now)) return { ref, shared: "shared", message: `${wording(item)} is already yours.` };
  const outcome = await backend.write.appendLog(ref, { kind: "claimed", by: byPerson(backend), fields: { until: farUntil(now), ...(options.from ? { from: options.from } : {}) } });
  // The fold of the log says whose claim stands: the earliest does.
  const after = await backend.work.getWork(ref);
  if (after?.holder && !isMe(backend, after)) throw new Refused(`${wording(item)} was taken by ${after.holder.actor.name} first. It is theirs.`);
  const warn = outcome.shared === "pending" ? ` Not shared with the other machines yet${outcome.problem ? ` (${outcome.problem})` : ""}: until it is, another machine can still start the item.` : "";
  return { ref, shared: outcome.shared, message: `${backend.who} holds ${wording(item)}. Scope Soup will not start it.${warn}` };
}

// --- hand back ---

/**
 * A hand-back names nothing but the Item: its branch is fixed (`scopesoup/<item>`, `workBranch`), and Scope Soup reads the
 * branch's tip from the remote itself, after a fetch. The note is for the reviewer.
 */
export interface HandBack {
  note?: string;
}

/** The commands a person copies to work on an Item's branch: start it from the main branch, or switch to it when it is on the remote; then push. */
export function branchCommands(branch: string, remote: string, mainBranch: string): { start: string; resume: string; push: string } {
  return {
    start: `git fetch ${remote} && git switch -c ${branch} ${remote}/${mainBranch}`,
    resume: `git fetch ${remote} && git switch ${branch}`,
    push: `git push ${remote} ${branch}`,
  };
}

/** The tip of the Item's branch on the remote, after a fetch; or a refusal that says why it cannot be handed back. */
async function remoteTip(backend: Backend, branch: string): Promise<string> {
  const remote = backend.branches;
  if (!remote) throw new Refused(`Scope Soup cannot read the project's remote here, so it cannot read ${branch} to hand it back.`);
  const { remote: name, mainBranch } = remote.names();
  let found;
  try {
    found = await remote.fetch(branch);
  } catch (error) {
    throw new Refused(`${branch} could not be read: ${error instanceof Error ? error.message : String(error)}.`);
  }
  if (found.state === "missing") throw new Refused(`${branch} is not on ${name}. Push it with "${branchCommands(branch, name, mainBranch).push}", then hand back.`);
  if (found.state === "empty") throw new Refused(`${branch} on ${name} has no commits beyond ${mainBranch}: there is nothing to hand back. Commit the work and push it, then hand back.`);
  return found.sha;
}

export async function handBackItem(backend: Backend, name: string, input: HandBack = {}): Promise<{ ref: Ref; change?: Ref; shared: WriteOutcome["shared"]; message: string }> {
  const ref = itemRef(backend, name);
  const now = backend.now();
  const item = await fetchItem(backend, ref);
  refuse(whyNotHandBack(backend, item, now));
  const branch = workBranch(ref);
  const sha = await remoteTip(backend, branch);
  const note = input.note?.trim();
  if (backend.kind === "github") {
    const { write } = backend;
    if (!write.openChange || !write.setLabels || !write.setAssignees) throw new Refused(`Items cannot be handed back on ${backend.host}: it is read-only here.`);
    const body = `${note ? `${note}\n\n` : ""}Handed back by ${backend.who} for Scope Soup's review.\n\nCloses #${ref.id}`;
    const change = await write.openChange({ branch: branch, target: backend.mainBranch, title: item.title, body });
    await write.setLabels(change, [HANDBACK_LABEL], []);
    await write.setAssignees(ref, [], [backend.who]);
    return { ref, change, shared: "shared", message: `Handed back ${wording(item)}: pull request #${change.id} from ${branch}, labelled ${HANDBACK_LABEL}. Scope Soup reviews it next.` };
  }
  if (backend.kind === "jira") {
    const { write } = backend;
    if (!write.recordHandback || !write.setAssignees) throw new Refused(`Items cannot be handed back on ${backend.host}: it is read-only here.`);
    // The hand-back comment first: until the assignee is taken off, nothing adopts it.
    await write.recordHandback(ref, { sha, branch, ...(note ? { note: inertText(note) } : {}), ...(backend.onBehalf ? { person: { id: backend.who, name: inertText(shown(backend)) } } : {}) });
    await write.setAssignees(ref, [], [backend.who]);
    return { ref, shared: "shared", message: `Handed back ${wording(item)} on ${branch} (${sha.slice(0, 9)}), with a comment on Jira, and unassigned. Scope Soup reviews it next, then checks and merges it.` };
  }
  const { write } = backend;
  if (!write.appendLog) throw new Refused(`Items cannot be handed back on ${backend.host}: it is read-only here.`);
  // The revision first: until the hold is released nothing reads it. Written again, it is the same revision.
  await write.appendLog(ref, { kind: "revision", by: byPerson(backend), fields: { sha, branch, handback: true, ...(note ? { note } : {}) } });
  const released = await write.appendLog(ref, { kind: "released", by: byPerson(backend), fields: { reason: `handed back on ${branch}${note ? `: ${note}` : ""}` } });
  const warn = released.shared === "pending" ? ` Not shared with the other machines yet${released.problem ? ` (${released.problem})` : ""}.` : "";
  return { ref, shared: released.shared, message: `Handed back ${wording(item)} on ${branch} (${sha.slice(0, 9)}). Scope Soup reviews it next, then checks and merges it.${warn}` };
}

// --- release ---

/**
 * Lets go of an item's hold. People are equals and trust each other, so anyone releases anyone's hold, and the log says
 * who released whose (`of` on the `released` line; a comment on GitHub). An agent's claim is not a person's to end: Scope Soup
 * stops nothing that runs, and the claim ends by itself at its `until`.
 */
export async function releaseItem(backend: Backend, name: string, note?: string): Promise<{ ref: Ref; shared: WriteOutcome["shared"]; message: string }> {
  const ref = itemRef(backend, name);
  const now = backend.now();
  const item = await fetchItem(backend, ref);
  refuse(whyNotRelease(item, now));
  const holder = item.holder!;
  const mine = isMe(backend, item);
  const whose = mine ? "" : `${holder.actor.name}'s hold on `;
  const text = note?.trim();
  if (backend.kind === "github" || backend.kind === "jira") {
    if (!backend.write.setAssignees) throw new Refused(`Items cannot be released on ${backend.host}: it is read-only here.`);
    await backend.write.setAssignees(ref, [], [mine ? backend.who : holder.actor.id]);
    const jira = backend.kind === "jira";
    // Jira names people by account id: the comment names them as people read them, and the text goes out inert.
    const said = `Released by ${shown(backend)}${mine ? "" : `, held by ${jira ? holder.actor.name : holder.actor.id}`}${text ? `: ${text}` : "."}`;
    if ((text || !mine || backend.onBehalf) && backend.write.comment) await backend.write.comment(ref, jira ? inertText(said) : said);
    // Jira: an agent's claim may stand beside the assignee; then no agent picks it up, that one has it.
    const agent = jira ? await backend.agentClaim?.(ref) : undefined;
    return { ref, shared: "shared", message: `${shown(backend)} released ${whose}${wording(item)} (unassigned). ${agent ? `${agent}, an agent, holds a claim on it.` : "An agent may pick it up."}` };
  }
  if (!backend.write.appendLog) throw new Refused(`Items cannot be released on ${backend.host}: it is read-only here.`);
  const outcome = await backend.write.appendLog(ref, { kind: "released", by: byPerson(backend), fields: { reason: text || (mine ? "released by the person who held it" : `released by ${backend.who}, held by ${holder.actor.name}`), ...(mine ? {} : { of: holder.actor.id }) } });
  return { ref, shared: outcome.shared, message: `${backend.who} released ${whose}${wording(item)}. An agent may pick it up.${outcome.shared === "pending" ? " Not shared with the other machines yet." : ""}` };
}

// --- list ---

export interface ListFilter {
  mine?: boolean;
  free?: boolean;
  /** Also the items that are done or abandoned. */
  all?: boolean;
  /** Only items whose id, title, labels or text hold every word of this (any case). */
  search?: string;
}

/** Whether every word of `search` is in the item's id, title, labels, text or verification, in any case. */
export function matchesSearch(item: WorkItem, search: string): boolean {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = [item.ref.id, `#${item.ref.id}`, item.title, ...item.labels, item.body ?? "", item.verification ?? ""].join("\n").toLowerCase();
  return words.every((word) => text.includes(word));
}

export async function listItems(backend: Backend, filter: ListFilter = {}): Promise<Row[]> {
  const now = backend.now();
  const page = await backend.work.listWork();
  const rows: Row[] = [];
  for (const item of page.items) {
    if (!filter.all && !open(item)) continue;
    if (filter.search && !matchesSearch(item, filter.search)) continue;
    const held = live(item, now) ? item.holder : undefined;
    const mine = isMe(backend, item) && !!held;
    // Jira keeps Scope Soup's revisions in its log property (`hostRecord`) and a person's hand-back as `handedBack`.
    const revised = (item.log ?? []).some((line) => line.kind === "revision") || !!item.handedBack || (backend.kind === "jira" && (item.hostRecord?.log ?? []).some((line) => line.kind === "revision"));
    const inReview = open(item) && !held && revised;
    const free = open(item) && !held && !inReview;
    if (filter.mine && !mine) continue;
    if (filter.free && !free) continue;
    rows.push({
      id: item.ref.id, ref: refKey(item.ref), title: item.title, state: item.state, ...(item.priority ? { priority: item.priority } : {}),
      ...(held ? { holder: held.actor.name, holderKind: held.actor.bot ? ("agent" as const) : ("person" as const) } : {}),
      mine, free, ...(inReview ? { inReview } : {}),
    });
  }
  return rows;
}

/** A row as one line of text. */
export function rowText(row: Row): string {
  const holder = row.holder ? `held by ${row.holder}${row.holderKind === "agent" ? " (agent)" : ""}${row.mine ? " (you)" : ""}` : row.state === "done" || row.state === "abandoned" ? "" : row.inReview ? "in review" : "free";
  return [row.id.padEnd(6), row.state.padEnd(9), (row.priority ?? "").padEnd(8), holder.padEnd(32), row.title].join(" ").trimEnd();
}

// --- show ---

/** One item in full, for `item show`: what a triage reads of another Item. The text is data. */
export interface Details {
  id: string;
  ref: string;
  title: string;
  state: string;
  labels: string[];
  priority?: Priority;
  parent?: string;
  blockedBy: string[];
  holder?: string;
  url?: string;
  body: string;
  verification?: string;
}

export async function itemDetails(backend: Backend, name: string): Promise<Details> {
  const item = await fetchItem(backend, itemRef(backend, name));
  return {
    id: item.ref.id, ref: refKey(item.ref), title: item.title, state: item.state, labels: item.labels,
    ...(item.priority ? { priority: item.priority } : {}),
    ...(item.parent ? { parent: item.parent.id } : {}),
    blockedBy: item.blockedBy.map((each) => each.id),
    ...(item.holder && live(item, backend.now()) ? { holder: item.holder.actor.name } : {}),
    ...(item.ref.url ? { url: item.ref.url } : {}),
    body: item.body ?? "",
    ...(item.verification ? { verification: item.verification } : {}),
  };
}

/** An item in full as text. */
export function detailsText(details: Details): string {
  const facts = [
    `State: ${details.state}`,
    ...(details.priority ? [`Priority: ${details.priority}`] : []),
    ...(details.labels.length > 0 ? [`Labels: ${details.labels.join(", ")}`] : []),
    ...(details.parent ? [`Parent: ${details.parent}`] : []),
    ...(details.blockedBy.length > 0 ? [`Blocked by: ${details.blockedBy.join(", ")}`] : []),
    ...(details.holder ? [`Held by: ${details.holder}`] : []),
    ...(details.url ? [`Link: ${details.url}`] : []),
  ];
  return [`${details.id} ${details.title}`, ...facts, "", details.body.trim() || "(no description)", ...(details.verification ? ["", `Verification: ${details.verification}`] : [])].join("\n");
}
