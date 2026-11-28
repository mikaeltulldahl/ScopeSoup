// The rules across machines of the multiplayer profile (`multi.ts`, #211 plan step 4): what holds between several Scope Soups on one
// meta remote. `final` rules are checked once, after every machine synced and stopped; the others after every step. Each check
// returns what is wrong in words, or null. The single-machine rules (`rules.ts`) are checked per machine besides these.

import { foldLog, parseLog } from "../hosts/metaBranch/log.ts";
import { REQUEST_TTL_MS, readRequests } from "../hosts/metaBranch/requests.ts";
import type { RecordedAnswer, ScopeSoupEvent, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import type { Job } from "../orchestrator/jobs.ts";
import { parkedOf } from "../orchestrator/jobs.ts";
import type { SessionRequest } from "../orchestrator/ports.ts";
import type { MetaFiles } from "./metaHost.ts";
import type { Ledger } from "./world.ts";

export interface MachineObs {
  name: string;
  /** The Items in this machine's store. */
  items: WorkItem[];
  /** The answers this machine acts on. */
  answers: RecordedAnswer[];
  /** The Items this machine has a live session on (one entry per session). */
  live: string[];
  events: ScopeSoupEvent[];
  ledger: Ledger;
  /** Every session started on this machine so far, with the step. */
  started: { step: number; request: SessionRequest }[];
  /** This machine's clock, in milliseconds. */
  now: number;
  down: boolean;
  /** This machine's jobs, by Item key. */
  jobs: Record<string, Job>;
  /** Ticks this machine ran with the meta remote up and no other machine's push due to get ahead of its swaps. */
  onlineTicks: number;
}

export interface MultiObs {
  step: number;
  final: boolean;
  machines: MachineObs[];
  /** The meta remote's files, by Item id. */
  remote: ReadonlyMap<string, MetaFiles>;
  requestLines: string[];
  /** Picks a board wrote as requests for another machine. */
  picks: { id: string; for: string; from: string; step: number; item: string }[];
  /** Items a person filed from another machine while one wrote. */
  filed: { key: string; step: number; title: string; body: string }[];
}

export interface MultiRule {
  id: string;
  why: string;
  /** Checked only at the end, after every machine synced and stopped. */
  final?: true;
  check(o: MultiObs, memo: Record<string, unknown>): string | null;
}

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();
const idOf = (key: string): string => key.split(":").pop() ?? key;

/** What two machines must agree on about one Item once both have synced. */
function itemFace(item: WorkItem): Record<string, unknown> {
  return {
    state: item.state, title: item.title, body: squash(item.body ?? ""), backlog: item.backlog === true,
    holder: item.holder ? `${item.holder.actor.id}${item.holder.until ? ` until ${item.holder.until}` : ""}` : null,
    log: (item.log ?? []).map((line) => JSON.stringify([line.at, line.by, line.kind, line.fields])),
    openQuestions: (item.openQuestions ?? []).map((q) => q.at),
  };
}

export const MULTI_RULES: MultiRule[] = [
  {
    id: "M1",
    final: true,
    why: "Convergence: after every machine synced and stopped, they agree on every Item's state, text, lane, holder and log, and on the answers they act on.",
    check(o) {
      const [first, ...rest] = o.machines;
      if (!first) return null;
      const faces = (m: MachineObs): Map<string, Record<string, unknown>> => new Map(m.items.map((item) => [refKey(item.ref), itemFace(item)]));
      const answers = (m: MachineObs, key: string): string[] => m.answers.filter((a) => refKey(a.subject) === key).map((a) => a.answer).sort();
      const mine = faces(first);
      for (const other of rest) {
        const theirs = faces(other);
        for (const key of new Set([...mine.keys(), ...theirs.keys()])) {
          const a = mine.get(key);
          const b = theirs.get(key);
          if (!a || !b) return `${idOf(key)} is in ${a ? first.name : other.name}'s store but not in ${a ? other.name : first.name}'s`;
          for (const field of Object.keys(a)) {
            if (JSON.stringify(a[field]) !== JSON.stringify(b[field])) return `${first.name} and ${other.name} disagree on ${idOf(key)}'s ${field}: ${JSON.stringify(a[field]).slice(0, 120)} against ${JSON.stringify(b[field]).slice(0, 120)}`;
          }
          const x = answers(first, key);
          const y = answers(other, key);
          if (JSON.stringify(x) !== JSON.stringify(y)) return `${first.name} acts on the answers ${JSON.stringify(x).slice(0, 120)} on ${idOf(key)}, ${other.name} on ${JSON.stringify(y).slice(0, 120)}`;
        }
      }
      return null;
    },
  },
  {
    id: "M2",
    final: true,
    why: "No answer lost across machines: every answer a machine's server accepted is on the meta remote, in its Item's log, where the other machines read it.",
    check(o) {
      for (const m of o.machines) {
        for (const a of m.ledger.answers) {
          const files = o.remote.get(idOf(a.item));
          const quoted = JSON.stringify(a.text).slice(1, -1);
          if (!files || !files.log.includes(quoted)) return `the answer "${a.text.slice(0, 60)}" on ${idOf(a.item)}, accepted on ${m.name} at step ${a.step}, is not in the Item's log on the meta remote`;
        }
      }
      return null;
    },
  },
  {
    id: "M3",
    why: "One holder: an Item never has sessions running on two machines at once, unless one machine's claim ran out unrenewed (it was offline or did not tick) and another rightly took the Item after it.",
    check(o) {
      const where = new Map<string, Set<string>>();
      for (const m of o.machines) for (const key of m.live) (where.get(key) ?? where.set(key, new Set()).get(key)!).add(m.name);
      for (const [key, names] of where) {
        if (names.size < 2) continue;
        // Each machine's last claim on the meta remote. A machine whose claim ran out before another machine's newer claim was
        // written lost the Item rightly (claims lapse); it stops its session once it reads that (`renewClaims`).
        const last = new Map<string, { at: number; until: number }>();
        for (const line of (o.remote.get(idOf(key))?.log ?? "").split("\n")) {
          if (!line.trim()) continue;
          const entry = JSON.parse(line) as { at: string; kind: string; until?: string; by: { machine?: string; agent?: boolean } };
          if (entry.kind !== "claimed" || !entry.by.agent || !entry.by.machine || !entry.until) continue;
          last.set(entry.by.machine, { at: Date.parse(entry.at), until: Date.parse(entry.until) });
        }
        const lapsed = (name: string): boolean => {
          const mine = last.get(name);
          return !!mine && [...names].some((other) => other !== name && (last.get(other)?.at ?? -Infinity) >= mine.until);
        };
        const holding = [...names].filter((name) => !lapsed(name));
        if (holding.length > 1 || holding.length === 0) return `${idOf(key)} has sessions running on ${[...names].join(" and ")} at once`;
      }
      return null;
    },
  },
  {
    id: "M4",
    why: "A pick requested of another machine is carried out once, by that machine, and its answer reaches the meta remote; by the end every request reached in time is carried out.",
    check(o) {
      const taken = new Map<string, string[]>();
      for (const m of o.machines) {
        for (const e of m.events) {
          if (e.kind !== "orchestrator.pick_request_taken") continue;
          const id = String((e.data as Record<string, unknown> | undefined)?.request ?? "");
          (taken.get(id) ?? taken.set(id, []).get(id)!).push(m.name);
        }
      }
      for (const pick of o.picks) {
        const by = taken.get(pick.id) ?? [];
        if (by.length > 1) return `the pick ${pick.id.slice(0, 8)} on ${idOf(pick.item)} (asked of ${pick.for}) was taken ${by.length} times (${by.join(", ")})`;
        if (by.length === 1 && by[0] !== pick.for) return `the pick ${pick.id.slice(0, 8)} on ${idOf(pick.item)}, asked of ${pick.for}, was carried out by ${by[0]}`;
      }
      const answers = new Map<string, number>();
      for (const line of o.requestLines) {
        const fields = JSON.parse(line) as Record<string, unknown>;
        if ((fields.kind === "pick-done" || fields.kind === "pick-refused") && typeof fields.request === "string") answers.set(fields.request, (answers.get(fields.request) ?? 0) + 1);
      }
      for (const [id, n] of answers) if (n > 1) return `the pick ${id.slice(0, 8)} has ${n} answers on the meta remote`;
      if (!o.final) return null;
      const requests = readRequests(o.requestLines.join("\n"));
      for (const pick of o.picks) {
        const request = requests.find((r) => r.id === pick.id);
        if (request?.answer) continue;
        if ((taken.get(pick.id) ?? []).length > 0) return `${pick.for} carried out the pick ${pick.id.slice(0, 8)} on ${idOf(pick.item)}, but its answer is not on the meta remote, so other boards show it waiting`;
        const target = o.machines.find((m) => m.name === pick.for);
        const at = request ? Date.parse(request.at) : NaN;
        if (target && !Number.isNaN(at) && target.now - at < REQUEST_TTL_MS) return `the pick ${pick.id.slice(0, 8)} on ${idOf(pick.item)}, asked of ${pick.for} at step ${pick.step}, was never carried out though ${pick.for} fetched since`;
      }
      return null;
    },
  },
  {
    id: "M5",
    final: true,
    why: "No edit lost across machines: an Item's description on the meta remote is the last a person wrote or accepted on any machine.",
    check(o, memo) {
      void memo;
      const last = (memo.last ??= {}) as Record<string, { step: number; body: string; on: string }>;
      for (const [key, entry] of Object.entries(last)) {
        const files = o.remote.get(idOf(key));
        if (!files) continue;
        const body = /\n---\n([\s\S]*)$/.exec(files.itemMd)?.[1] ?? "";
        const item = o.machines[0]!.items.find((i) => refKey(i.ref) === key);
        const now = squash(item?.body ?? body);
        if (now !== squash(entry.body)) return `${idOf(key)}'s description is "${now.slice(0, 60)}", not the last a person wrote or accepted ("${squash(entry.body).slice(0, 60)}", on ${entry.on} at step ${entry.step})`;
      }
      return null;
    },
  },
  {
    id: "M6",
    why: "Answers travel: a session on any machine is told every answer given on any machine on its Item before it started.",
    check(o, memo) {
      const done = (memo.done ??= {}) as Record<string, number>;
      for (const m of o.machines) {
        const from = done[m.name] ?? 0;
        done[m.name] = m.started.length;
        for (const s of m.started.slice(from)) {
          const key = refKey(s.request.subject);
          const prompt = JSON.stringify(s.request.vars) + (s.request.message ?? "");
          for (const other of o.machines) {
            if (other === m) continue;
            const missing = other.ledger.answers.find((a) => a.item === key && a.step < s.step && !prompt.includes(a.text));
            if (missing) return `the ${s.request.role} session on ${idOf(key)} on ${m.name} (step ${s.step}) is not told the answer "${missing.text.slice(0, 60)}" given on ${other.name} at step ${missing.step}`;
          }
        }
      }
      return null;
    },
  },
  {
    id: "M7",
    why: "Items appear only by a person's request on some machine, and never disappear from the meta remote.",
    check(o, memo) {
      const had = (memo.items as number | undefined) ?? o.remote.size;
      const made = o.machines.reduce((n, m) => n + m.ledger.requests.filter((r) => r.path === "/api/items" && r.status === 200).length, 0) + o.filed.length;
      const madeBefore = (memo.made as number | undefined) ?? made;
      memo.items = o.remote.size;
      memo.made = made;
      if (o.remote.size < had) return "an Item disappeared from the meta remote";
      // Filed by the racer inside a swap: its record lands a moment after its write, so one step of slack.
      if (o.remote.size - had > made - madeBefore + 1) return `${o.remote.size - had - (made - madeBefore)} Item(s) appeared on the meta remote with no person's request`;
      return null;
    },
  },
  {
    id: "M8",
    why: "Decisions are surfaced, not made, across machines: every answer a machine acts on was sent by a person on some machine.",
    check(o) {
      const sent = new Set(o.machines.flatMap((m) => m.ledger.answers.map((a) => a.text)));
      // A person's request on any board: carried out there (200), or a pick asked of the machine where the work runs (202).
      const asked = new Set(o.machines.flatMap((m) => m.ledger.requests.filter((r) => (r.status === 200 || r.status === 202) && r.item).map((r) => r.item)));
      for (const m of o.machines) {
        const made = m.answers.find((a) => !sent.has(a.answer) && !/scopesoup/i.test(a.by) && !asked.has(a.subject.id));
        if (made) return `${m.name} acts on an answer "${made.answer.slice(0, 60)}" by ${made.by} on ${made.subject.id} that no person sent`;
      }
      return null;
    },
  },
  {
    id: "M9",
    why: "A wait for a person's answers belongs to no machine, and one machine goes on after the answer (#271): no machine holds a live claim on an Item while its job there only waits for a person's answers (its questions posted), once it has ticked with the remote up since; and between one person's input on an Item (an answer, or any request about it on any board) and the next, sessions on it start on one machine only, unless that machine's claim ran out before the other's claim was written.",
    check(o, memo) {
      // 1. No claim on a wait for answers. The tick that parks lets the claim go; a tick that could not write (offline, or other
      // machines' pushes kept getting in first) leaves it to the next one, so a claim is wrong once the machine ticked online since.
      const seen = (memo.seen ??= {}) as Record<string, number>;
      for (const m of o.machines) {
        for (const [key, job] of Object.entries(m.jobs)) {
          const id = `${m.name}|${key}`;
          const parked = parkedOf(job);
          const waits = !!parked && parked.as !== "queued" && parked.as !== "handed-over" && parked.retry !== "post";
          const files = o.remote.get(idOf(key));
          const holder = files ? foldLog(parseLog(files.log)).holder : undefined;
          const holds = !!holder && holder.by.agent === true && holder.by.machine === m.name && !!holder.until && Date.parse(holder.until) > m.now;
          if (!waits || !holds || m.down || m.live.includes(key)) {
            delete seen[id];
            continue;
          }
          seen[id] ??= m.onlineTicks;
          if (m.onlineTicks > seen[id]!) return `${idOf(key)} only waits for a person's answers on ${m.name} (${parked!.as}), which still holds a claim on it until ${holder!.until}`;
        }
      }
      // 2. One machine goes on after a person's input. Input on any board starts a new turn; the first machine to start a session after
      // it goes on, and another may start one only once that machine's claim ran out unrenewed (offline, as M3 allows).
      const done = (memo.started ??= {}) as Record<string, number>;
      const goesOn = (memo.goesOn ??= {}) as Record<string, { machine: string; since: number }>;
      const inputs = new Map<string, number>();
      const note = (key: string, step: number): void => void inputs.set(key, Math.max(inputs.get(key) ?? 0, step));
      for (const m of o.machines) {
        for (const a of m.ledger.answers) note(a.item, a.step);
        for (const r of m.ledger.requests) {
          const item = r.item && (r.status === 200 || r.status === 202) ? m.items.find((each) => each.ref.id === r.item) : undefined;
          if (item) note(refKey(item.ref), r.step);
        }
      }
      const lastClaim = (key: string, machine: string): { at: number; until: number } | undefined => {
        let last: { at: number; until: number } | undefined;
        for (const entry of parseLog(o.remote.get(idOf(key))?.log ?? "").entries) {
          const until = entry.data.until;
          if (entry.kind === "claimed" && entry.by.agent && entry.by.machine === machine && typeof until === "string") last = { at: Date.parse(entry.at), until: Date.parse(until) };
        }
        return last;
      };
      for (const m of o.machines) {
        const from = done[m.name] ?? 0;
        done[m.name] = m.started.length;
        for (const s of m.started.slice(from)) {
          const key = refKey(s.request.subject);
          const since = inputs.get(key) ?? 0;
          const before = goesOn[key];
          const theirs = before ? lastClaim(key, before.machine) : undefined;
          const mine = lastClaim(key, m.name);
          const lapsed = !!theirs && !!mine && mine.at >= theirs.until;
          if (before && before.since === since && before.machine !== m.name && !lapsed) {
            return `${idOf(key)}: ${before.machine} went on after the last person's input on it (step ${since}), and ${m.name} started a ${s.request.role} session on it too, at step ${s.step}`;
          }
          goesOn[key] = { machine: m.name, since };
        }
      }
      return null;
    },
  },
];

/**
 * Keeps M5's record of the last text a person wrote or accepted per Item, across machines, in step order. Called after every step,
 * before the checks: a machine's ledger keeps only its own last text per Item, so the step it changed is noted here.
 */
export function noteTexts(o: MultiObs, memo: Record<string, unknown>): void {
  const last = (memo.last ??= {}) as Record<string, { step: number; body: string; on: string }>;
  const seen = (memo.seenTexts ??= {}) as Record<string, string>;
  for (const m of o.machines) {
    for (const [key, text] of m.ledger.texts) {
      const id = `${m.name}|${key}`;
      const now = JSON.stringify(text);
      if (seen[id] === now) continue;
      seen[id] = now;
      last[key] = { step: o.step, body: text.body, on: m.name };
    }
  }
  for (const f of o.filed) if (!last[f.key] || last[f.key]!.step < f.step) last[f.key] ??= { step: f.step, body: f.body, on: "another machine" };
}

export const MULTI_RULE_IDS = MULTI_RULES.map((rule) => rule.id);
