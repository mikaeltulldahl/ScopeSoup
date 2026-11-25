// The project's activity for History: one row per thing that happened, newest first, built from what Scope Soup
// already records. The Items' logs are shared by every machine, so they come first: created, triage drafts accepted,
// questions and answers, holds, merges, and sessions run on any machine. This machine's store adds its own sessions (model,
// outcome, cost), the merge queue's batches, the switches, upgrades and drafts rejected; the settings' log adds who
// changed which setting. An event that an Item's log already records is not shown twice. Pure: the caller reads the
// sources and gives the time. Text from people and agents is data: quoted and cut short, never interpreted.

import type { Batch, Change, LogRecord, ScopeSoupEvent, Session, WorkItem } from "../model/types.ts";
import { asOptions, optionText, refKey } from "../model/types.ts";
import { type SettingChangeLike, settingsWords } from "./settingsWords.ts";
import type { ActivityItem, ActivityKind, ActivityRow, ActivityView, FoldedActivityRow } from "./views.ts";

/** One save of the shared settings, as their log has it. */
export interface SettingsSave {
  at: string;
  who: string;
  machine?: string;
  changes: SettingChangeLike[];
}

export interface ActivityInput {
  works: WorkItem[];
  changes: Change[];
  sessions: Session[];
  batches: Batch[];
  /** The store's events of `ACTIVITY_EVENTS` kinds, in any order. */
  events: ScopeSoupEvent[];
  settings: SettingsSave[];
}

const SWITCH_NAMES: Record<string, string> = { triage: "triage", implement: "the implementors", review: "review", merge_queue: "the merge queue" };

/** The store's event kinds the timeline reads. */
export const ACTIVITY_EVENTS: readonly string[] = [
  ...Object.keys(SWITCH_NAMES).flatMap((name) => [`control.${name}_started`, `control.${name}_paused`]),
  "control.stopped", "control.startup_paused", "control.paused", "control.resumed", "control.queue_resume", "orchestrator.queue_paused",
  "scopesoup.upgraded", "scopesoup.went_back", "scopesoup.upgrade_failed",
  "orchestrator.draft_accepted", "orchestrator.draft_edited", "orchestrator.draft_rejected", "orchestrator.draft_answered",
  "orchestrator.questions_asked", "person.answered", "person.claimed", "person.handed_back", "person.released", "orchestrator.merged", "config.changed", "media.deleted", "media.expired",
  "draft.created", "draft.updated",
];

/** Most rows in one view. */
export const MAX_ACTIVITY_ROWS = 2000;
/** A session's log line and its stored session are the same when they end this close together. */
const SAME_SESSION_MS = 2 * 60_000;

const ROLE_WHO: Record<string, string> = { triage: "triage", implement: "implementor", review: "reviewer" };
const clip = (text: string, max = 200): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const short = (sha: unknown): string => str(sha).slice(0, 7);
const capital = (text: string): string => (text ? text[0]!.toUpperCase() + text.slice(1) : text);
const modelName = (model: string | undefined): string => (model && /^[a-z]+$/.test(model) ? capital(model) : model ?? "");
const obj = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** "35 min", "1 h 20 min", "under a minute". */
export function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
}
const cost = (usd: number | undefined): string => (usd === undefined ? "" : `$${usd.toFixed(2)}`);

/** A session in words: "Session (Sonnet) done in 35 min, $1.42". */
function sessionText(input: { model?: string; outcome: string; ms?: number; usd?: number; chat?: boolean; running?: boolean }): string {
  const model = modelName(input.model);
  const head = input.chat ? `Chat reply${model ? ` (${model})` : ""}` : `Session${model ? ` (${model})` : ""}`;
  const tail = [input.ms !== undefined && input.ms > 0 ? `in ${duration(input.ms)}` : "", input.usd !== undefined ? `${cost(input.usd)}${input.running ? " so far" : ""}` : ""].filter(Boolean).join(", ");
  return `${head} ${input.outcome}${tail ? `${tail.startsWith("in ") ? " " : ", "}${tail}` : ""}`;
}

function storedOutcome(session: Session): { outcome: string; bad: boolean; running: boolean } {
  if (session.setupFailed) return { outcome: `did not start: the project's setup failed${session.setupOutcome ? ` (${session.setupOutcome})` : ""}`, bad: true, running: false };
  switch (session.status) {
    case "succeeded":
      return { outcome: "done", bad: false, running: false };
    case "failed":
      return { outcome: `failed${session.endReason ? `: ${session.endReason}` : ""}`, bad: true, running: false };
    case "cancelled":
      return { outcome: "cancelled", bad: false, running: false };
    case "limit":
      return { outcome: "stopped at the usage limit", bad: true, running: false };
    case "stalled":
      return { outcome: "stalled", bad: true, running: true };
    default:
      return { outcome: "started", bad: false, running: true };
  }
}

