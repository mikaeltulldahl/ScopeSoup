// The orchestrator's actions carried out on a real host: claim and release an item, say on the host
// what happened, close a merged item, and add lines to an item's own log (meta branch). Used only
// when writes are switched on.

import { createHash } from "node:crypto";
import type { ProjectConfig } from "../config/types.ts";
import { aiLabelOf } from "../config/types.ts";
import type { Assumption, AssumptionSettled, DecisionOption, LabelChange, Ref, WorkItem } from "../model/types.ts";
import type { AssumptionOutcome, AssumptionPick } from "./assumptions.ts";
import { overturnedBy, overturnItem, splitAssumptionId } from "./assumptions.ts";
import { overturnsFor, takesOverturn } from "./overturns.ts";
import { holdStands } from "../model/people.ts";
import { refKey } from "../model/types.ts";
import type { AnswerWrite, AssumptionWrite, RewriteWrite, Host, QuestionWrite, WorkPatch } from "../ports/host.ts";
import { AlreadyAnswered } from "../ports/host.ts";
import type { Store } from "../store/store.ts";
import type { Actions } from "./ports.ts";
import { inertText } from "./hostText.ts";
import { isOwnLabel } from "../model/labels.ts";
import { loadJobs } from "./jobs.ts";
import type { Git } from "./process.ts";

export interface HostActionsDeps {
  host: Host;
  git: Git;
  config: () => ProjectConfig;
  store: Store;
}

/** The writer of the orchestrator's lines in an item's log. `recover.ts` reads back only these. */
export const SCOPESOUP = { who: "scopesoup", agent: true };

/** An answer made inert before it goes on a host. */
const inertAnswer = (answer: AnswerWrite): AnswerWrite => ({
  ...answer, answer: inertText(answer.answer),
  ...(answer.question ? { question: inertText(answer.question) } : {}), ...(answer.options ? { options: answer.options.map(inertText) } : {}),
  ...(answer.by ? { by: inertText(answer.by) } : {}),
});

/**
 * The lines Scope Soup writes to an item's log comment on GitHub. Questions, answers, claims and merges have comments of their
 * own. `duplicate` names the issue a duplicate was closed for, which GitHub does not say.
 */
const HOST_LOG_KINDS = new Set(["session", "revision", "review", "check", "edited", "duplicate"]);

/** Every string in a log line's fields made inert, however deep. */
function inertFields(value: unknown): unknown {
  if (typeof value === "string") return inertText(value);
  if (Array.isArray(value)) return value.map(inertFields);
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([name, each]) => [name, inertFields(each)]));
  return value;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The words the log comment's `edited` line uses for the fields of a patch. */
const FIELD_WORDS: Record<string, string> = { title: "title", body: "description", verification: "verification", state: "state", priority: "priority", blockedBy: "blocked by" };

const SIGNATURE ="\n\n---\n_Written by Scope Soup._";

const ASK_TITLES: Record<Parameters<Actions["answerTurn"]>[1], string> = {
  decision: "A decision is needed",
  escalation: "The agents could not finish this",
  "not-ready": "This is not ready to start",
  handover: "Waiting for you to merge it",
};

/**
 * Items of another host (or of none) are left alone: every action is then a no-op, so a
 * project can mix items Scope Soup may write about with items it may not.
 */
