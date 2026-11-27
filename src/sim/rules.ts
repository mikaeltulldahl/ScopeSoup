// The rules of the Item lifecycle (issue #211), checked from the outside after every step of a simulated run. Each rule has its
// id, a one-line why (the kind of failure it stands for, and the issue that first showed it), and its check, which returns what
// is wrong in words, or null. A bug in the lifecycle is a gap here: first add or sharpen a rule that fails on it, then fix the code.
//
// A check reads the observation after the step, the one before, and a memo of its own for the run (for "within 2 ticks").
// Where a rule as written in the issue could not be checked in full yet, the check says what it covers; the rest is noted.

import type { ItemObs, Observation } from "./observe.ts";
import type { W } from "./waits.ts";
import { isBusy, personHolds, stageLane, wText } from "./waits.ts";

export interface Rule {
  id: string;
  why: string;
  check(o: Observation, prev: Observation | undefined, memo: Record<string, unknown>): string | null;
}

const OWN = "scopesoup@laptop-a";
const isClosed = (i: ItemObs): boolean => i.item.state === "done" || i.item.state === "abandoned";
const prevOf = (prev: Observation | undefined, key: string): ItemObs | undefined => prev?.items.find((each) => each.key === key);
const isTick = (o: Observation): boolean => o.action.kind === "tick" || o.action.kind === "inside-tick";
const asks = (w: W): boolean => w.kind === "person" && (w.why === "answer" || w.why === "rewrite" || w.why === "restructuring");
const squash = (text: string): string => text.replace(/\s+/g, " ").trim();
const first = <T>(list: T[], f: (each: T) => string | null): string | null => {
  for (const each of list) {
    const found = f(each);
    if (found) return found;
  }
  return null;
};
/**
 * The Items whose job a lost store took and no tick has rebuilt from the Item's log yet (the first tick whose store has the Item does):
 * until then the board reads them from the host alone.
 */
function toRebuild(o: Observation, prev: Observation | undefined, memo: Record<string, unknown>): Record<string, true> {
  const rebuild = (memo.rebuild ??= {}) as Record<string, true>;
  if (o.action.kind === "lose-store") for (const i of prev?.items ?? []) if (i.job) rebuild[i.key] = true;
  if (isTick(o)) for (const i of o.items) delete rebuild[i.key];
  return rebuild;
}

/** Counts ticks since a condition first held for a key; returns the count (0 on the first). Clears when it stops holding. */
function ticksSince(memo: Record<string, unknown>, key: string, holds: boolean, o: Observation, counts = isTick(o)): number {
  const table = (memo.since ??= {}) as Record<string, number>;
  if (!holds) {
    delete table[key];
    return 0;
  }
  if (!(key in table)) table[key] = 0;
  else if (counts) table[key]!++;
  return table[key]!;
}

// A triage runs in To do, or in Backlog when a person asked for one there (#221).
const roleLane = (role: string, item: ItemObs["item"]): string => (role === "triage" ? (item.backlog ? "backlog" : "todo") : role === "implement" ? "in-progress" : "in-review");