/** A log outcome word in the timeline's words. */
function logOutcome(outcome: string): { outcome: string; bad: boolean } {
  if (outcome === "succeeded" || outcome === "") return { outcome: "done", bad: false };
  if (outcome === "limit") return { outcome: "stopped at the usage limit", bad: true };
  if (outcome === "cancelled") return { outcome: "cancelled", bad: false };
  return { outcome: clip(outcome, 80), bad: outcome === "failed" || outcome.startsWith("failed") };
}

export function buildActivity(input: ActivityInput, now: string, limit = MAX_ACTIVITY_ROWS): ActivityView {
  const rows: ActivityRow[] = [];
  const works = new Map(input.works.map((work) => [refKey(work.ref), work]));
  const link = (key: string | undefined): ActivityItem[] => {
    if (!key) return [];
    const work = works.get(key);
    const id = work?.ref.id ?? key.split(":").pop() ?? key;
    return [{ key, id, ...(work ? { title: work.title } : { gone: true as const }) }];
  };
  const itemsOfChange = new Map(input.changes.map((change) => [refKey(change.ref), change.works.map(refKey)]));
  const add = (row: Omit<ActivityRow, "items"> & { items?: ActivityItem[] }) => rows.push({ items: [], ...row });

  // --- The Items' logs (shared by every machine) ---
  const logged = new Set<string>();
  /** Per Item and role, the ends of its sessions in the log, to know a stored session the log already has. */
  const loggedSessions: { key: string; role: string; at: number; id: string }[] = [];
  const summaries = new Map<string, string>();
  for (const work of input.works) {
    const key = refKey(work.ref);
    const log: LogRecord[] = work.log ?? work.hostRecord?.log ?? [];
    if (log.length > 0) logged.add(key);
    const items = link(key);
    let mergedLine = false;
    log.forEach((line, index) => {
      const id = `log:${key}:${index}`;
      const f = line.fields;
      const who = line.by.agent && line.by.who === "scopesoup" ? "Scope Soup" : line.by.who;
      const base = { id, at: line.at, who, agent: line.by.agent, items };
      switch (line.kind) {
        case "created":
          add({ ...base, kind: "item", text: "Created the Item" });
          break;
        case "edited": {
          const via = str(f.via);
          const round = /^triage, round (\d+)/.exec(via);
          if (round) add({ ...base, kind: "triage", text: `Accepted the triage's rewrite (round ${round[1]})`, tone: "good" });
          else {
            const changed = Array.isArray(f.changed) ? asOptions(f.changed).map(optionText).join(", ") : str(f.changed).trim().replace(/; /g, ", ");
            add({ ...base, kind: "item", text: `Edited the Item${changed ? `: ${clip(changed, 80)}` : ""}` });
          }
          break;
        }
        case "claimed":
          add({ ...base, kind: "item", text: "Took the Item" });
          break;
        case "released":
          add({ ...base, kind: "item", text: "Let the Item go", ...(str(f.reason) ? { detail: clip(str(f.reason)) } : {}) });
          break;
        case "question": {
          const proposal = obj(f.proposal);
          const parts = Array.isArray(proposal.parts) ? proposal.parts.length : 0;
          const text = parts > 0 ? `Proposed restructuring the Item into ${parts} parts` : `${typeof f.refine === "number" ? `The triage's rewrite (round ${f.refine}) asks` : "Asked"}: ${clip(str(f.question))}`;
          add({ ...base, kind: "question", text });
          break;
        }
        case "answer":
          add({ ...base, kind: "question", text: `Answered: ${clip(str(f.answer) || asOptions(f.answer).map(optionText).join("; "))}` });
          break;
        case "merged": {
          mergedLine = true;
          const batch = num(f.batch);
          add({ ...base, kind: "merge", text: `Merged ${short(f.sha)} to ${str(f.target) || "the main branch"}${batch !== undefined ? ` through the merge queue (batch ${batch})` : ", by the implementor"}`, tone: "good" });
          break;
        }
        case "session": {
          const role = str(f.role);
          const sessionId = str(f.sessionId);
          const summary = str(f.summary);
          if (sessionId && summary) summaries.set(sessionId, summary);
          loggedSessions.push({ key, role, at: Date.parse(line.at), id: sessionId });
          const { outcome, bad } = logOutcome(str(f.outcome));
          add({
            ...base, id, kind: "session", who: ROLE_WHO[role] ?? (role || "agent"), agent: true,
            text: sessionText({ model: str(f.model) || undefined, outcome, ms: num(f.durationMs), usd: num(f.costUsd) }),
            ...(summary ? { detail: clip(summary) } : {}), ...(bad ? { tone: "bad" as const } : {}),
            session: { role: role || "agent", ...(num(f.durationMs) !== undefined ? { ms: num(f.durationMs)! } : {}), ...(num(f.costUsd) !== undefined ? { usd: num(f.costUsd)! } : {}) },
          });
          break;
        }
        // Decisions come from the Item's `assumptions` (every host); revisions, reviews and checks are in the sessions and batches.
        default:
          break;
      }
    });
    // A host without a merged line in a log keeps a marker (GitHub).
    if (!mergedLine && work.merged && !work.merged.reopened) {
      const batch = work.merged.batch;
      add({ id: `merged:${key}`, at: work.merged.at, kind: "merge", who: "Scope Soup", agent: true, items, text: `Merged ${short(work.merged.sha)} to ${work.merged.target}${batch !== undefined ? ` through the merge queue (batch ${batch})` : ""}`, tone: "good" });
      logged.add(`merged:${key}`);
    }
    if (mergedLine) logged.add(`merged:${key}`);

    // The implementor's own decisions, one row per record and one per verdict given together.
    const recorded = new Map<string, NonNullable<WorkItem["assumptions"]>>();
    const settled = new Map<string, NonNullable<WorkItem["assumptions"]>>();
    for (const decision of work.assumptions ?? []) {
      recorded.set(decision.at, [...(recorded.get(decision.at) ?? []), decision]);
      if (decision.settled) {
        const group = `${decision.settled.at}|${decision.settled.by}|${decision.settled.verdict}`;
        settled.set(group, [...(settled.get(group) ?? []), decision]);
      }
    }
    for (const [at, list] of recorded) {
      add({
        id: `decided:${key}:${at}`, at, kind: "decision", who: "implementor", agent: true, items,
        text: list.length === 1 ? "Decided one question itself, cheap to change later" : `Decided ${list.length} questions itself, cheap to change later`,
        detail: clip(list.map((each) => `${each.question} ${each.chosen}`).join(" · "), 300),
      });
    }
    for (const [group, list] of settled) {
      const { at, by, verdict, item } = list[0]!.settled!;
      const n = list.length === 1 ? "a decision" : `${list.length} decisions`;
      const answers = list.map((each) => each.settled?.answer).filter((each): each is string => !!each);
      add({
        id: `settled:${key}:${group}`, at, kind: "decision", who: by, agent: false,
        items: [...items, ...(item ? link(refKey(item)) : [])],
        text: verdict === "accepted" ? `Accepted ${n} the implementor took itself` : `Overturned ${n} the implementor took itself`,
        ...(answers.length > 0 ? { detail: clip(answers.join(" · ")) } : {}),
        ...(verdict === "overturned" ? { tone: "bad" as const } : {}),
      });
    }
  }

  // --- This machine's sessions, unless the log already has them ---
  for (const session of input.sessions) {
    const key = refKey(session.subject);
    const end = Date.parse(session.finishedAt ?? session.startedAt);
    const inLog = loggedSessions.some((line) => line.id === session.ref.id || (line.key === key && line.role === session.role && Math.abs(line.at - end) <= SAME_SESSION_MS));
    if (inLog) continue;
    const { outcome, bad, running } = storedOutcome(session);
    const ms = session.finishedAt ? Date.parse(session.finishedAt) - Date.parse(session.startedAt) : undefined;
    const summary = summaries.get(session.ref.id);
    add({
      id: `session:${session.ref.id}`, at: running ? session.startedAt : session.finishedAt ?? session.startedAt, kind: "session",
      who: ROLE_WHO[session.role] ?? session.role, agent: true, items: link(key),
      text: sessionText({ model: session.model, outcome, ...(running ? {} : { ms }), usd: session.costUsd, chat: session.chat === true, running }),
      ...(summary ? { detail: clip(summary) } : {}), ...(bad ? { tone: "bad" as const } : {}),
      session: { role: session.role, ...(!running && ms !== undefined && ms > 0 ? { ms } : {}), ...(session.costUsd !== undefined ? { usd: session.costUsd } : {}) },
    });
  }

  // --- The merge queue's batches ---
  for (const batch of input.batches) {
    const itemOf = (change: string): ActivityItem[] => (itemsOfChange.get(change) ?? []).flatMap((key) => link(key));
    const members = batch.members.map((member) => ({ state: member.state, items: itemOf(refKey(member.change)) }));
    const all = members.flatMap((member) => member.items);
    const ids = (list: ActivityItem[]) => list.map((each) => `#${each.id}`).join(", ");
    const n = batch.members.length;
    const changes = `${n} change${n === 1 ? "" : "s"}`;
    const base = { id: `batch:${batch.ref.id}`, kind: "batch" as const, who: "merge queue", agent: true };
    if (batch.status === "merged") {
      add({ ...base, at: batch.finishedAt ?? batch.startedAt ?? now, items: all, text: `Batch ${batch.ref.id} merged ${changes}`, tone: "good" });
    } else if (batch.status === "failed") {
      const culprits = [...members.filter((member) => member.state === "culprit").flatMap((member) => member.items), ...(batch.suspect ? itemOf(refKey(batch.suspect)) : [])];
      const broke = culprits.filter((each, index) => culprits.findIndex((other) => other.key === each.key) === index);
      const merged = members.filter((member) => member.state === "merged").length;
      const back = members.filter((member) => member.state === "requeued").length;
      const tail = [merged > 0 ? `${merged} merged` : "", back > 0 ? `${back} back in the queue` : ""].filter(Boolean).join(", ");
      add({
        ...base, at: batch.finishedAt ?? batch.startedAt ?? now, items: [...broke, ...all.filter((each) => !broke.some((other) => other.key === each.key))],
        text: `Batch ${batch.ref.id} of ${changes} failed${broke.length > 0 ? `: ${ids(broke)} broke it` : ""}${tail ? `; ${tail}` : ""}`,
        ...(batch.note ? { detail: clip(batch.note) } : {}), tone: "bad",
      });
    } else if (batch.startedAt) {
      add({ ...base, at: batch.startedAt, items: all, text: `Batch ${batch.ref.id} of ${changes} ${batch.status === "bisecting" ? "failed and is being bisected" : batch.status === "testing" ? "is being checked" : "is forming"}` });
    }
  }

  // --- The store's events ---
  const events = [...input.events].sort((a, b) => a.seq - b.seq);
  // A board action on Jira names the person by the account id when Jira knew them; a holder's display name says who that is.
  const holderNames = new Map<string, string>();
  for (const work of input.works) if (work.holder && !work.holder.actor.bot && work.holder.actor.name.trim()) holderNames.set(work.holder.actor.id, work.holder.actor.name.trim());
  /** Switches pressed together (one press resumes three roles) are one row. */
  let lastSwitch: { row: ActivityRow; verb: string; names: string[] } | null = null;
  for (const event of events) {
    const data = obj(event.data);
    const reason = str(data.reason);
    const base = { id: `event:${event.seq}`, at: event.at, who: event.actor, agent: ["orchestrator", "scopesoup", "queue", "main-guard"].includes(event.actor) };
    const control = /^control\.(triage|implement|review|merge_queue)_(started|paused)$/.exec(event.kind);
    if (control) {
      const verb = control[2] === "started" ? "Resumed" : "Paused";
      const name = SWITCH_NAMES[control[1]!]!;
      if (lastSwitch && lastSwitch.verb === verb && lastSwitch.row.at === event.at && lastSwitch.row.who === event.actor) {
        lastSwitch.names.push(name);
        lastSwitch.row.text = `${verb} ${andList(lastSwitch.names)}`;
        continue;
      }
      const via = str(data.via);
      const row: ActivityRow = { ...base, kind: "switch", items: [], text: `${verb} ${name}`, ...(via && via !== "board" && via !== "demo" ? { detail: `via ${via}` } : {}) };
      rows.push(row);
      lastSwitch = { row, verb, names: [name] };
      continue;
    }
    lastSwitch = null;
    const subject = event.subject;
    const items = link(subject);
    switch (event.kind) {
      case "control.stopped":
        add({ ...base, kind: "switch", text: "Pressed Stop: every switch stopped and running sessions ended", tone: "bad" });
        break;
      case "control.startup_paused":
        add({ ...base, kind: "switch", text: "Scope Soup started with every switch paused" });
        break;
      case "control.paused":
        add({ ...base, kind: "switch", text: "Paused everything" });
        break;
      case "control.resumed":
        add({ ...base, kind: "switch", text: "Resumed everything" });
        break;
      case "control.queue_resume":
        add({ ...base, kind: "switch", text: "Asked the paused merge queue to go on" });
        break;
      case "orchestrator.queue_paused":
        add({ ...base, kind: "switch", text: "The merge queue paused itself", ...(reason ? { detail: clip(reason) } : {}), tone: "bad" });
        break;
      case "scopesoup.upgraded":
        add({ ...base, kind: "upgrade", text: `Upgraded Scope Soup from ${str(data.from) || "?"} to ${str(data.to) || "?"}`, tone: "good" });
        break;
      case "scopesoup.went_back":
        add({ ...base, kind: "upgrade", text: `Went back from Scope Soup ${str(data.from) || "?"} to ${str(data.to) || "?"}` });
        break;
      case "scopesoup.upgrade_failed":
        add({ ...base, kind: "upgrade", text: "An upgrade failed", ...(reason ? { detail: clip(reason) } : {}), tone: "bad" });
        break;
      case "orchestrator.draft_accepted":
      case "orchestrator.draft_edited":
        // The Item's log has the accepted text as an `edited` line.
        if (subject && logged.has(subject)) break;
        add({ ...base, kind: "triage", items, text: `Accepted the triage's rewrite${event.kind.endsWith("edited") ? " with edits" : ""}${num(data.round) ? ` (round ${data.round})` : ""}`, tone: "good" });
        break;
      case "orchestrator.draft_rejected":
        add({ ...base, kind: "triage", items, text: `Rejected the triage's rewrite${num(data.round) ? ` (round ${data.round})` : ""}` });
        break;
      case "orchestrator.draft_answered":
        if (subject && logged.has(subject)) break;
        add({ ...base, kind: "triage", items, text: `Answered the triage's questions otherwise than recommended${num(data.round) ? ` (round ${data.round})` : ""}; the triage runs again` });
        break;
      case "orchestrator.questions_asked": {
        if (subject && logged.has(subject)) break;
        const count = Array.isArray(data.questions) ? data.questions.length : 1;
        add({ ...base, kind: "question", items, text: count === 1 ? "Asked a question" : `Asked ${count} questions` });
        break;
      }
      case "person.answered":
        if (subject && logged.has(subject)) break;
        add({ ...base, kind: "question", items, who: str(data.by) || event.actor, agent: false, text: `Answered: ${clip(str(data.answer))}` });
        break;
      case "person.claimed":
      case "person.handed_back":
      case "person.released": {
        const account = str(data.account);
        const who = holderNames.get(account) ?? holderNames.get(event.actor) ?? event.actor;
        const note = str(data.note);
        const words = event.kind === "person.claimed" ? "Took the Item on the board" : event.kind === "person.handed_back" ? "Handed the Item back on the board" : "Let the Item go on the board";
        add({ ...base, kind: "item", items, who, agent: false, text: words, ...(note ? { detail: clip(note) } : {}) });
        break;
      }
      case "orchestrator.merged":
        if (subject && logged.has(`merged:${subject}`)) break;
        add({ ...base, kind: "merge", items, text: `Merged ${short(data.sha)}${num(data.batch) !== undefined ? ` through the merge queue (batch ${data.batch})` : data.by === "session" ? ", by the implementor" : ""}`, tone: "good" });
        break;
      case "config.changed": {
        // A save of the project's settings is in the settings' log; this machine's own settings are only here.
        if (data.shared) break;
        const fields = Array.isArray(data.fields) ? data.fields.filter((each): each is string => typeof each === "string") : [];
        add({ ...base, kind: "settings", text: `Changed this machine's own settings${fields.length > 0 ? `: ${fields.join(", ")}` : ""}` });
        break;
      }
      // Item drafts (decision 95): an agent's proposal, and a person's Approve or Deny. The draft is linked to its source Item.
      case "draft.created": {
        const from = obj(data.from);
        const key = str(from.host) ? `${str(from.host)}:work:${str(from.id)}` : undefined;
        add({ ...base, kind: "item", items: link(key), who: str(data.role) || "agent", agent: true, text: `Proposed a new Item as a draft: ${clip(str(data.title), 120)}` });
        break;
      }
      case "draft.updated": {
        const decided = obj(data.decided);
        if (!str(decided.verdict)) break;
        const from = obj(data.from);
        const made = obj(decided.item);
        const keys = [str(from.host) ? `${str(from.host)}:work:${str(from.id)}` : "", str(made.host) ? `${str(made.host)}:work:${str(made.id)}` : ""].filter(Boolean);
        add({ ...base, kind: "item", items: keys.flatMap((key) => link(key)), who: str(decided.by) || event.actor, agent: false, text: `${decided.verdict === "approved" ? "Approved" : "Denied"} the draft: ${clip(str(data.title), 120)}`, ...(decided.verdict === "approved" ? { tone: "good" as const } : {}) });
        break;
      }
      case "media.deleted":
        add({ ...base, kind: "item", items, who: str(data.by) || event.actor, agent: false, text: `Deleted the image ${clip(str(data.name), 100)}${data.ref === "updated" ? ", also from the remote" : ""}` });
        break;
      case "media.expired": {
        const names = Array.isArray(data.names) ? data.names.length : 0;
        add({ ...base, kind: "item", items, who: "Scope Soup", agent: false, text: `Deleted ${names} image${names === 1 ? "" : "s"} after the Item closed (media.keepDaysAfterClose)` });
        break;
      }
      default:
        break;
    }
  }

  // --- The settings' log: one short row per save; the Settings page has the whole list ---
  input.settings.forEach((save, index) => {
    const words = settingsWords(save.changes);
    if (words.length === 0) return;
    add({ id: `settings:${save.at}:${index}`, at: save.at, kind: "settings", who: save.who, agent: false, text: words.length <= 2 ? words.join("; ") : `${words[0]}; and ${words.length - 1} more changes`, ...(save.machine ? { detail: `on ${save.machine}` } : {}) });
  });

  // Newest first; for the same time, the later source and line first.
  const order = rows.map((row, index) => ({ row, index, time: Date.parse(row.at) || 0 }));
  order.sort((a, b) => b.time - a.time || b.index - a.index);
  return { now, rows: order.slice(0, limit).map((each) => each.row), more: order.length > limit };
}