export function createHostActions(deps: HostActionsDeps): Actions {
  const { host } = deps;
  const write = host.write;
  const mine = (ref: Ref): boolean => ref.host === host.info.id;
  /** The item as the host has it now, into the store. */
  const reread = async (item: Ref): Promise<void> => {
    const after = await host.work?.getWork(item);
    if (after) deps.store.put(after, "sync", new Date().toISOString());
  };
  /**
   * A line in the item's log comment (GitHub). A failed write is `orchestrator.host_write_failed` and nothing more: nothing
   * is queued, and the step it tells of goes on without it (a missing log line costs only a recovery after a store loss).
   */
  const logOnHost = async (item: Ref, kind: string, fields: Record<string, unknown>): Promise<void> => {
    if (!write?.logLine || !HOST_LOG_KINDS.has(kind)) return;
    try {
      await write.logLine(item, { kind, fields: inertFields(fields) as Record<string, unknown> });
    } catch (error) {
      const reason = `Could not write the ${kind} line to the log comment of ${item.id} on ${item.host}: ${error instanceof Error ? error.message : String(error)} The step goes on without it.`;
      deps.store.appendEvent({ kind: "orchestrator.host_write_failed", subject: refKey(item), actor: "orchestrator", data: { reason } }, new Date().toISOString());
    }
  };
  /** The decisions of an `assumption` line as one comment (GitHub), made inert; a failure is an event, and the step goes on. */
  const postAssumptions = async (item: Ref, fields: Record<string, unknown>): Promise<void> => {
    if (!write?.postAssumptions) return;
    const decisions = (Array.isArray(fields.decisions) ? fields.decisions : []) as AssumptionWrite[];
    try {
      await write.postAssumptions(item, decisions.map((each) => ({ question: inertText(each.question), chosen: inertText(each.chosen), others: each.others.map(inertText), why: inertText(each.why) })));
      await reread(item);
    } catch (error) {
      const reason = `Could not post the implementor's decisions on ${item.id} on ${item.host}: ${error instanceof Error ? error.message : String(error)} The step goes on without them.`;
      deps.store.appendEvent({ kind: "orchestrator.host_write_failed", subject: refKey(item), actor: "orchestrator", data: { reason } }, new Date().toISOString());
    }
  };
  /**
   * The verdicts of one Send in one write: into their decisions' comment (GitHub), or one commit of `accepted` / `overturned` lines
   * naming them (meta branch).
   */
  const settleAll = async (item: Ref, settles: { id: string; settled: AssumptionSettled }[]): Promise<void> => {
    if (write?.settleAssumptions) {
      return write.settleAssumptions(item, settles.map(({ id, settled }) => ({ id, settled: { ...settled, by: inertText(settled.by), ...(settled.answer ? { answer: inertText(settled.answer) } : {}) } })));
    }
    const lines = settles.map(({ id, settled }) => {
      const place = splitAssumptionId(id);
      if (!write?.appendLog || !place) throw new Error(`Decision ${id} cannot be settled on ${item.host}.`);
      return {
        kind: settled.verdict, by: { who: settled.by, agent: false },
        fields: { to: place.record, n: place.n, ...(settled.answer ? { answer: settled.answer } : {}), ...(settled.item ? { item: settled.item.id } : {}), ...(settled.work ? { work: true } : {}) },
      };
    });
    if (lines.length > 1 && write?.appendLogs) await write.appendLogs(item, lines);
    else for (const line of lines) await write!.appendLog!(item, line);
  };
  /** The machine Scope Soup's claims name: a log per machine (meta branch), or claim comments (GitHub). */
  const claimMachine = host.info.machine ?? host.info.claimMachine;
  /** The sha256 of the item's description as the store has it, before Scope Soup changes it: the `edited` line's `wasSha`. */
  const wasSha = (item: Ref): string => sha256((deps.store.get<WorkItem>(item)?.body ?? "").trim());

  return {
    // A host that keeps a log per item gets the lines. On GitHub a claim is a comment and the `scopesoup:claimed` label.
    ...(claimMachine ? { claimant: `${SCOPESOUP.who}@${claimMachine}` } : {}),
    // Claims are written by themselves where other machines can see them: a shared meta branch, or claim comments on GitHub.
    // Read each time: a meta branch is shared only in multiplayer, which can be switched while Scope Soup runs.
    get claims(): true | undefined {
      return host.info.claimMachine || (host.info.machine && host.info.shared) ? true : undefined;
    },
    async claim(item, until, at) {
      if (!mine(item)) return { won: true };
      if (write?.claim) {
        // Written, renewed and checked by the host; the re-read goes into the store, so the next tick sees the new `until`.
        const outcome = await write.claim(item, { until, shown: inertText(claimMachine ?? "") });
        await reread(item);
        return outcome;
      }
      if (!write?.appendLog) return { won: true };
      const me = host.info.machine ? `${SCOPESOUP.who}@${host.info.machine}` : undefined;
      // Look before writing: a claim written over another machine's live claim would only be ordered by the two clocks.
      const before = (await host.work?.getWork(item))?.holder;
      if (before && me && before.actor.id !== me && holdStands(before, Date.parse(at))) return { won: false, why: `held by ${before.actor.name}` };
      const outcome = await write.appendLog(item, { kind: "claimed", by: SCOPESOUP, fields: { until } });
      // Other machines see the claim only once it is shared; one that is not shared protects nothing.
      if (outcome.shared === "pending") return { won: false, why: `the claim could not be shared with the other machines${outcome.problem ? ` (${outcome.problem})` : ""}` };
      // The claim is written and shared; the fold of the log says whose it is. The earliest claim stands.
      const holder = (await host.work?.getWork(item))?.holder;
      if (holder && me && holder.actor.id !== me) return { won: false, why: `held by ${holder.actor.name}` };
      return { won: true };
    },
    async release(item, reason) {
      if (!mine(item)) return;
      if (write?.releaseClaim) {
        await write.releaseClaim(item, { shown: inertText(claimMachine ?? "") });
        await reread(item);
        return;
      }
      if (!write?.appendLog) return;
      await write.appendLog(item, { kind: "released", by: SCOPESOUP, fields: { reason } });
    },

    async answerTurn(item, kind, reason) {
      if (!mine(item) || !write?.comment) return;
      await write.comment(item, `**${ASK_TITLES[kind]}**\n\n${inertText(reason)}\n\nAnswer on Scope Soup's board, on this item's page.${SIGNATURE}`);
    },

    async closeMerged(item, merged) {
      if (!mine(item)) return "not-needed";
      if (!write?.closeWork) return write?.appendLog ? "not-needed" : "by-hand";
      const where = `${merged.target} as ${merged.sha.slice(0, 7)}${merged.batch !== undefined ? ` in batch ${merged.batch}` : ""}`;
      // The comment carries the `merged` marker where the host reads it back (GitHub).
      await write.closeWork(item, inertText(`Merged on ${where}. Closing this item.`) + SIGNATURE, merged);
      return "closed";
    },

    // Where Scope Soup keeps the item's log (meta branch) the field is its own. On GitHub (decision 49) the blockers are the issue's
    // dependencies, only added (a triage never removes one); the re-read goes into the store at once, so the tick that wrote
    // it sees the Item blocked.
    ...(write?.addBlockers && !write.appendLog
      ? {
        async addBlockers(item: Ref, blockers: Ref[]) {
          if (!mine(item)) return;
          const added = blockers.filter((each) => each.host === item.host);
          if (added.length === 0) return;
          await write.addBlockers!(item, added);
          await logOnHost(item, "edited", { changed: ["blocked by"], via: "triage" });
          const after = await host.work?.getWork(item);
          if (after) deps.store.put(after, "sync", new Date().toISOString());
        },
      }
      : {}),
    ...(write?.appendLog && write.editWork
      ? {
        async addBlockers(item: Ref, blockers: Ref[]) {
          if (!mine(item)) return;
          const current = await host.work?.getWork(item);
          if (!current) return;
          const have = new Set(current.blockedBy.map((each) => each.id));
          const added = blockers.filter((each) => each.host === item.host && !have.has(each.id));
          if (added.length === 0) return;
          await write.editWork!(item, { blockedBy: [...current.blockedBy, ...added] });
          await write.appendLog!(item, { kind: "edited", by: SCOPESOUP, fields: { changed: ["blocked by"], via: "triage" } });
        },
      }
      : {}),

    // Scope Soup's own edits of a GitHub issue (an Accept or Edit of a triage rewrite, the board's edit), written
    // through. New text is made inert like all host text. Not on a host that keeps its own log (meta branch): the board writes there.
    ...(write?.editWork && !write.appendLog
      ? {
        async replaceDescription(item: Ref, text: string) {
          if (!mine(item)) return false;
          const was = wasSha(item);
          await write.editWork!(item, { body: inertText(text) });
          const round = loadJobs(deps.store)[refKey(item)]?.rewrite?.round;
          await logOnHost(item, "edited", { changed: ["description"], via: round ? `triage, round ${round}` : "triage", wasSha: was });
          return true;
        },
        // A person answered "close as a duplicate": `state_reason: "duplicate"` with the target, then the `duplicate` line.
        async closeDuplicate(item: Ref, of: Ref) {
          if (!mine(item) || of.host !== item.host) return false;
          await write.editWork!(item, { state: "abandoned", duplicateOf: of });
          await logOnHost(item, "duplicate", { of: of.id });
          await reread(item);
          return true;
        },
        async editItem(item: Ref, patch: WorkPatch) {
          if (!mine(item)) return false;
          const inert: WorkPatch = { ...patch };
          if (patch.body !== undefined) inert.body = inertText(patch.body);
          if (patch.verification) inert.verification = inertText(patch.verification);
          const was = wasSha(item);
          await write.editWork!(item, inert);
          const changed = Object.keys(patch).filter((field) => patch[field as keyof WorkPatch] !== undefined).map((field) => FIELD_WORDS[field] ?? field);
          await logOnHost(item, "edited", { changed, via: "board", ...(patch.body !== undefined ? { wasSha: was } : {}) });
          return true;
        },
      }
      : {}),

    // Questions and answers on GitHub are comments, written through and made inert; the re-read goes into the store at once.
    ...(write?.askQuestions && write.answerQuestion && write.settleQuestions
      ? {
        async askQuestions(item: Ref, questions: QuestionWrite[]) {
          if (!mine(item)) return null;
          const inertOption = (option: DecisionOption): DecisionOption => (typeof option === "string" ? inertText(option) : { label: inertText(option.label), description: inertText(option.description) });
          const asked = await write.askQuestions!(item, questions.map((each) => ({
            ...each, question: inertText(each.question), options: each.options.map(inertOption),
            ...(each.recommendation ? { recommendation: inertText(each.recommendation) } : {}), ...(each.context ? { context: inertText(each.context) } : {}),
            ...(each.proposal
              ? {
                proposal: {
                  reason: inertText(each.proposal.reason),
                  id: each.proposal.id,
                  original: each.proposal.original,
                  parts: each.proposal.parts.map((part) => ({ ...part, title: inertText(part.title), description: inertText(part.description), verification: inertText(part.verification) })),
                  ...(each.proposal.carried ? { carried: inertText(each.proposal.carried) } : {}),
                },
              }
              : {}),
          })));
          await reread(item);
          return asked;
        },
        async answerQuestion(item: Ref, to: string | null, answer: AnswerWrite) {
          if (!mine(item)) return null;
          const done = await write.answerQuestion!(item, to, inertAnswer(answer));
          await reread(item);
          return done;
        },
        // The answers of one Send, in one comment.
        ...(write.answerQuestions
          ? {
            async answerQuestions(item: Ref, answers: { to: string | null; answer: AnswerWrite }[]) {
              if (!mine(item)) return null;
              const done = await write.answerQuestions!(item, answers.map((each) => ({ to: each.to, answer: inertAnswer(each.answer) })));
              await reread(item);
              return done;
            },
          }
          : {}),
        async settleQuestions(item: Ref) {
          if (mine(item)) await write.settleQuestions!(item);
        },
      }
      : {}),
    // Deleted questions are kept in the log comment, and the other open ones withdrawn; the re-read goes into the store at once.
    ...(write?.withdrawQuestions
      ? {
        async withdrawQuestions(item: Ref, deleted: { question: string; n?: number }[]) {
          if (!mine(item)) return;
          await write.withdrawQuestions!(item, deleted.map((each) => ({ ...each, question: inertText(each.question) })));
          await reread(item);
        },
      }
      : {}),

    // The labels a triage may propose: the repository's list (GitHub), or every label the host's items have (meta branch).
    ...(host.work?.labels || (write?.appendLog && write.editWork)
      ? {
        async repoLabels(item: Ref) {
          if (!mine(item)) return null;
          if (host.work?.labels) return host.work.labels();
          const names = new Map<string, string>();
          for (const each of deps.store.list<WorkItem>("work", host.info.id)) for (const name of each.labels) if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
          return [...names.values()].sort((a, b) => a.localeCompare(b)).map((name) => ({ name }));
        },
      }
      : {}),
    // A rewrite's label changes on GitHub at Accept: one call per label, the re-read, a log line; the re-read goes into the store.
    ...(write?.changeLabels
      ? {
        async changeLabels(item: Ref, change: LabelChange) {
          if (!mine(item)) return null;
          // Scope Soup's own labels are its code's to set, never a rewrite's.
          const done = await write.changeLabels!(item, change.add.filter((name) => !isOwnLabel(name)), change.remove.filter((name) => !isOwnLabel(name)));
          // The AI label is the project's own choice, not one of the repository's labels a triage may pick: put on if the host kept it out.
          const ai = aiLabelOf(deps.config());
          const wantsAi = ai !== undefined && change.add.some((name) => name.toLowerCase() === ai.toLowerCase());
          if (wantsAi && write.setLabels && !done.added.some((name) => name.toLowerCase() === ai.toLowerCase())) {
            const have = ((await host.work?.getWork(item)) ?? deps.store.get<WorkItem>(item))?.labels ?? [];
            if (!have.some((name) => name.toLowerCase() === ai.toLowerCase())) {
              await write.setLabels(item, [ai], []);
              done.added.push(ai);
            }
          }
          if (done.added.length > 0 || done.removed.length > 0) {
            const round = loadJobs(deps.store)[refKey(item)]?.rewrite?.round;
            await logOnHost(item, "edited", { changed: ["labels"], via: round ? `triage, round ${round}` : "triage", ...(done.added.length > 0 ? { added: done.added } : {}), ...(done.removed.length > 0 ? { removed: done.removed } : {}) });
          }
          await reread(item);
          return done;
        },
      }
      : {}),

    // Each triage round's rewrite is a comment on GitHub; Accept first checks that the body is still the one it read.
    ...(write?.postRewrite && write.checkRewrite
      ? {
        async postRewrite(item: Ref, rewrite: RewriteWrite) {
          if (!mine(item)) return null;
          return write.postRewrite!(item, { ...rewrite, text: inertText(rewrite.text) });
        },
        async checkRewrite(item: Ref, id: string) {
          if (mine(item)) await write.checkRewrite!(item, id);
        },
      }
      : {}),

    // A person's Accept and Overturn of decisions an implementor took itself, sent together, where the host keeps them.
    ...(write?.settleAssumptions || write?.appendLog
      ? (() => {
        const onLog = write.appendLog !== undefined;
        /** The item as the host has it now, and its decision `id`. */
        const decisionOf = async (item: Ref, id: string): Promise<{ current: WorkItem; decision: Assumption }> => {
          const current = (await host.work?.getWork(item)) ?? deps.store.get<WorkItem>(item);
          const decision = current?.assumptions?.find((each) => each.id === id);
          if (!current || !decision) throw new Error(`There is no decision ${id} on ${item.id}.`);
          return { current, decision };
        };
        /** The Item an overturn files, into the store at once, so a second Send finds it by its mark. */
        const fileOverturn = async (current: WorkItem, decision: Assumption, answer: string, by: string): Promise<Ref> => {
          const item = current.ref;
          const made = overturnItem(current, decision, answer);
          const aiLabel = aiLabelOf(deps.config());
          const created = await write.createWork!({
            title: inertText(made.title), body: inertText(made.body), verification: inertText(made.verification),
            ...(aiLabel ? { labels: [aiLabel] } : {}),
            // The rework waits for the change it reworks (metaBranch: a blocker in the item; GitHub: the issue dependency below).
            ...(onLog && !made.merged ? { blockedBy: [item] } : {}),
            ...(onLog ? { log: [{ kind: "created", by: { who: by, agent: false } }] } : {}),
          });
          const ref = created.work;
          await reread(ref);
          if (!onLog && !made.merged && write.addBlockers) {
            try {
              await write.addBlockers(ref, [item]);
            } catch (error) {
              deps.store.appendEvent({ kind: "orchestrator.host_write_failed", subject: refKey(ref), actor: "orchestrator", data: { reason: `Could not write ${ref.id} blocked by ${item.id}: ${error instanceof Error ? error.message : String(error)}` } }, new Date().toISOString());
            }
          }
          return ref;
        };
        return {
          async settleAssumptions(item: Ref, picks: AssumptionPick[], by: string): Promise<AssumptionOutcome[] | null> {
            if (!mine(item)) return null;
            const current = (await host.work?.getWork(item)) ?? deps.store.get<WorkItem>(item);
            if (!current) throw new AlreadyAnswered(`There is no item ${item.id}.`);
            // One that is gone or settled refuses them all, before anything is written.
            const decisions = picks.map((pick) => {
              const decision = current.assumptions?.find((each) => each.id === pick.id);
              if (!decision) throw new AlreadyAnswered(`There is no decision ${pick.id} on ${item.id}.`);
              if (decision.settled) throw new AlreadyAnswered(`Decision ${pick.id} on ${item.id} is ${decision.settled.verdict} already.`);
              return decision;
            });
            const key = refKey(item);
            const job = loadJobs(deps.store)[key];
            const kept = new Set([...overturnsFor(deps.store, key).map((each) => each.id), ...(job?.overturned ?? [])]);
            const outcomes: AssumptionOutcome[] = picks.map((pick, index): AssumptionOutcome => {
              if (pick.action === "accept") return { id: pick.id, verdict: "accepted" };
              const decision = decisions[index]!;
              // Sent again after the verdicts could not be written: the Item filed then (its body carries the decision's mark, and the
              // store has it, re-read right after it was made or synced since) is reused, so no second one is filed.
              const filed = overturnedBy(deps.store.list<WorkItem>("work", host.info.id), current, decision);
              if (filed) return { id: pick.id, verdict: "overturned", item: filed.ref, reused: true };
              // The change has not merged: the answer goes into the running work; the caller keeps it with the picks.
              if (kept.has(decision.id) || takesOverturn(job, current)) return { id: pick.id, verdict: "overturned", work: true };
              return { id: pick.id, verdict: "overturned" };
            });
            const toFile = outcomes.flatMap((outcome, index) => (outcome.verdict === "overturned" && !outcome.item && !outcome.work ? [index] : []));
            if (toFile.length > 0 && !write.createWork) throw new Error(`${item.host} cannot file the Item an Overturn makes once the change is out of the implementor's hands.`);
            for (const index of toFile) outcomes[index]!.item = await fileOverturn(current, decisions[index]!, picks[index]!.answer ?? "", by);
            const at = new Date().toISOString();
            await settleAll(item, outcomes.map((outcome, index) => ({
              id: outcome.id,
              settled: { verdict: outcome.verdict, at, by, ...(outcome.verdict === "overturned" ? { answer: (picks[index]!.answer ?? "").trim() } : {}), ...(outcome.item ? { item: outcome.item } : {}), ...(outcome.work ? { work: true as const } : {}) },
            })));
            await reread(item);
            return outcomes;
          },
          ...(write.createWork
            ? {
              async reworkOverturn(item: Ref, id: string, answer: string, by: string): Promise<Ref | null> {
                if (!mine(item)) return null;
                const { current, decision } = await decisionOf(item, id);
                const filed = overturnedBy(deps.store.list<WorkItem>("work", host.info.id), current, decision);
                if (filed) return filed.ref;
                return fileOverturn(current, decision, answer, by);
              },
            }
            : {}),
        };
      })()
      : {}),

    async appendLog(item, kind, fields) {
      if (!mine(item)) return;
      // On GitHub the decisions are a comment of their own with the `scopesoup:assumption` label; a failure does not stop the step.
      if (kind === "assumption" && !write?.appendLog) return postAssumptions(item, fields);
      // On GitHub the line goes into the item's one log comment; a failure does not stop the step.
      if (!write?.appendLog) return logOnHost(item, kind, fields);
      // A line not shared yet goes with the meta ref's next push; the sharing report says why it waits.
      await write.appendLog(item, { kind, by: SCOPESOUP, fields });
    },
  };
}