export const RULES: Rule[] = [
  // --- A. One truth ---
  {
    id: "A1",
    why: "Views follow W: the card's lane and actor are the ones W gives (#185, #198, #207, #194).",
    check(o, prev, memo) {
      const rebuild = toRebuild(o, prev, memo);
      return first(o.items, (i) => {
        const card = i.card;
        const lane = card?.lane;
        if ((lane === "queued" || lane === "checking") && !(rebuild[i.key] && !i.job)) {
          if (i.w.kind !== "queue" && i.w.kind !== "nothing") return `${i.id} is in the ${lane} lane, but W is ${wText(i.w)}`;
        }
        if (!card) return null;
        if (i.w.kind === "session" && !i.w.settling) {
          if (card.actor !== "agent") return `${i.id}: a ${i.w.role} session runs, but the card's actor is ${card.actor}`;
          if (lane !== roleLane(i.w.role, i.item)) return `${i.id}: a ${i.w.role} session runs, but the card is in ${lane}`;
        }
        if (i.w.kind === "blocker" && lane !== "blocked") return `${i.id} waits for ${i.w.on.join(", ")} but is in ${lane}, not Blocked`;
        if (i.w.kind === "person" && i.w.why !== "holds" && i.w.why !== "merge" && lane !== stageLane(i.item, i.job)) return `${i.id}: W is ${wText(i.w)}, so its lane is ${stageLane(i.item, i.job)} (decision 2), but the card is in ${lane}`;
        if (i.w.kind === "nothing" && i.item.state === "done" && lane !== "done") return `${i.id} is done but in ${lane}`;
        // The words of the cause (decision 3): the two timed waits have their own. Read after a tick: between ticks the card is the
        // last tick's, while W reads git as it is now (a session's merge makes another Item no longer busy before any tick saw it, #238).
        if (!isTick(o)) return null;
        if (i.w.kind === "start" && i.w.cause === "text" && !/read back/.test(card.reason)) return `${i.id} waits for its written text to be read back, but the card says "${card.reason}"`;
        if (i.w.kind === "start" && i.w.cause === "timer" && !/(tries again|resumes|starts) in /.test(card.reason)) return `${i.id} waits for a timer, but the card says "${card.reason}"`;
        return null;
      });
    },
  },
  {
    id: "A2",
    why: "Your turn is exactly what a person can act on: never while a session works on it, never missing when a person is waited for (#194).",
    check(o) {
      return first(o.items, (i) => {
        if (!i.card) return null;
        const personTurn = i.card.actor === "anyone" || i.card.actor === "person";
        if (i.w.kind === "session" && !i.w.settling && personTurn) return `${i.id} is a person's turn while a ${i.w.role} session works on it`;
        if (i.w.kind === "person" && i.w.why !== "holds" && !personTurn) return `${i.id} waits for a person (${wText(i.w)}) but the card's actor is ${i.card.actor}`;
        return null;
      });
    },
  },
  {
    id: "A3",
    why: "One count of what is asked: the job's open asks and the host's open question lines agree; none open unless a person is asked (#194, #209).",
    check(o, prev, memo) {
      const rebuild = toRebuild(o, prev, memo);
      return first(o.items, (i) => {
        if (!i.host || isClosed(i)) return null;
        if (rebuild[i.key] && !i.job) return null;
        // A person's hold comes first in W, but the questions the job is parked on still wait for an answer under it.
        if (i.w.kind === "person" && i.w.why === "holds" && i.job?.parked) return null;
        // Another machine's Scope Soup asked it: that machine's job waits for it, not this one's (the multiplayer profile).
        const elsewhere = (q: { by: { agent?: boolean; machine?: string } }): boolean => !!q.by.agent && !!o.machine && !!q.by.machine && q.by.machine !== o.machine;
        const open = (i.host.openQuestions ?? []).filter((q) => !q.proposal && !elsewhere(q)).length;
        const personAsk = i.w.kind === "person" && i.w.why !== "holds";
        if (personAsk && !asks(i.w) && open > 1) return `${i.id} has ${open} open question lines on the host, but W is ${wText(i.w)}, which asks one thing`;
        if (open > 0 && !personAsk && i.w.kind !== "session") return `${i.id} has ${open} open question line(s) on the host, but W is ${wText(i.w)}`;
        if (i.w.kind === "person" && i.w.why === "answer" && i.w.n !== undefined && i.w.n > 0 && open === 0 && !i.job?.parked?.retry) return `${i.id} is parked on ${i.w.n} question(s), none of them open on the host`;
        return null;
      });
    },
  },
  {
    id: "A4",
    why: "The tick agrees: a step starts only when W said it waits for a slot (the other side of #198).",
    check(o, prev) {
      if (!isTick(o) || !prev) return null;
      return first(o.started, (s) => {
        const before = prevOf(prev, s.item);
        if (!before) return null;
        const w = before.w;
        if (w.kind === "not-started" || (w.kind === "start" && w.cause === "slot")) return null;
        // A session that ended is settled by the tick first, and what follows may start in the same tick.
        if (w.kind === "session" && w.settling) return null;
        // A blocker whose session the tick settled first may have closed in the same tick.
        if (w.kind === "blocker" && w.on.every((k) => { const b = o.items.find((each) => each.key === k); return !b || isClosed(b); })) return null;
        // A triage whose Item's text changed under it is stopped and started again (decision 6).
        if (w.kind === "session" && w.role === "triage" && s.role === "triage") return null;
        if (w.kind === "start" && w.cause === "timer") return null;
        // The tick settles finished sessions first, which can end a same-files wait within the same tick.
        if (w.kind === "start" && w.cause === "same-files") return null;
        // A re-triage may run at any moment on an Item that waits at implement (decision 9).
        if (s.role === "triage" && w.kind === "start" && w.role === "implement" && prev.switches.triage === "started") return null;
        if (w.kind === "person" && w.why !== "holds") return null; // a pick or an answer may carry it on
        return `${s.role} started on ${before.id} while W was ${wText(w)}`;
      });
    },
  },
  {
    id: "A5",
    why: "What is said to have happened did happen: queued means the queue has it, handed over means the branch exists, Done means merged or closed by a person.",
    check(o) {
      return first(o.items, (i) => {
        if (i.w.kind === "queue" && !o.queued.includes(i.key) && !i.job?.merged) return `${i.id} is parked as queued, but the queue does not have it`;
        if (i.w.kind === "person" && i.w.why === "merge" && i.job && !o.git.branches.has(i.job.branch)) return `${i.id} is handed over, but ${i.job.branch} does not exist`;
        if (i.item.state === "done" && !o.ledger.closesAsked.has(i.key)) {
          if (!o.git.mainMoves.some((m) => m.item === i.key)) return `${i.id} is Done, but its change is not on main and no person closed it`;
        }
        return null;
      });
    },
  },
  {
    id: "A6",
    why: "The status line says why nothing runs: idle with no session means no Item waits only for a slot.",
    check(o) {
      if (!o.tick || o.tick.started.length > 0 || o.liveCount > 0 || !o.tick.idle || o.remote.down) return null;
      const slot = o.items.find((i) => i.w.kind === "start" && i.w.cause === "slot");
      return slot ? `the tick says "${o.tick.idle.slice(0, 80)}", yet ${slot.id} waits only for a slot` : null;
    },
  },
  // --- B. What a person put in ---
  {
    id: "B1",
    why: "No answer lost or doubled: an accepted answer is in the store's answers, as many times as the person gave it, and in the prompt of every later session on the Item.",
    check(o, _prev, memo) {
      const known = new Set(o.answers.map((a) => `${a.subject.host}:${a.subject.kind}:${a.subject.id}|${a.answer}`));
      // After the store is lost, the answers given before reach the sessions through the Item's log (G3); the prompts are checked below.
      if (o.action.kind === "lose-store") memo.lostAt = o.step;
      const lost = o.ledger.answers.find((a) => a.step > ((memo.lostAt as number | undefined) ?? -1) && !known.has(`${a.item}|${a.text}`));
      if (lost) return `the answer "${lost.text}" on ${lost.item.split(":").pop()} (step ${lost.step}) is not in the store's answers`;
      const given = new Map<string, number>();
      // With several machines an answer given on another board is an answer here too (decision 130).
      for (const a of [...o.ledger.answers, ...(o.answersElsewhere ?? [])]) given.set(`${a.item}|${a.text}`, (given.get(`${a.item}|${a.text}`) ?? 0) + 1);
      const had = new Map<string, number>();
      for (const a of o.answers) {
        const k = `${a.subject.host}:${a.subject.kind}:${a.subject.id}|${a.answer}`;
        had.set(k, (had.get(k) ?? 0) + 1);
        if (given.has(k) && had.get(k)! > given.get(k)!) return `the answer "${a.answer}" on ${a.subject.id} is in the store's answers ${had.get(k)} times, but was given ${given.get(k)}`;
      }
      return first(o.started, (s) => {
        const prompt = JSON.stringify(s.request.vars) + (s.request.message ?? "");
        const missing = o.ledger.answers.find((a) => a.item === s.item && a.step < o.step && !prompt.includes(a.text));
        return missing ? `the ${s.role} session on ${s.item.split(":").pop()} is not told the answer "${missing.text}" (step ${missing.step})` : null;
      });
    },
  },
  {
    id: "B2",
    why: "No text lost: the Item's description on the host is the last a person wrote or accepted.",
    check(o) {
      return first(o.items, (i) => {
        const want = o.ledger.texts.get(i.key);
        if (!want || !i.host) return null;
        return squash(i.host.body ?? "") === squash(want.body) ? null : `${i.id}'s description on the host is "${squash(i.host.body ?? "").slice(0, 60)}", not the last a person wrote or accepted ("${squash(want.body).slice(0, 60)}")`;
      });
    },
  },
  {
    id: "B3",
    why: "Nothing acts on a stale basis: a request made from a page that no longer holds is refused (#195, #209, #183).",
    check(o) {
      // An answer the server says it had already (a retry, #238) changes nothing, so it is not acted on.
      const stale = o.requests.find((r) => r.body.parkedAt === "2026-01-01T00:00:00.000Z" && r.status >= 200 && r.status < 300 && (r.response as { already?: boolean } | null)?.already !== true);
      return stale ? `${stale.path} on ${stale.item} was carried out with a parked state the Item never had` : null;
    },
  },
  {
    id: "B4",
    why: "Nothing stale is shown: no open question names a closed Item, and no closed Item has an open question (#199, #209, #198, #196).",
    check(o) {
      const closed = o.items.filter(isClosed).map((i) => i.id);
      return first(o.items, (i) => {
        if (!i.host) return null;
        // A question another Item's agent asked names that Item as the asker, not as its subject.
        for (const q of (i.host.openQuestions ?? []).filter((each) => !/^Asked by /.test(each.question))) {
          const named = closed.find((id) => new RegExp(`\\b${id}\\b`).test(q.question));
          if (named && i.id !== named) return `${i.id} still asks "${q.question.slice(0, 60)}", about ${named}, which is closed`;
        }
        return null;
      });
    },
  },
  {
    id: "B5",
    why: "A person's action is never overwritten by the program: a close or an edit accepted inside a tick's await still holds after it.",
    check(o) {
      if (o.action.kind !== "inside-tick") return null;
      return first(o.requests, (r) => {
        if (r.status !== 200 || !r.item) return null;
        const i = o.items.find((each) => each.id === r.item);
        if (!i) return null;
        if (r.path === "/api/item/edit" && (r.body.state === "done" || r.body.state === "abandoned") && !isClosed(i)) return `${i.id} was closed inside the tick, but is ${i.item.state} after it`;
        return null;
      });
    },
  },
  {
    id: "B6",
    why: "A person's hold stands: no session starts on an Item a person holds.",
    check(o, prev) {
      return first(o.started, (s) => {
        const before = prevOf(prev, s.item);
        return before && personHolds(before.item, OWN) ? `a ${s.role} session started on ${before.id}, which ${before.item.holder?.actor.name} holds` : null;
      });
    },
  },
  {
    id: "B7",
    why: "No repeat without new input: no session of a role twice on the same input after a settled result; under Fair at most 3 asks per Item (#171, #196, #197).",
    check(o, prev, memo) {
      const seen = (memo.inputs ??= {}) as Record<string, string>;
      for (const s of o.started) {
        const input = JSON.stringify([s.request.vars.itemTitle, s.request.vars.itemBody, s.request.message ?? "", s.request.vars.recheck ?? "", s.request.vars.history ?? "", s.request.resume ?? "", o.git.branches.get(s.request.branch) ?? "", o.git.main]);
        const key = `${s.item}|${s.role}|${input}`;
        const before = seen[key];
        // A retry after a failure (or a cut-off session resumed) is not a repeat, and neither is a start after the session with this
        // input ended with no result of its own: a restart left it with no process (it is started again, not counted, #238).
        const last = o.ledger.ended.filter((e) => e.item === s.item && e.role === s.role).at(-1);
        const beforeSettled = before !== undefined && o.ledger.ended.some((e) => e.session === before && e.settled);
        // An Item with no job on this machine, or one a person's move drops, starts anew (as does one whose claim went to another machine), and a job with a failure counted is retried: an implementor's "done" with no commit is settled in the ledger but a failure to the tick.
        const dropped = prev !== undefined && prev.items.some((i) => i.key === s.item && (i.job === undefined || i.job.dropAskedBy !== undefined || i.job.failures > 0));
        if (before && beforeSettled && last?.settled && !dropped) return `a ${s.role} session started again on ${s.item.split(":").pop()} with the same input as session ${before}, after it succeeded`;
        seen[key] = s.session;
      }
      for (const [key, n] of o.ledger.asksInFair) if (n > 3) return `under Fair, ${key.split(":").pop()} was asked ${n} times`;
      return first(o.items, (i) => {
        const rewrite = i.w.kind === "person" && i.w.why === "rewrite" ? i.job?.rewrite : undefined;
        // Questions (or label changes) come with the description unchanged, as its own text: that is no rewrite to accept. A rewrite
        // that differs from the description only in whitespace is dropped in every case, and a rewrite alone that equals it is none.
        if (rewrite && squash(rewrite.text) === squash(i.item.body ?? "")) {
          const alone = rewrite.questions.length === 0 && !rewrite.labels;
          if (alone || rewrite.text !== rewrite.original) return `${i.id} shows a rewrite that equals its description${alone ? "" : " apart from whitespace"}`;
        }
        return null;
      });
    },
  },
  {
    id: "B8",
    why: "An answer resumes where it was asked, with the work kept: an implementor's question answered goes back to the implementor, not to triage.",
    check(o, prev, memo) {
      const expect = (memo.expect ??= {}) as Record<string, string>;
      for (const r of o.requests) {
        if (r.status !== 200 || !r.item || !r.path.startsWith("/api/answer")) continue;
        const before = prev?.items.find((i) => i.id === r.item);
        if (before?.job?.parked?.byStep && before.job.step === "implement") expect[before.key] = "implement";
      }
      // A person's move, start over or edit since then sends the Item elsewhere, rightly.
      for (const r of o.requests) if (r.status === 200 && r.item && /move|start-over|edit|pick/.test(r.path)) delete expect[`metaBranch:work:${r.item}`];
      for (const s of o.started) {
        const want = expect[s.item];
        if (!want) continue;
        delete expect[s.item];
        if (s.role !== want) return `${s.item.split(":").pop()} was answered at its implement step, but the next session is ${s.role}`;
      }
      for (const i of o.items) if (isClosed(i) || (i.job === undefined && i.w.kind !== "session")) delete expect[i.key];
      return null;
    },
  },
  // --- C. Closed Items ---
  {
    id: "C1",
    why: "An Item is closed only by a person's close of that Item (sent on its own page, decision 8) or by its merge (#209, #183).",
    check(o, prev, memo) {
      const answeredOn = (memo.answeredOn ??= {}) as Record<string, boolean>;
      for (const r of o.requests) if (r.status === 200 && r.item && /answer|rewrite|proposal/.test(r.path)) answeredOn[r.item] = true;
      return first(o.items, (i) => {
        const before = prevOf(prev, i.key);
        if (!before || isClosed(before) || !isClosed(i)) return null;
        if (o.ledger.closesAsked.has(i.key)) return null;
        if (o.git.mainMoves.some((m) => m.item === i.key)) return null;
        if (answeredOn[i.id]) return null;
        return `${i.id} was closed (${i.item.state}) with no person's close of it and no merge`;
      });
    },
  },
  {
    id: "C2",
    why: "Merged is done, once: a merged change gets no new session and the Item is done within 2 ticks (#184).",
    check(o, _prev, memo) {
      return first(o.items, (i) => {
        const head = i.job?.head;
        const merged = !!head && o.git.contains(head, o.git.main) === true && o.git.commit(head)?.by === "agent";
        const n = ticksSince(memo, `C2|${i.key}`, merged && !isClosed(i), o);
        if (n > 2) return `${i.id}'s change is on main, but it is still ${i.item.state} after ${n} ticks`;
        if (i.job?.merged && o.started.some((s) => s.item === i.key)) return `a session started on ${i.id}, whose change merged`;
        return null;
      });
    },
  },
  {
    id: "C3",
    why: "A closed Item leaves nothing behind within 2 ticks: no job, no open question, no live session (decision 5), no claim of Scope Soup's.",
    check(o, _prev, memo) {
      return first(o.items, (i) => {
        const left = [i.job ? "a job" : "", (i.host?.openQuestions ?? []).length > 0 ? "an open question" : "", i.live.length > 0 ? "a live session" : "", i.item.holder?.actor.id === OWN ? "Scope Soup's claim" : ""].filter(Boolean);
        // A tick while the host does not answer cannot give the claim back: it does not count.
        const n = ticksSince(memo, `C3|${i.key}`, isClosed(i) && left.length > 0, o, isTick(o) && !o.remote.down);
        return n > 2 ? `${i.id} is ${i.item.state} but still has ${left.join(", ")} after ${n} ticks` : null;
      });
    },
  },
  // --- D. Limits ---
  {
    id: "D1",
    why: "Live sessions never exceed maxParallelSessions as it was when the newest started.",
    check(o) {
      const newest = o.started.at(-1);
      return newest && o.liveCount > newest.limitAtStart ? `${o.liveCount} sessions live, over the limit of ${newest.limitAtStart}` : null;
    },
  },
  {
    id: "D2",
    why: "At most one live session per Item, and the job names it.",
    check(o) {
      return first(o.items, (i) => {
        if (i.live.length > 1) return `${i.id} has ${i.live.length} live sessions`;
        if (i.live.length === 1 && i.job && i.job.sessionId && i.job.sessionId !== i.live[0]!.id) return `${i.id}'s job names session ${i.job.sessionId}, but ${i.live[0]!.id} runs`;
        return null;
      });
    },
  },
  {
    id: "D3",
    why: "Same files: an Item's first implement step does not start while a busy Item has overlapping paths (#187).",
    check(o, prev) {
      return first(o.started, (s) => {
        if (s.role !== "implement") return null;
        const before = prevOf(prev, s.item);
        if (!before?.job || before.job.head || before.job.implement || before.job.implementAskedBy) return null;
        const paths = before.paths;
        // Busy before the tick and still busy after it: a session that ended in this tick and merged its change is over, and the start
        // that follows in the same tick is rightly let go.
        const busyIn = (i: ItemObs, git: Observation["git"]): boolean => !isClosed(i) && !!i.job && isBusy(i.job, !!i.job.head && git.contains(i.job.head, git.main) === true);
        const other = prev!.items.find((i) => i.key !== s.item && busyIn(i, prev!.git) && i.paths.some((p) => paths.includes(p)) && o.items.some((now) => now.key === i.key && busyIn(now, o.git)));
        return other ? `${before.id}'s implement started while ${other.id} is busy on the same paths` : null;
      });
    },
  },
  {
    id: "D4",
    why: "No session of a role starts while its switch is not started or above the level, unless a person picked that step (decisions 104, 105).",
    check(o, prev) {
      if (!prev) return null;
      const level: Record<string, number> = { triage: 1, implement: 2, review: 3 };
      return first(o.started, (s) => {
        const job = prevOf(prev, s.item)?.job;
        const picked = (s.role === "triage" && job?.triageAskedBy) || (s.role === "review" && job?.reviewAskedBy) || (s.role === "implement" && job?.implementAskedBy);
        if (prev.switches[s.role] !== "started" && (!picked || prev.level >= level[s.role]!)) return `a ${s.role} session started on ${s.item.split(":").pop()} while that switch was ${prev.switches[s.role]}`;
        if (!picked && level[s.role]! > prev.level) return `a ${s.role} session started on ${s.item.split(":").pop()} at level ${prev.level}`;
        return null;
      });
    },
  },
  {
    id: "D5",
    why: "No session starts while usage is inside the reserve.",
    check(o, prev) {
      return prev?.usageReserve && o.started.length > 0 ? `a ${o.started[0]!.role} session started while usage was in the reserve` : null;
    },
  },
  {
    id: "D6",
    why: "Budgets are bounded: a failing step is parked as escalated after the configured attempts; no timer is further ahead than the cap or a limit reset.",
    check(o) {
      return first(o.items, (i) => {
        if (!i.job) return null;
        if (i.job.failures > 6) return `${i.id} failed ${i.job.failures} times without being put down for a person`;
        if (i.job.notBefore && Date.parse(i.job.notBefore) - Date.parse(o.at) > 6 * 3600_000) return `${i.id} waits until ${i.job.notBefore}, further than any cap`;
        return null;
      });
    },
  },
  {
    id: "D7",
    why: "What is held matches the jobs: no worktree held for an Item with no job for more than 2 ticks; no session runs without one.",
    check(o, _prev, memo) {
      for (const tree of o.git.worktrees) {
        const i = o.items.find((each) => each.key === tree.item);
        const held = !!i && !i.job && i.live.length === 0;
        const n = ticksSince(memo, `D7|${tree.workspace}`, held, o);
        if (n > 2) return `${tree.workspace} is still held for ${i!.id}, which has no work under way`;
      }
      return first(o.items, (i) => (i.live.length > 0 && !o.git.worktrees.some((t) => t.item === i.key) ? `${i.id} has a live session and no workspace` : null));
    },
  },
  {
    id: "D8",
    why: "A session runs on the Item's newest work: a review reads a branch with commits over main.",
    check(o) {
      return first(o.started, (s) => {
        if (s.role !== "review") return null;
        const head = o.git.branches.get(s.request.branch);
        return !head || o.git.contains(head, o.git.main) === true ? `a review started on ${s.item.split(":").pop()} with an empty branch` : null;
      });
    },
  },
  // --- E. The core rules ---
  {
    id: "E1",
    why: "Nothing irreversible without a person: Items are only added by a person's request, and only branches under scopesoup/ are deleted, besides an agent's leftovers whose commits are all on main or its Item's pushed branch (#236).",
    check(o, prev) {
      const made = o.requests.filter((r) => r.path === "/api/items" && r.status === 200).length;
      if (prev && o.remote.items > prev.remote.items + made) return `${o.remote.items - prev.remote.items - made} Item(s) appeared with no person's request`;
      if (prev && o.remote.items < prev.remote.items) return `an Item disappeared from the host`;
      const bad = o.git.deleted.find((d) => !d.ref.startsWith("refs/heads/scopesoup/") && !(d.madeBy?.scopesoup && d.madeBy.item && !d.unmerged));
      return bad ? `${bad.ref} was deleted` : null;
    },
  },
  {
    id: "E2",
    why: "Append-only: event numbers only grow, earlier events stay as they were, and no log line on the host is changed or removed.",
    check(o, prev) {
      if (o.remote.refusedRewrites > 0) return `a write tried to change or remove a log line on the host`;
      if (o.action.kind === "lose-store") return null;
      if (prev && o.lastSeq < prev.lastSeq) return `the last event number went down from ${prev.lastSeq} to ${o.lastSeq}`;
      if (prev?.firstEvent && o.firstEvent !== prev.firstEvent) return `the first event changed`;
      return o.events.find((e, n) => n > 0 && e.seq <= o.events[n - 1]!.seq) ? "events out of order" : null;
    },
  },
  {
    id: "E3",
    why: "Decisions are surfaced, not made: every answer recorded was sent by the person, or reused from one they sent on the same Item.",
    check(o) {
      const sent = new Set(o.ledger.answers.map((a) => a.text));
      // A person's settling of a rewrite or a move is recorded as an answer in the server's words: it counts if a request of theirs was on that Item.
      const asked = new Set(o.ledger.requests.filter((r) => r.status === 200 && r.item).map((r) => r.item));
      const made = o.answers.find((a) => !sent.has(a.answer) && !/scopesoup/i.test(a.by) && !asked.has(a.subject.id));
      return made ? `an answer "${made.answer.slice(0, 60)}" by ${made.by} on ${made.subject.id} that the person never sent` : null;
    },
  },
  {
    id: "E4",
    why: "Main moves only three ways: a session told to merge, the merge queue, or a person; a session that merged untold is escalated (decision 108).",
    check(o, _prev, memo) {
      // Escalated once is handled: what a person answers to the escalation is theirs to decide.
      const escalated = (memo.escalated ??= {}) as Record<string, true>;
      return first(o.git.mainMoves.filter((m) => m.how === "session untold"), (m) => {
        // Judged by the machine whose implementor merged (multiplayer: another machine's session is that machine's to escalate).
        if (!o.sessions.some((s) => s.role === "implement" && `${s.subject.host}:${s.subject.kind}:${s.subject.id}` === m.item)) return null;
        const i = o.items.find((each) => each.key === m.item);
        // Escalated here, or by another machine (multiplayer): its question line in the Item's shared log says so.
        // (or a person's answer to it there, which names the question it answers).
        const untold = /merged .* although its instructions said to commit and stop/;
        const logged = (i?.item.log ?? []).some((line) => (line.kind === "question" && line.fields.parked === "escalated" && untold.test(String(line.fields.question ?? ""))) || (line.kind === "answer" && untold.test(String(line.fields.toQuestion ?? ""))));
        if (i?.job?.parked?.as === "escalated" || logged) escalated[m.sha] = true;
        const handled = !i || escalated[m.sha] === true || isClosed(i);
        const n = ticksSince(memo, `E4|${m.sha}`, !handled, o);
        return n > 2 ? `${i!.id}'s session merged without being told to and it was not escalated` : null;
      });
    },
  },
  {
    id: "E5",
    why: "Main gets a change once: after the merge queue merged an Item's change, nothing merges for that Item again until it is closed (#238: a level lowered while the queue's drain ran).",
    check(o, _prev, memo) {
      const merged = (memo.merged ??= {}) as Record<string, string>;
      for (const i of o.items) if (isClosed(i)) delete merged[i.key];
      const from = (memo.seen as number | undefined) ?? 0;
      memo.seen = o.git.mainMoves.length;
      for (const m of o.git.mainMoves.slice(from)) {
        if (!m.item) continue;
        if (merged[m.item]) return `${m.item.split(":").pop()}'s change went to main again (${m.how}) after the merge queue merged it (${merged[m.item]!.slice(-7)}), before the Item was closed`;
        if (m.how === "queue") merged[m.item] = m.sha;
      }
      return null;
    },
  },
  // --- F. Events ---
  {
    id: "F1",
    why: "A change of W, of the job's step or of the job's existence has an event with the Item as subject and a reason.",
    check(o, _prev, memo) {
      // Compared at each tick and each request (what Scope Soup or a person did), against the last such step.
      const subjects = ((memo.subjects ??= {}) as Record<string, true>);
      for (const e of o.events) if (e.subject) subjects[e.subject] = true;
      if (!isTick(o) && o.requests.length === 0) return null;
      const last = ((memo.last ??= {}) as Record<string, string>);
      const state = (i: ItemObs): string => `${wText(i.w)}|${i.job?.step ?? "none"}`;
      let found: string | null = null;
      for (const i of o.items) {
        const was = last[i.key];
        const now = state(i);
        last[i.key] = now;
        if (found || was === undefined || was === now) continue;
        const [w0] = was.split("|");
        // Changes that follow from the world alone (the clock, a switch, usage, a slot) are said once on the status line.
        if (w0!.startsWith(`start(`) && now.startsWith("start(") && w0!.split(",")[0] === now.split(",")[0]) continue;
        if (!subjects[i.key]) found = `${i.id} went from ${was.replace("|", " at ")} to ${now.replace("|", " at ")} with no event about it`;
      }
      memo.subjects = {};
      return found;
    },
  },
  {
    id: "F2",
    why: "Every request the server accepted has an event naming the person.",
    check(o, prev) {
      const switched = (r: { path: string }): boolean => !/^\/api\/(pause|resume|stop)$/.test(r.path) || JSON.stringify(o.switches) !== JSON.stringify(prev?.switches);
      // A request that changed nothing (a second claim of an Item one holds) writes nothing at all, rightly.
      if (o.events.length === 0) return null;
      const quiet = o.requests.find((r) => r.status === 200 && switched(r) && !(r.response as { unchanged?: boolean } | null)?.unchanged && !o.events.some((e) => e.actor === "Ada" || JSON.stringify(e.data).includes("Ada")));
      return quiet ? `${quiet.path} on ${quiet.item ?? "-"} was accepted with no event naming the person` : null;
    },
  },
  {
    id: "F3",
    why: "A quiet tick is quiet: a tick run again at once with no input writes no event and changes no job.",
    check(o, prev) {
      if (!isTick(o) || !prev || prev.action.kind !== "tick" || o.action.kind !== "tick") return null;
      const loud = o.events.find((e) => !e.kind.startsWith("work.") && e.kind !== "session.updated");
      if (loud) return `a tick right after a tick wrote ${loud.kind}${loud.subject ? ` about ${loud.subject.split(":").pop()}` : ""}`;
      const changed = o.items.find((i) => JSON.stringify(i.job ?? null) !== JSON.stringify(prevOf(prev, i.key)?.job ?? null));
      return changed ? `a tick right after a tick changed ${changed.id}'s job` : null;
    },
  },
  // --- G. Restart and recovery ---
  {
    id: "G1",
    why: "Restart: every switch is paused, and after the first tick each Item's W is what it was, except that a session became a wait to start the same step (not counted as a failure), or questions that waited for the session to end were written, or the restarts in a row reached the attempts' limit and a person is asked, or questions waiting to be posted again were posted.",
    check(o, prev, memo) {
      if (o.action.kind === "restart" && prev) {
        const on = (["triage", "implement", "review"] as const).find((r) => o.switches[r] === "started");
        if (on) return `after a restart the ${on} switch is started`;
        memo.before = Object.fromEntries(prev.items.map((i) => [i.key, i.w]));
        // A wait that ends by itself at a tick (questions that could not be posted are posted again, #230) is not the restart's.
        memo.reposts = prev.items.filter((i) => i.job?.parked?.retry === "post").map((i) => i.key);
        return null;
      }
      const before = memo.before as Record<string, W> | undefined;
      if (!before) return null;
      // Only what follows from the restart itself is compared: another step in between ends the comparison.
      if (!isTick(o)) {
        if (o.action.kind !== "sync" && o.action.kind !== "clock") delete memo.before;
        return null;
      }
      delete memo.before;
      return first(o.items, (i) => {
        const w = before[i.key];
        if (!w) return null;
        if (w.kind === "session" && w.settling) return null;
        if (((memo.reposts as string[] | undefined) ?? []).includes(i.key)) return null;
        // Questions other Items' agents asked about it wait until no session runs on it and nobody holds it: once that ends they are
        // written, whatever ended it.
        // Or the restarts in a row reached the attempts' limit, and a person is asked (a crash at every start must end).
        const asked = o.events.some((e) => (e.kind === "orchestrator.about_other_written" || e.kind === "orchestrator.restart_limit") && e.subject === i.key);
        if (asked) return null;
        if (w.kind === "session") return i.w.kind === "start" && i.w.role === w.role ? null : `${i.id} had a ${w.role} session before the restart and is ${wText(i.w)} after the first tick`;
        if (["person", "queue", "blocker", "nothing"].includes(w.kind) && wText(w) !== wText(i.w)) return `${i.id} was ${wText(w)} before the restart and is ${wText(i.w)} after the first tick`;
        return null;
      });
    },
  },
  {
    id: "G2",
    why: "A failure in the middle of a tick loses nothing: the tick never throws, and the next one goes on.",
    check(o) {
      return o.tickError ? `the tick threw: ${o.tickError.slice(0, 120)}` : null;
    },
  },
  {
    id: "G3",
    why: "The store is lost: after the read-back no done Item starts again and every open question is open again (long run only).",
    check(o, prev) {
      if (o.action.kind !== "tick" || prev?.action.kind !== "lose-store") return null;
      return first(o.started, (s) => (prev.items.find((i) => i.key === s.item && isClosed(i)) ? `${s.item.split(":").pop()} started again after the store was lost, though it was closed` : null));
    },
  },
  // --- H. Liveness ---
  {
    id: "H1",
    why: "Everything ends: under Fair every Item is merged or closed by the end of the tail (decision 4).",
    check(o) {
      if (!o.final || o.level < 2) return null;
      const stuck = o.items.find((i) => i.w.kind !== "nothing");
      return stuck ? `after the fair tail ${stuck.id} still waits: ${wText(stuck.w)}${stuck.card ? ` ("${stuck.card.reason.slice(0, 80)}")` : ""}` : null;
    },
  },
  {
    id: "H2",
    why: "No ring of waits: following blockers from any Item never comes back to it (decision 106).",
    check(o) {
      const edges = new Map(o.items.filter((i) => !isClosed(i)).map((i) => [i.key, i.w.kind === "blocker" ? i.w.on : []]));
      for (const start of edges.keys()) {
        const seen = new Set<string>();
        const todo = [...(edges.get(start) ?? [])];
        while (todo.length > 0) {
          const next = todo.pop()!;
          if (next === start) return `${start.split(":").pop()} waits for itself through its blockers`;
          if (seen.has(next)) continue;
          seen.add(next);
          todo.push(...(edges.get(next) ?? []));
        }
      }
      return null;
    },
  },
  {
    id: "H3",
    why: "Timed waits end: no job waits for written text past 30 minutes and a tick, and no claim of Scope Soup's outlives 120 minutes without a session or a change in this machine's merge queue (#194, #197, #229).",
    check(o, _prev, memo) {
      return first(o.items, (i) => {
        const writing = i.job?.writing;
        if (writing && Date.parse(o.at) - Date.parse(writing.at) > 31 * 60_000 && isTick(o) && /written|its text|description/i.test(i.card?.reason ?? "")) return `${i.id} still waits for its text, written at ${writing.at}`;
        // A change waiting in this machine's merge queue is work under way here: its claim keeps other machines off it.
        const claimed = i.item.holder?.actor.id === OWN && i.live.length === 0 && i.w.kind !== "queue" && (!i.item.holder.until || i.item.holder.until > o.at);
        const table = (memo.claims ??= {}) as Record<string, string>;
        if (!claimed) delete table[i.key];
        else table[i.key] ??= o.at;
        if (claimed && Date.parse(o.at) - Date.parse(table[i.key]!) > 121 * 60_000) return `Scope Soup's claim on ${i.id} has outlived its session by more than 120 minutes`;
        return null;
      });
    },
  },
  {
    id: "H4",
    why: "No dead end: an Item that waits for a person offers that person something to do (#183).",
    check(o) {
      return first(o.items, (i) => {
        if (i.w.kind !== "person" || i.w.why === "holds" || i.served === undefined) return null;
        const p = i.served;
        if (!p) return `${i.id} waits for a person (${wText(i.w)}) but its page cannot be read`;
        const offered = !!(p.parked?.canAnswer || p.parked?.rewrite || p.parked?.questions?.some((q) => q.answer === undefined) || p.parked?.canStartOver || (p.questions ?? []).length > 0 || p.proposedRewrite || Object.values(p.moves ?? {}).some((m) => m && !m.why));
        return offered ? null : `${i.id} waits for a person (${wText(i.w)}) but its page offers nothing to do`;
      });
    },
  },
  {
    id: "H5",
    why: "One Item never holds up another: an Item waiting only for a slot starts in the next tick when one is free.",
    check(o, prev) {
      if (!isTick(o) || !prev || !o.tick) return null;
      const free = prev.slots - prev.liveCount - o.started.length;
      if (free <= 0) return null;
      // An Item whose paths overlap one that started implement in this tick waits for the same files, rightly.
      const overlaps = (i: ItemObs): boolean => o.started.some((s) => s.role === "implement" && (prevOf(prev, s.item)?.paths ?? []).some((p) => i.paths.includes(p)));
      // The host did not answer: claims cannot be written, so nothing may start.
      if (prev.remote.down || o.remote.down) return null;
      const waiting = prev.items.find((i) => i.w.kind === "start" && i.w.cause === "slot" && !overlaps(i) && !o.started.some((s) => s.item === i.key) && (() => { const now = o.items.find((each) => each.key === i.key)?.w; return now?.kind === "start" && now.cause === "slot"; })());
      return waiting ? `${waiting.id} waited only for a slot, a slot was free, and the tick did not start it (now ${wText(o.items.find((each) => each.key === waiting.key)!.w)})` : null;
    },
  },
  // --- I. Footprint ---
  {
    id: "I1",
    why: "Everything belongs somewhere: each branch, worktree, tag and stash Scope Soup or its agents made belongs to an Item that exists.",
    check(o) {
      const known = new Set([...o.items.map((i) => i.key), ...(o.hostRead?.items.keys() ?? [])]);
      for (const [ref, madeBy] of o.git.owners) {
        if (!madeBy.scopesoup || !madeBy.item || known.has(madeBy.item)) continue;
        if (ref.startsWith("refs/heads/") && !o.git.branches.has(ref.slice(11))) continue;
        if (ref.startsWith("refs/tags/") && !o.git.tags.has(ref.slice(10))) continue;
        if (ref.startsWith("worktree:") && !o.git.worktrees.some((t) => `worktree:${t.workspace}` === ref)) continue;
        return `${ref} belongs to ${madeBy.item}, which is not an Item`;
      }
      return null;
    },
  },
  {
    id: "I2",
    why: "Done means gone: within 2 ticks after its Item ends, what Scope Soup and its agents left for it is removed (worktree, tags, stash, extra branches), or, when it holds work found nowhere else, kept and reported on the Item with its sha (#236).",
    check(o, _prev, memo) {
      // Reported as kept: `ref@sha`, from the events since the start.
      const reported = (memo.leftoversKept ??= {}) as Record<string, true>;
      for (const e of o.events) {
        const data = (e.data ?? {}) as Record<string, unknown>;
        if (e.kind === "orchestrator.leftover_kept") reported[`${String(data.ref)}@${String(data.sha)}`] = true;
      }
      const excused = (key: string, ref: string, sha: string | undefined): boolean => o.git.unique.has(key) && !!reported[`${ref}@${sha}`];
      return first(o.items, (i) => {
        const left: string[] = [];
        for (const t of o.git.worktrees) if (t.item === i.key) left.push(`worktree ${t.workspace}`);
        for (const [ref, madeBy] of o.git.owners) {
          if (madeBy.item !== i.key || !madeBy.scopesoup) continue;
          if (ref.startsWith("refs/tags/") && o.git.tags.has(ref.slice(10)) && !excused(ref, ref, o.git.tags.get(ref.slice(10)))) left.push(ref);
          if (ref.startsWith("refs/heads/") && ref !== `refs/heads/scopesoup/${i.id}` && o.git.branches.has(ref.slice(11)) && !excused(ref, ref, o.git.branches.get(ref.slice(11)))) left.push(ref);
        }
        if (o.git.stash.some((s) => s.item === i.key && s.scopesoup && !excused(`stash:${s.sha}`, "refs/stash", s.sha))) left.push("a stash entry");
        const n = ticksSince(memo, `I2|${i.key}`, isClosed(i) && left.length > 0, o);
        return n > 2 ? `${i.id} is ${i.item.state} but ${left.join(", ")} is still there after ${n} ticks` : null;
      });
    },
  },
  {
    id: "I3",
    why: "Bounded: Scope Soup's branches and worktrees stay proportional to open Items and slots, never to the project's history.",
    check(o) {
      const hostOpen = [...(o.hostRead?.items.values() ?? [])].filter((w) => w.state !== "done" && w.state !== "abandoned").length;
      const open = Math.max(hostOpen, o.items.filter((i) => !isClosed(i)).length);
      const ours = [...o.git.branches.keys()].filter((b) => b.startsWith("scopesoup/")).length + o.git.worktrees.length;
      const bound = 3 * open + 2 * o.slots + 4;
      return ours > bound ? `${ours} branches and worktrees of Scope Soup's for ${open} open Items (bound ${bound})` : null;
    },
  },
  {
    id: "I4",
    why: "Merged is the host's word, not ancestry: a branch with work that did not land is never deleted.",
    check(o, prev) {
      // Judged when it happens: a reopen later does not undo the person's close the deletion followed.
      const lost = o.git.deleted.slice(prev?.git.deleted.length ?? 0).find((d) => d.unmerged && d.madeBy?.scopesoup);
      if (!lost) return null;
      const i = o.items.find((each) => each.key === lost.madeBy?.item);
      // A person closed the Item: its work is theirs to throw away.
      if (i && o.ledger.closesAsked.has(i.key)) return null;
      return `${lost.ref} was deleted with work on it that is not on main`;
    },
  },
  {
    id: "I5",
    why: "An agent's leftovers do not travel: a session never starts in a worktree with another Item's uncommitted files.",
    check(o) {
      return first(o.started, (s) => {
        const tree = o.git.worktrees.find((t) => t.workspace === s.request.workspace);
        return tree && tree.item !== s.item && (tree.dirty.length > 0 || tree.untracked.length > 0) ? `${s.item.split(":").pop()} started in a worktree with ${tree.item.split(":").pop()}'s files` : null;
      });
    },
  },
  {
    id: "I6",
    why: "Nothing outside Scope Soup's own: branches, tags and stashes Scope Soup did not create, also those a person makes while an Item runs, are never touched, nor reported as an agent's (#236).",
    check(o, _prev, memo) {
      // Every ref and stash entry of a person's seen so far.
      const seen = (memo.persons ??= {}) as Record<string, string>;
      for (const [ref, madeBy] of o.git.owners) {
        if (madeBy.scopesoup || ref.startsWith("worktree:")) continue;
        const sha = ref.startsWith("refs/tags/") ? o.git.tags.get(ref.slice(10)) : o.git.branches.get(ref.slice(11));
        if (sha !== undefined) seen[ref] ??= sha;
      }
      for (const s of o.git.stash) if (!s.scopesoup) seen[`stash:${s.sha}`] ??= s.sha;
      for (const ref of Object.keys(seen)) {
        const there = ref.startsWith("stash:") ? o.git.stash.some((s) => `stash:${s.sha}` === ref) : ref.startsWith("refs/tags/") ? o.git.tags.has(ref.slice(10)) : o.git.branches.has(ref.slice(11));
        if (!there) return `${ref}, a person's, is gone`;
      }
      const named = o.events.find((e) => {
        if (!e.kind.startsWith("orchestrator.leftover_")) return false;
        const data = (e.data ?? {}) as Record<string, unknown>;
        return data.ref === "refs/stash" ? !!seen[`stash:${String(data.sha)}`] : typeof data.ref === "string" && !!seen[data.ref];
      });
      if (named) {
        const data = (named.data ?? {}) as Record<string, unknown>;
        return `${String(data.ref)} (${String(data.sha).slice(0, 7)}), a person's, was reported as an agent's leftover (${named.kind})`;
      }
      return null;
    },
  },
  // --- J. Backlog and To do (#221) ---
  // These turn on by themselves once the board has a To do lane in front of the agents' lanes (#221); until then they hold for nothing.
  {
    id: "J1",
    why: "An agent never starts work on an Item in Backlog: agents start only from To do (#221). A person's Triage there is theirs: one triage runs, and the Item stays.",
    check(o, prev) {
      if (!todoLane(o) || !prev) return null;
      return first(o.started, (s) => {
        if (prevOf(prev, s.item)?.card?.lane !== "backlog") return null;
        const id = s.item.split(":").pop();
        const asked = s.role === "triage" && o.ledger.requests.some((r) => r.status === 200 && r.item === id && r.path === "/api/item/move" && r.body.to === "triage");
        return asked ? null : `a ${s.role} session started on ${id}, which was in Backlog`;
      });
    },
  },
  {
    id: "J2",
    why: "Only a person moves an Item into To do (#221): the lane itself, or what puts work under way, which is never in Backlog (a claim, a hand-back, Implement anyway).",
    check(o, prev) {
      const todo = todoLane(o);
      if (!todo || !prev) return null;
      return first(o.items, (i) => {
        const before = prevOf(prev, i.key)?.card?.lane;
        if (i.card?.lane !== todo || before !== "backlog") return null;
        const moved = o.requests.some((r) => r.status === 200 && r.item === i.id && personIntoTodo(r));
        return moved ? null : `${i.id} moved from Backlog to To do with no person's move`;
      });
    },
  },
  {
    id: "J3",
    why: "Nothing an agent creates lands in To do; new Items land in Backlog unless a person files them in To do (#221).",
    check(o, prev, memo) {
      // New is new to the run: an Item read back after the store was lost was seen before.
      const seen = (memo.seen ??= {}) as Record<string, true>;
      const before = { ...seen };
      for (const i of o.items) seen[i.key] = true;
      const todo = todoLane(o);
      if (!todo || !prev) return null;
      return first(o.items, (i) => {
        if (before[i.key] || prevOf(prev, i.key) || i.card?.lane !== todo) return null;
        const filed = o.requests.some((r) => r.status === 200 && r.path === "/api/items" && r.body.todo === true);
        return filed ? null : `${i.id} is new and landed in To do`;
      });
    },
  },
];

/** A person's request that takes an Item into To do (#221): the lane edit or pick, a claim, a hand-back, Implement anyway. */
function personIntoTodo(r: { path: string; body: Record<string, unknown> }): boolean {
  if (r.path === "/api/item/edit") return r.body.lane === "todo";
  if (r.path === "/api/item/claim" || r.path === "/api/item/handback") return true;
  if (r.path === "/api/item/move") return r.body.to === "implement";
  if (r.path === "/api/item/pick") {
    const steps = Array.isArray(r.body.steps) ? (r.body.steps as Record<string, unknown>[]) : [];
    return steps.some((step) => (step.kind === "lane" && step.lane === "todo") || step.kind === "claim" || (step.kind === "move" && step.to === "implement"));
  }
  return false;
}

/** The To do lane's id, once the board has one (#221); undefined before. */
function todoLane(o: Observation): string | undefined {
  return o.lanes.find((lane) => lane === "todo" || lane === "to-do");
}

export const RULE_IDS = RULES.map((rule) => rule.id);