/**
 * Folds consecutive session rows on one Item (newest first, as `buildActivity` gives them) into one row: "3 sessions on
 * #63: triage, implement, review · 1 h 20 min · $1.40". The folded row holds its sessions, newest first. A lone session
 * stays as it is.
 */
export function foldSessions(rows: ActivityRow[]): FoldedActivityRow[] {
  const out: FoldedActivityRow[] = [];
  let run: ActivityRow[] = [];
  const flush = () => {
    if (run.length < 2) out.push(...run);
    else out.push(foldRun(run));
    run = [];
  };
  for (const row of rows) {
    const item = row.items[0]?.key;
    if (row.kind === "session" && row.session && item !== undefined && run.length > 0 && run[0]!.items[0]?.key === item) run.push(row);
    else {
      flush();
      if (row.kind === "session" && row.session && item !== undefined) run = [row];
      else out.push(row);
    }
  }
  flush();
  return out;
}

function foldRun(run: ActivityRow[]): FoldedActivityRow {
  const oldestFirst = [...run].reverse();
  const roles: string[] = [];
  for (const row of oldestFirst) {
    const role = row.session!.role;
    const last = roles.at(-1);
    const n = last === undefined ? 0 : Number(/ ×(\d+)$/.exec(last)?.[1] ?? 1);
    if (last !== undefined && last.replace(/ ×\d+$/, "") === role) roles[roles.length - 1] = `${role} ×${n + 1}`;
    else roles.push(role);
  }
  const ms = run.reduce((sum, row) => sum + (row.session!.ms ?? 0), 0);
  const usd = run.some((row) => row.session!.usd !== undefined) ? run.reduce((sum, row) => sum + (row.session!.usd ?? 0), 0) : undefined;
  const first = run[0]!;
  const item = first.items[0]!;
  const text = [`${run.length} sessions on #${item.id}: ${roles.join(", ")}`, ms > 0 ? duration(ms) : "", usd !== undefined ? cost(usd) : ""].filter(Boolean).join(" · ");
  return {
    id: `fold:${first.id}`, at: first.at, kind: "session", who: "agents", agent: true, items: first.items, text,
    ...(run.some((row) => row.tone === "bad") ? { tone: "bad" as const } : {}), folded: run,
  };
}

/** "a", "a and b", "a, b and c". */
function andList(names: string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The kinds of rows, for the filter, in the order the page lists them. */
export const ACTIVITY_KINDS: readonly ActivityKind[] = ["item", "triage", "question", "decision", "session", "merge", "batch", "switch", "upgrade", "settings"];
