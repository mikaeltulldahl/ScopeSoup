// Demo mode: the board over an in-memory store filled with SYNTHETIC data for an imaginary
// project (a tide-table app). Nothing here comes from a real project. Run: pnpm demo
//
// The demo has a project configuration of its own in a temporary folder (level 4, machine "demo"), so the Settings page and
// the levels show; saving there changes only that folder (its private file, or a commit on its own repository's meta ref), which is deleted when the demo stops. The chat with an Item's
// sessions is the real one over a fake runner that answers each turn with a short canned reply: no agent CLI runs.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConfigLoader } from "../config/loader.ts";
import { type MetaSettings, metaSettings } from "../config/metaSettings.ts";
import { execFileSyncRetrying } from "../hosts/spawnRetry.ts";
import type { ProjectConfig } from "../config/types.ts";
import { at as plus, batch, change, member, ref, run, session, verdict, work } from "../core/testing.ts";
import type { DiffView } from "../core/views.ts";
import type { LogEntry } from "../hosts/metaBranch/log.ts";
import { actorOf, describeLine } from "../hosts/metaBranch/map.ts";
import type { Assumption, Change, LogRecord, LogWriter, Ref, Restructuring, Run, Runner, Session, WorkItem } from "../model/types.ts";
import type { RemoteBranches } from "../items/remoteBranch.ts";
import type { LogLineInput, WorkPort, WriteOutcome, WritePort } from "../ports/host.ts";
import type { AssumptionOutcome } from "../orchestrator/assumptions.ts";
import { overturnedBy, overturnItem } from "../orchestrator/assumptions.ts";
import { overturnsFor, takesOverturn } from "../orchestrator/overturns.ts";
import { AlreadyAnswered } from "../ports/host.ts";
import { refKey } from "../model/types.ts";
import type { Chat, ChatRunner, ChatTurn } from "../orchestrator/chat.ts";
import { chatKey, createChat } from "../orchestrator/chat.ts";
import type { Decision, Job, Jobs } from "../orchestrator/jobs.ts";
import { loadJobs, saveJobs } from "../orchestrator/jobs.ts";
import { fileDrafts } from "../orchestrator/drafts.ts";
import { workspaceKey } from "../orchestrator/paths.ts";
import { allowancePlans } from "../orchestrator/allowance.ts";
import { usageReserve } from "../orchestrator/tick.ts";
import { demoUsage } from "./demoUsage.ts";
import { allowanceDemo } from "../orchestrator/providers/index.ts";
import { sessionResultKey } from "../orchestrator/runner.ts";
import { applyControl } from "../store/control.ts";
import type { Store } from "../store/store.ts";
import { openStore } from "../store/store.ts";
import type { AssumptionHost } from "./server.ts";
import { createServer, DEFAULT_PORT } from "./server.ts";
import { offboardPlan, type Found } from "../offboard/plan.ts";
import { defaultOutFolder } from "../offboard/scan.ts";
import { projectInfo } from "./project.ts";
import { FAKE_SITE, fakeJira } from "../hosts/jira/fakeJira.ts";
import { fakeIssues, ISSUES_API } from "../hosts/github/fakeIssues.ts";
import { fakeMeta } from "../items/fakeMeta.ts";
import type { FetchLike } from "../hosts/github/client.ts";
import { CLOUD_EMAIL, CLOUD_ROBIN, cloudIssues, TOKEN as JIRA_TOKEN } from "../hosts/jira/fixtures.ts";
import type { Upgrader } from "../upgrade/upgrader.ts";
import type { UpgradeTask, UpgradeView } from "../upgrade/view.ts";
import { versionOf } from "../upgrade/version.ts";
import { KEYS } from "./snapshot.ts";
import { demoMedia } from "./demoMedia.ts";
import { demoCommit, demoHistory, demoSettingsLog, demoSha, seedDemoActivity } from "./demoHistory.ts";
import { memoryRequests } from "../hosts/metaBranch/requests.ts";

const SUITE = "full suite";
const reviewer = { id: "reviewer", name: "reviewer", bot: true };
/** A person who reviewed a change by hand (people are equals; any of them may). */
const oskar = { id: "oskar", name: "oskar" };
const REMOTE_URL = "git@forge.example:tidepool/tidepool.git";

/** The triage's questions on item 52: one picks one option, the other several. */
export const DEMO_QUESTIONS: Decision[] = [
  {
    question: "Which chart datum do we show heights against by default?",
    options: [
      { label: "Lowest astronomical tide", description: "The same datum for every harbour, so heights compare across harbours." },
      { label: "The harbour's own datum", description: "Matches the harbour's printed tables, but heights differ between harbours." },
      { label: "A setting per user", description: "One more setting to explain on the first-run screens." },
    ],
    recommendation: "Lowest astronomical tide",
    context: "The tide data source publishes both; nothing else in the app depends on the choice yet.",
  },
  {
    question: "Which test harbours go into the first data set?",
    options: [
      { label: "North Quay", description: "Two tides a day, the common case." },
      { label: "Eel Bay", description: "One tide a day: checks the day view with a single high." },
      { label: "Saltmarsh Point", description: "Dries out at low water: checks heights below datum." },
    ],
    recommendation: "North Quay",
    multiSelect: true,
  },
];

/** The triage's proposed restructuring of item 53. */
const DEMO_RESTRUCTURING: Restructuring = {
  id: "5eed0053",
  reason: "Triage proposes to restructure the Item: 1 new child Item, 1 new related Item, 1 into #82; the Item keeps one part. Four changes that each merge on their own; sharing by link is already item 82.",
  original: "keeps",
  parts: [
    { title: "Mark harbours as favourites", description: "A star on each harbour's page marks it as a favourite; the favourites are kept on the device.", verification: "Starring North Quay and reopening the app keeps it starred.", goes: "original" },
    { title: "Favourites on the start screen", description: "The start screen lists the favourite harbours first, each with its next tide.", verification: "With two favourites the start screen lists them above the rest.", goes: "child" },
    { title: "Share a favourite by link", description: "The share button on a favourite copies the same link item 82 makes.", verification: "", goes: "into", into: "82" },
    { title: "Keep favourites' tables offline", description: "The tide tables of the favourite harbours are fetched daily and shown without a connection, marked with their age.", verification: "In flight mode a favourite shows yesterday's table with its age.", goes: "related" },
  ],
};

/** The triage's question with its rewrite on item 41. */
const REWRITE_QUESTION: Decision = {
  question: "How many days does the week view show?",
  options: [
    { label: "Seven days from today", description: "Today and the six days after it." },
    { label: "Monday to Sunday", description: "The calendar week, so part of it may be past." },
  ],
  recommendation: "Seven days from today",
};
const REWRITE_ORIGINAL = "Show tide times for the next seven days.";
const REWRITE_TEXT = [
  "Show the high and low tides for today and the six days after it, one row per day, in the harbour's own time zone.",
  "",
  "- Each tide shows its time and its height in metres, to one decimal.",
  "- A day with a single high or low shows only that one.",
  "- The view scrolls sideways on a phone; nothing is cut off at 375 px.",
].join("\n");

/** The two decisions item 63's implementor took itself, open on the board. */
function demoAssumptions63(at: (minutes: number) => string): Assumption[] {
  return [
    // Answered at an earlier step of the same work: the page lists it first and opens on the first open one.
    {
      id: `${at(-150)}#0`, at: at(-150), question: "Which list of harbour names does the search read?",
      chosen: "The one the map already loads", others: ["A new list from the harbour office"],
      why: "It is loaded anyway, and a second list could disagree with the map.",
      settled: { verdict: "accepted", at: at(-120), by: "robin" },
    },
    {
      id: `${at(-58)}#0`, at: at(-58), question: "How many typos may a harbour name have and still match?",
      chosen: "Two for names of eight letters or more, one below", others: ["Always one", "Always two"],
      why: "Short names matched almost everything with two typos; the threshold is one constant to change.",
    },
    {
      id: `${at(-58)}#1`, at: at(-58), question: "Where do the near matches go in the list?",
      chosen: "After the exact matches, under a line", others: ["Mixed in by score", "Behind a 'Did you mean' link"],
      why: "Exact matches stay where people expect them; the order is one sort in the list component.",
    },
  ];
}

/**
 * Accept and Overturn in the demo, the picks of one Send together: the store's item is changed in place, in one put. An overturn
 * while the work runs (item 63 is in review) goes into it (the server keeps it for the cycle); otherwise it files a new demo item.
 */
export function demoAssumptionHost(store: Store): AssumptionHost {
  return {
    host: "demo",
    async settle(item, picks, by) {
      const work = store.get<WorkItem>(item);
      if (!work) throw new Error(`No item ${item.id}.`);
      const at = new Date().toISOString();
      const key = refKey(item);
      const job = loadJobs(store)[key];
      const kept = new Set(overturnsFor(store, key).map((each) => each.id));
      const outcomes: AssumptionOutcome[] = [];
      const settled = new Map<string, NonNullable<Assumption["settled"]>>();
      for (const pick of picks) {
        const decision = work.assumptions?.find((each) => each.id === pick.id);
        if (!decision) throw new AlreadyAnswered(`No decision ${pick.id} on ${item.id}.`);
        if (decision.settled) throw new AlreadyAnswered(`Decision ${pick.id} on ${item.id} is ${decision.settled.verdict} already.`);
      }
      for (const pick of picks) {
        const decision = work.assumptions!.find((each) => each.id === pick.id)!;
        if (pick.action === "accept") {
          outcomes.push({ id: pick.id, verdict: "accepted" });
          settled.set(pick.id, { verdict: "accepted", at, by });
          continue;
        }
        const answer = pick.answer ?? "";
        // As on a real host: an Item already filed for this decision is reused.
        const before = overturnedBy(store.list<WorkItem>("work"), work, decision);
        let outcome: AssumptionOutcome;
        if (before) outcome = { id: pick.id, verdict: "overturned", item: before.ref, reused: true };
        else if (kept.has(pick.id) || takesOverturn(job, work)) outcome = { id: pick.id, verdict: "overturned", work: true };
        else {
          const made = overturnItem(work, decision, answer);
          const next = Math.max(...store.list<WorkItem>("work").map((each) => Number(each.ref.id)).filter(Number.isFinite)) + 1;
          const ref: Ref = { host: work.ref.host, kind: "work", id: String(next) };
          const filed: WorkItem = { ref, title: made.title, body: made.body, verification: made.verification, state: "todo", hostState: "open", labels: [], blockedBy: made.merged ? [] : [item], openChildren: 0, updatedAt: at };
          store.put(filed, "demo", at);
          outcome = { id: pick.id, verdict: "overturned", item: ref };
        }
        outcomes.push(outcome);
        settled.set(pick.id, { verdict: "overturned", at, by, answer, ...(outcome.item ? { item: outcome.item } : {}), ...(outcome.work ? { work: true as const } : {}) });
      }
      // The verdicts in one write, as a real host does.
      const assumptions = (work.assumptions ?? []).map((each) => (settled.has(each.id) ? { ...each, settled: settled.get(each.id)! } : each));
      store.put({ ...work, assumptions }, "demo", at);
      return outcomes;
    },
  };
}

const SCOPESOUP_WRITER = { who: "scopesoup", machine: "demo", agent: true };
const logLine = (at: string, kind: string, fields: Record<string, unknown>): LogRecord => ({ at, by: SCOPESOUP_WRITER, kind, fields });

/**
 * Item 66's log as Scope Soup writes it: the triage, the implementor, a review that sends it back, the implementor's
 * session resumed with the findings, and a second review that sends it back again.
 */
function roundsLog66(at: (minutes: number) => string): LogRecord[] {
  return [
    logLine(at(-300), "created", {}),
    logLine(at(-236), "session", { role: "triage", model: "opus", outcome: "succeeded", summary: "Ready, small.", ready: true, size: "small", next: "implement", durationMs: 240_000, sessionId: "t-66", costUsd: 0.31 }),
    logLine(at(-165), "revision", { sha: demoSha("sunrise-1"), branch: "scopesoup/66" }),
    logLine(at(-165), "session", { role: "implement", model: "sonnet", outcome: "succeeded", summary: "Added a sunrise and sunset row under each day, computed from the harbour's position, with tests for North Quay.", durationMs: 2_100_000, sessionId: "i-66", costUsd: 1.42, next: "review" }),
    logLine(at(-141), "review", { sha: demoSha("sunrise-1"), verdict: "fail", findings: ["[must] src/day/SunRow.tsx: The sunset time is shown in UTC, not in the harbour's own time zone.", "[should] The row could hide on days the sun does not set."], model: "opus" }),
    logLine(at(-141), "session", { role: "review", model: "opus", outcome: "succeeded", summary: "changes, 2 findings", durationMs: 540_000, sessionId: "r-66", costUsd: 0.88, next: "implement" }),
    logLine(at(-106), "revision", { sha: demoSha("sunrise-2"), branch: "scopesoup/66" }),
    logLine(at(-106), "session", { role: "implement", model: "sonnet", outcome: "succeeded", summary: "Shows sunrise and sunset in the harbour's own time zone, with a test across the change to summer time. The polar day before and after: ![before: 00:00 on a day without a sunset](media/polar-before.png) ![after: the sunset left out](media/polar-after.png)", durationMs: 840_000, sessionId: "i-66b", costUsd: 0.57, next: "review" }),
    logLine(at(-88), "review", { sha: demoSha("sunrise-2"), verdict: "fail", findings: ["[must] src/day/SunRow.tsx: A day without a sunset (polar day) shows 00:00 instead of leaving the time out."], model: "opus" }),
    logLine(at(-88), "session", { role: "review", model: "opus", outcome: "succeeded", summary: "changes, 1 finding", durationMs: 420_000, sessionId: "r-66b", costUsd: 0.74, next: "implement" }),
  ];
}

/** Item 36's log at level 4: the batch's check failed once and sent the change back, then it passed and merged. */
function roundsLog36(at: (minutes: number) => string): LogRecord[] {
  const first = demoSha("zone-1");
  const second = demoSha("zone-2");
  const merged = demoSha("zone-merged");
  return [
    logLine(at(-900), "created", {}),
    logLine(at(-880), "session", { role: "triage", model: "opus", outcome: "succeeded", summary: "Ready, medium.", ready: true, size: "medium", next: "implement", durationMs: 180_000, costUsd: 0.22 }),
    logLine(at(-830), "revision", { sha: first, branch: "scopesoup/36" }),
    logLine(at(-830), "session", { role: "implement", model: "sonnet", outcome: "succeeded", summary: "Times are shown in the harbour's own time zone, read from the harbour list.", durationMs: 2_400_000, costUsd: 1.9, next: "review" }),
    logLine(at(-815), "review", { sha: first, verdict: "pass", findings: [], model: "opus" }),
    logLine(at(-815), "session", { role: "review", model: "opus", outcome: "succeeded", summary: "approve, 0 findings", durationMs: 480_000, costUsd: 0.65 }),
    logLine(at(-790), "check", { sha: first, verdict: "fail", command: "pnpm run check", batch: 2, findings: ["FAIL src/day/times.test.ts > Eel Bay on the night the clocks go back: expected 02:14, got 01:14"] }),
    logLine(at(-760), "revision", { sha: second, branch: "scopesoup/36" }),
    logLine(at(-760), "session", { role: "implement", model: "sonnet", outcome: "succeeded", summary: "Converts with the offset of the tide's own date, not today's; the night the clocks go back passes.", durationMs: 900_000, costUsd: 0.48, next: "review" }),
    logLine(at(-750), "review", { sha: second, verdict: "pass", findings: [], model: "opus" }),
    logLine(at(-750), "session", { role: "review", model: "opus", outcome: "succeeded", summary: "approve, 0 findings", durationMs: 300_000, costUsd: 0.4 }),
    logLine(at(-720), "revision", { sha: merged, branch: "scopesoup/36" }),
    logLine(at(-720), "check", { sha: merged, verdict: "pass", command: "pnpm run check", batch: 4 }),
    logLine(at(-720), "merged", { sha: merged, target: "main", batch: 4 }),
  ];
}

const DEMO_STREAMS: Record<string, [string, Record<string, unknown>][]> = {
  "t-66": [["Read", { file_path: "README.md" }], ["Glob", { pattern: "src/day/**/*.tsx" }], ["Read", { file_path: "src/day/DayView.tsx" }]],
  "i-66": [["Read", { file_path: "src/day/DayView.tsx" }], ["Write", { file_path: "src/day/SunRow.tsx" }], ["Write", { file_path: "src/day/sun.ts" }], ["Write", { file_path: "src/day/sun.test.ts" }], ["Bash", { command: "pnpm test" }], ["Edit", { file_path: "src/day/sun.ts" }], ["Bash", { command: "pnpm test" }], ["Bash", { command: "git commit -am 'Sunrise and sunset row'" }]],
  "r-66": [["Bash", { command: "git diff main...scopesoup/66" }], ["Read", { file_path: "src/day/SunRow.tsx" }], ["Grep", { pattern: "toISOString", path: "src/day" }]],
  "i-66b": [["Read", { file_path: "src/day/SunRow.tsx" }], ["Edit", { file_path: "src/day/SunRow.tsx" }], ["Edit", { file_path: "src/day/sun.test.ts" }], ["Bash", { command: "pnpm test" }], ["Bash", { command: "git commit -am 'Harbour time zone'" }]],
  "r-66b": [["Bash", { command: "git diff main...scopesoup/66" }], ["Read", { file_path: "src/day/sun.ts" }]],
};

/** A short synthetic stream for a demo session, in `dir`. Returns its path. */
function writeDemoStream(dir: string, id: string): string {
  const path = join(dir, `${id}.ndjson`);
  const lines = (DEMO_STREAMS[id] ?? []).map(([name, input]) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } }));
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

/**
 * Fills the store so that every lane, both batch states, a person's questions and rewrite, and sessions to talk to show. With
 * `dir`, the sessions of item 66 get short stream files there, for their details in the Rounds table.
 */
export function seedDemo(store: Store, now: Date, dir?: string): void {
  const base = now.toISOString();
  const at = (minutes: number) => plus(minutes, base);
  const put = (object: Parameters<Store["put"]>[0], minutesAgo = 0) => store.put(object, "demo", at(-minutesAgo));
  const item = (id: number, title: string, over: Partial<WorkItem> = {}) =>
    put(work(id, { title, updatedAt: at(-id * 7), ref: { ...ref("work", id), url: `https://forge.example/tidepool/issues/${id}` }, ...over }));
  const approved = [verdict("review", "pass", { by: reviewer }), verdict("ci", "pass", { by: undefined })];
  const changeFor = (id: number, title: string, over: Parameters<typeof change>[2] = {}) =>
    put(change(100 + id, [id], { title, updatedAt: at(-id), ref: { ...ref("change", 100 + id), url: `https://forge.example/tidepool/changes/${100 + id}` }, ...over }));
  /** A finished step session Scope Soup ran on the item, which a person can talk to (its agent session id is known). */
  const step = (id: string, item: number, role: Session["role"], model: string, startedMinutesAgo: number, minutes: number, over: Partial<Session> = {}) =>
    put(session(id, ref("work", item), {
      role, model, status: "succeeded", agentSessionId: `agent-${id}`, startedAt: at(-startedMinutesAgo), finishedAt: at(-startedMinutesAgo + minutes), ...over,
    }));
  const jobs: Jobs = {};
  const job = (item: number, over: Partial<Job>) => {
    const subject = ref("work", item);
    jobs[refKey(subject)] = { item: subject, workspace: workspaceKey(subject), branch: `scopesoup/${item}`, step: "triage", failures: 0, fixRounds: 0, startedAt: at(-180), ...over };
  };

  store.tx(() => {
    // Backlog (decision 120): ideas nobody has chosen yet. No agent triages or starts them until a person moves them to To do.
    item(84, "Coastline map that works without a connection", { backlog: true, priority: "major", body: "Ship a small vector map of the coast with the app, so the harbour picker works offline." });
    item(85, "Tide graph in landscape", { backlog: true, body: "Turning the phone shows the day's tide curve across the whole screen." });
    item(86, "A home-screen widget with the next high tide", { backlog: true });
    // Two Items wait for their triage, so To do shows them below its "Not triaged yet" divider.
    item(81, "Keep the last tide table for use offline", { body: "Without a connection the app shows nothing; it could show the table it fetched last, marked with its age." });
    item(82, "Share a harbour by link", { body: "A link that opens the app on one harbour's tide table." });
    // To do: two Items are parked on their triage for a person.
    item(41, "Show tide times for the next seven days", { body: REWRITE_ORIGINAL, verification: "The week view lists 28 tides for the test harbour." });
    step("t-41", 41, "triage", "opus", 40, 4);
    job(41, {
      triage: { ready: true, size: "small", paths: ["src/week"], hidesDecision: true, decision: REWRITE_QUESTION, decisions: [REWRITE_QUESTION], rewrite: REWRITE_TEXT },
      rewrite: { original: REWRITE_ORIGINAL, text: REWRITE_TEXT, questions: [REWRITE_QUESTION], round: 1 },
      rewriteRounds: 1,
      parked: { as: "needs-decision", reason: `Triage, round 1: a rewrite of the description and 1 question wait for an answer: 1. ${REWRITE_QUESTION.question}`, at: at(-36) },
    });
    item(52, "Chart datum and the first test harbours", {
      body: "Harbours publish heights against different datums, and the first data set needs a few harbours to test against.",
    });
    step("t-52", 52, "triage", "opus", 30, 5);
    job(52, {
      triage: { ready: true, size: "small", paths: [], hidesDecision: true, decision: DEMO_QUESTIONS[0]!, decisions: DEMO_QUESTIONS },
      parked: { as: "needs-decision", reason: `The triage asks ${DEMO_QUESTIONS.length} questions.`, at: at(-25) },
    });
    // A triage proposes to restructure item 53: it keeps one part, one becomes a sub-item, one goes into item 82, one stands on its own.
    item(53, "Favourite harbours, shared by link and kept offline", {
      body: "Let people mark harbours as favourites, list them on the start screen, share one by link, and keep their tables for use offline.",
    });
    step("t-53", 53, "triage", "opus", 20, 4);
    job(53, {
      proposal: DEMO_RESTRUCTURING,
      parked: { as: "needs-decision", reason: `${DEMO_RESTRUCTURING.reason} Accept, edit or reject it on the item page.`, at: at(-16) },
    });
    // Triage found item 46 too large and proposed no split: a person may split it, or press Implement anyway (decision 105).
    item(46, "Tide alerts for every harbour", { body: "Push an alert before each high tide, for any harbour, with per-harbour thresholds and quiet hours." });
    step("t-46", 46, "triage", "opus", 12, 3);
    job(46, {
      triage: { ready: true, size: "large", paths: ["src/alerts", "src/harbours"], hidesDecision: false },
      parked: { as: "not-ready", reason: "Triage: too large for one change (large means a story), and it proposed no split. Split it into smaller Items first, or answer here to have triage propose the split.", at: at(-9), verdict: true },
    });
    item(44, "Export a harbour's table as PDF", { blockedBy: [ref("work", 52)] });
    item(47, "Offline copy of the last viewed harbour", { blockedBy: [ref("work", 44)] });
    item(55, "Rework the first-run screens", { openChildren: 3 });

    // In progress
    item(58, "Moon phase next to each day", { state: "doing", holder: { actor: { id: "agent-1", name: "agent-1", bot: true }, until: at(90) } });
    changeFor(58, "Moon phase next to each day", { draft: true });
    step("t-58", 58, "triage", "opus", 120, 3);
    put(session("s-58a", ref("work", 58), { status: "failed", model: "sonnet", startedAt: at(-95), finishedAt: at(-80), endReason: "turn limit reached", attempt: 1 }));
    put(session("s-58b", ref("work", 58), { status: "succeeded", model: "sonnet", startedAt: at(-24), finishedAt: at(-14.7), endReason: "succeeded", attempt: 2, costUsd: 0.64 }));
    put(session("s-58c", ref("work", 58), { role: "review", status: "succeeded", model: "opus", startedAt: at(-17), finishedAt: at(-14.5), endReason: "succeeded", costUsd: 0.31 }));
    put(session("s-58", ref("work", 58), { model: "opus", agentSessionId: "agent-s-58", startedAt: at(-14), lastEventAt: at(0), lastAction: "writing tests for the phase calculation", costUsd: 1.84 }));
    job(58, { step: "implement", sessionId: "s-58", agentSession: "agent-s-58", startedAt: at(-120) });
    // Two people's holds. Whoever is picked at the top of the board sees their own in Your turn; another's names them.
    const held = (id: number, title: string, who: string, machine: string, since: number) =>
      item(id, title, {
        state: "doing", holder: { actor: { id: `${who}@${machine}`, name: `${who} on ${machine}` }, until: at(60 * 24 * 365 * 10) },
        log: [{ at: at(since), by: { who, machine, agent: false }, kind: "claimed", fields: { until: at(60 * 24 * 365 * 10) } }],
      });
    held(48, "Darker map tiles at night", "mira", "demo", -40);
    held(49, "Tide alarm with a gentle sound", "jonas", "laptop-b", -150);
    // An agent on another machine runs item 62's work: a pick for it goes there as a request (decision 104).
    item(62, "Sunrise and sunset times on the day view", { state: "doing", holder: { actor: { id: "scopesoup@laptop-b", name: "scopesoup on laptop-b", bot: true }, until: at(25) } });
    item(60, "Wind arrows on the hourly view", { state: "doing" });
    changeFor(60, "Wind arrows on the hourly view", { draft: true });
    put(session("s-60", ref("work", 60), { status: "stalled", model: "sonnet", startedAt: at(-52), lastEventAt: at(-17), lastAction: "running the browser suite" }));
    // Filed by a third person, so the board's person picker knows mira, jonas and ines.
    item(61, "Switch between metres and centimetres", { state: "doing", log: [{ at: at(-600), by: { who: "ines", machine: "laptop-c", agent: false }, kind: "created", fields: {} }] });
    changeFor(61, "Switch between metres and centimetres", { verdicts: approved });

    // In review
    // Its implementor decided two questions itself, recorded for a person to accept or overturn; the work went on.
    item(63, "Harbour search that forgives typos", { state: "doing", assumptions: demoAssumptions63(at) });
    changeFor(63, "Harbour search that forgives typos");
    step("t-63", 63, "triage", "opus", 90, 3);
    step("i-63", 63, "implement", "sonnet", 60, 40);
    put(session("s-63", ref("work", 63), { role: "review", model: "opus", agentSessionId: "agent-s-63", startedAt: at(-3), lastEventAt: at(0), lastAction: "reading the search index changes" }));
    job(63, { step: "review", sessionId: "s-63", agentSession: "agent-i-63", startedAt: at(-90) });
    item(64, "Delete my account and all saved harbours", { state: "doing", verification: "After deletion the account's rows are gone from every table." });
    changeFor(64, "Delete my account and all saved harbours", { updatedAt: at(-200) });
    // Item 66: a triage, an implementor and a reviewer ran; the review sent findings back twice, and the implementor's own
    // session was resumed with them. Nothing runs on it now, so a person can talk to any of its sessions, and one earlier
    // message to the first reviewer is on record. Its log gives the Rounds table; each session has a short stream.
    item(66, "Sunrise and sunset row", {
      state: "doing", body: "A row under each day with the sunrise and sunset times at the harbour, in its own time zone.", log: roundsLog66(at),
      // The implementor asks how a day without a sunset shows, with a picture of each option (synthetic, `demoMedia.ts`).
      openQuestions: [{
        at: at(-80), by: { who: "implementor", machine: "demo", agent: true },
        question: "How should a day without a sunset show its sunset time?",
        options: [
          { label: "Leave it out", description: "Only the sunrise is shown on that day. ![the polar day with the sunset left out](media/polar-none.png)" },
          { label: "Show a dash", description: "A dash stands where the time would be. ![the polar day with a dash](media/polar-dash.png)" },
        ],
        recommendation: "Leave it out",
      }],
    });
    changeFor(66, "Sunrise and sunset row", { verdicts: [verdict("review", "fail", { by: reviewer })] });
    const streamOf = (id: string) => (dir ? { streamPath: writeDemoStream(dir, id) } : {});
    step("t-66", 66, "triage", "opus", 240, 4, { costUsd: 0.31, ...streamOf("t-66") });
    step("i-66", 66, "implement", "sonnet", 200, 35, { costUsd: 1.42, ...streamOf("i-66") });
    step("r-66", 66, "review", "opus", 150, 9, { costUsd: 0.88, ...streamOf("r-66") });
    step("i-66b", 66, "implement", "sonnet", 120, 14, { costUsd: 0.57, agentSessionId: "agent-i-66", ...streamOf("i-66b") });
    step("r-66b", 66, "review", "opus", 95, 7, { costUsd: 0.74, ...streamOf("r-66b") });
    job(66, {
      step: "implement", agentSession: "agent-i-66", fixRounds: 2, startedAt: at(-240),
      resumeWith: "The review found: a day without a sunset shows 00:00.",
      review: { verdict: "changes", findings: [{ severity: "must", file: "src/day/SunRow.tsx", text: "A day without a sunset (polar day) shows 00:00 instead of leaving the time out." }] },
    });
    const earlier: ChatTurn = {
      id: "c-66-1", at: at(-130), agentSession: "agent-r-66", role: "review", message: "Is the time zone the only thing that must change?",
      reply: "Yes. The rest are suggestions: the row could hide on days the sun does not set, but that is not needed for this Item.", finishedAt: at(-129),
    };
    store.setValue(chatKey(refKey(ref("work", 66))), JSON.stringify([earlier]));

    // Queued
    item(68, "Remember the last harbour", { state: "doing" });
    changeFor(68, "Remember the last harbour", { verdicts: approved, updatedAt: at(-21) });
    item(69, "Spring and neap markers", { state: "doing" });
    changeFor(69, "Spring and neap markers", { verdicts: [...approved, verdict("review", "pass", { by: oskar })], updatedAt: at(-12) });
    item(70, "Larger tap targets on the day strip", { state: "doing" });
    changeFor(70, "Larger tap targets on the day strip", { verdicts: approved });

    // Checking
    const tested: [number, string][] = [
      [71, "Height curve for today"],
      [72, "Swedish and English harbour names"],
      [73, "Loading state for slow connections"],
      [74, "Dark colours for night use"],
    ];
    const bisected: [number, string][] = [
      [75, "Share a day as a link"],
      [76, "Round heights to one decimal"],
      [77, "Cache tide data per harbour"],
      [78, "Footer with data sources"],
    ];
    for (const [id, title] of [...tested, ...bisected]) {
      item(id, title, { state: "doing" });
      changeFor(id, title, { verdicts: approved });
    }

    // Done
    const done: [number, string][] = [[30, "Pick a harbour from a list"], [31, "Today's high and low tide"], [33, "App icon and name"], [36, "Times in the harbour's own time zone"]];
    for (const [id, title] of done) {
      item(id, title, { state: "done", hostState: "closed", ...(id === 36 ? { log: roundsLog36(at) } : {}) });
      changeFor(id, title, { state: "merged", verdicts: approved });
    }
    // Item 36's last implementor session, kept: its page shows the session with no box to write in, as the Item is done.
    put(session("s-36", ref("work", 36), { status: "succeeded", model: "sonnet", agentSessionId: "agent-s-36", startedAt: at(-775), finishedAt: at(-760), endReason: "succeeded", attempt: 2 }));

    saveJobs(store, jobs);

    // Two Item drafts wait in Your turn (decision 95): a review's should finding of item 66, and something item 63's implementor noticed.
    fileDrafts(store, ref("work", 66), "reviewer", [{
      title: "After #66: show the sunrise row in the harbour's own time zone",
      description: "The review of #66 approved its change and said this finding should still change:\n\n- `src/day/sun.ts`: the times use the phone's time zone, not the harbour's.",
      verification: "A harbour two time zones away shows its own sunrise time.",
    }], "orchestrator", at(-14));
    fileDrafts(store, ref("work", 63), "implementor", [{
      title: "Harbour names with accents sort after Z",
      description: "While making search forgive typos, the list of harbours sorted names with accents (Ålesund, Évian) after Z. A collation by locale would fix it.",
      verification: "Ålesund sorts with the A names in the harbour list.",
    }], "orchestrator", at(-6));

    // History for the estimate: ten green suites of about six and a half minutes.
    for (let i = 0; i < 10; i++) {
      const finished = at(-60 * (i + 2));
      put(run(`h${i}`, { pipeline: SUITE, status: "passed", startedAt: plus(-(6 + (i % 3) * 0.5), finished), finishedAt: finished, runner: "harbour-box" }));
    }

    // One batch at a time, as the queue engine works: batch 5 is being bisected and everything else waits.
    const red = run("r-b5", { pipeline: SUITE, status: "failed", startedAt: at(-31), finishedAt: at(-24), runner: "harbour-box", sha: "b5b5b5b" });
    const probe1 = run("r-b5-p1", { pipeline: SUITE, status: "passed", startedAt: at(-23), finishedAt: at(-16.5), runner: "attic-mini", sha: "b5p1p1p" });
    const probe2 = run("r-b5-p2", { pipeline: SUITE, status: "running", createdAt: at(-2.5), startedAt: at(-2.1), runner: "attic-mini", sha: "b5p2p2p" });
    const queued = run("r-b5-p3", { pipeline: SUITE, status: "queued", createdAt: at(-1), sha: "b5p3p3p" });
    for (const each of [red, probe1, probe2, queued]) put(each);

    put(
      batch(5, bisected.map(([id]) => member(100 + id)), {
        status: "bisecting",
        runs: [red.ref],
        startedAt: at(-31),
        base: "a41f9c2",
        suspect: ref("change", 177),
        note: "The browser suite failed in the harbour page test.",
        probes: [{ prefix: 2, status: "passed", run: probe1.ref }, { prefix: 3, status: "running", run: probe2.ref }],
      }),
    );
    put(batch(4, [member(130, "merged"), member(131, "merged"), member(133, "merged")], { status: "merged", startedAt: at(-190), finishedAt: at(-183), base: "77e0d15" }));
    // Batch 3 failed earlier: its run and probes stay on the record, and change 168 went back in the queue from it.
    const failedRun = run("r-b3", { pipeline: SUITE, status: "failed", startedAt: at(-150), finishedAt: at(-143), runner: "harbour-box", sha: "b3b3b3b" });
    const failedProbe1 = run("r-b3-p1", { pipeline: SUITE, status: "passed", startedAt: at(-142), finishedAt: at(-135), runner: "harbour-box", sha: "b3p1p1p" });
    const failedProbe2 = run("r-b3-p2", { pipeline: SUITE, status: "failed", startedAt: at(-134), finishedAt: at(-127), runner: "harbour-box", sha: "b3p2p2p" });
    for (const each of [failedRun, failedProbe1, failedProbe2]) put(each);
    put(
      batch(3, [member(136, "merged"), member(161, "culprit"), member(168, "requeued")], {
        status: "failed",
        startedAt: at(-150),
        finishedAt: at(-118),
        base: "5d02b7e",
        runs: [failedRun.ref],
        probes: [{ prefix: 1, status: "passed", run: failedProbe1.ref }, { prefix: 2, status: "failed", run: failedProbe2.ref }],
      }),
    );
  });

  const runners: (Runner & { since?: string })[] = [
    { id: "r1", name: "harbour-box", online: true, busy: false, labels: ["linux"], since: at(-16.5) },
    { id: "r2", name: "attic-mini", online: true, busy: true, labels: ["linux"], current: ref("run", "r-b5-p2"), since: at(-2.1) },
    { id: "r3", name: "spare-laptop", online: false, busy: false, labels: ["windows"], since: at(-185) },
  ];
  store.setValue(KEYS.runners, JSON.stringify(runners));
  // #58's implementor holds the demo's emulator and #52 waits for it; #63's review holds the one seat of the shared tide API.
  store.setValue(KEYS.resources, JSON.stringify({
    held: [
      { resource: "emulator", unit: 1, holder: refKey(ref("work", 58)), label: "implement for 58", since: at(-14) },
      { resource: "tide-api", unit: 1, holder: refKey(ref("work", 63)), label: "review for 63", since: at(-3) },
    ],
    waiting: [{ resource: "emulator", holder: refKey(ref("work", 52)), label: "implement for 52", since: at(-6) }],
    elsewhere: [],
  }));
  // Level 4 at work: agents and the merge queue are started.
  applyControl(store, "agents.start", at(-200), "demo", "mira");
  applyControl(store, "mergeQueue.start", at(-200), "demo", "mira");
  store.setValue(KEYS.sync, JSON.stringify({ lastAt: at(-0.5) }));
  // 30 days of synthetic usage readings and the finished sessions that filled the windows, for the Usage page.
  const usage = demoUsage(now);
  // Those sessions ran on the demo's own Items, so History names each one.
  const onItem = <T extends { subject: Ref }>(each: T, index: number): T => ({ ...each, subject: ref("work", USAGE_ITEMS[index % USAGE_ITEMS.length]!) });
  store.tx(() => {
    usage.sessions.forEach((each, index) => store.put(onItem(each, index), "demo", each.finishedAt ?? base));
    for (const sample of usage.samples) store.addUsageSample(sample);
    // One role runs on a provider with a monthly allowance: its sessions and the results they recorded.
    allowanceDemo.sessions(now).forEach((each, index) => {
      store.put(onItem(each.session, index), "demo", each.session.finishedAt ?? base);
      store.setValue(sessionResultKey(each.session.ref.id), JSON.stringify(each.result));
    });
  });
  // Who created the Items, a rewrite accepted, merges, switches and an upgrade, for History.
  seedDemoActivity(store, now, versionOf(resolve(dirname(fileURLToPath(import.meta.url)), "../..")));
}

/** Items the Usage page's synthetic sessions ran on: done ones, so the open Items' rounds stay as the demo sets them. */
const USAGE_ITEMS = [30, 31, 33];

/**
 * The demo's project configuration, written to `dir` (a temporary folder): level 4 with its check command and remote URL,
 * machine "demo", and the setup of a fresh clone. Every path in it is inside `dir`. Its `repo` folder is a git repository
 * with a few synthetic files, so the Settings page finds check candidates there, and its meta ref holds the project's
 * shared settings, written as the first person would. Returns the private file.
 */
export async function writeDemoConfig(dir: string, settings: MetaSettings = metaSettings()): Promise<string> {
  const file = join(dir, "scopesoup.config.json");
  const repo = join(dir, "repo");
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "tidepool", scripts: { check: "tsc --noEmit && node --test", test: "node --test", lint: "eslint ." } }, null, 2) + "\n");
  writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(repo, ".github", "workflows", "ci.yml"), ["name: CI", "on: [push]", "jobs:", "  check:", "    runs-on: ubuntu-latest", "    steps:", "      - uses: actions/checkout@v4", "      - run: pnpm install --frozen-lockfile", "      - run: pnpm run check", "      - run: pnpm run tide-tables", ""].join("\n"));
  writeFileSync(join(repo, "Makefile"), "test:\n\tpnpm test\ntide-tables:\n\tnode scripts/tables.js\n");
  // A repository of its own, with no remote: the shared settings stay on this machine.
  execFileSyncRetrying("git", ["init", "--quiet", "-b", "main", repo], { windowsHide: true });
  // This machine's own settings, and the project's shared ones on the meta ref.
  const own = {
    version: 2,
    repoPath: "repo",
    workspacesDir: "workspaces",
    machineName: "demo",
    keepAwake: false,
    remoteUrl: REMOTE_URL,
    // A folder of its own, so the board's "Open folder" has the person's checkout to open.
    ownClone: join(dir, "tidepool"),
    settings: {
      maxParallelSessions: { value: 2, reason: "Two sessions at a time on the demo machine." },
      reserveFiveHour: { value: 0.1, reason: "The demo shares the usage window with nobody." },
      reserveSevenDay: { value: 0.1, reason: "The demo shares the usage window with nobody." },
    },
    // The plan's monthly allowance of the provider that triage runs on.
    ...allowanceDemo.machine(new Date()),
    // This machine's one emulator, its own port for whoever holds it.
    resources: [{ name: "emulator", units: 1, neededBy: ["implement", "check"], env: { ANDROID_SERIAL: "emulator-555{{unit}}" } }],
    // This machine's part of the meta branch host (synthetic person), so Settings' Connect can list the Items to move.
    meta: { authorName: "Demo Person", authorEmail: "demo@example.invalid", prefix: "D" },
    // This machine's part of the Jira host (the fake site's synthetic account), for DEMO_HOST=jira.
    ...(process.env.DEMO_HOST === "jira" ? { jira: { email: CLOUD_EMAIL } } : {}),
  };
  const shared = {
    project: "tidepool",
    // The demo's Items are its own store's; named as a meta branch so Settings' Connect offers to move them. DEMO_HOST=github names a
    // fake GitHub repository instead, so Settings offers "Move back to the meta branch" (#134); DEMO_HOST=jira the fake Jira site's
    // synthetic project with a filter, so Settings' Jira filter can be changed and counted (#141).
    host: process.env.DEMO_HOST === "github" ? { kind: "github", repo: DEMO_REPO, write: true } : process.env.DEMO_HOST === "jira" ? DEMO_JIRA_HOST : { kind: "metaBranch", write: true },
    level: 4,
    bugLabels: ["bug"],
    // The implementor's model per triage size (decision 105).
    roles: { ...allowanceDemo.roles, implement: { modelBySize: { small: "haiku", large: "opus" } } },
    checkCommand: ["pnpm", "run", "check"],
    setupCommand: ["node", ".scopesoup/scopesoup-setup.mjs", "--from-clone", "{{ownClone}}"],
    setupWatch: ["pnpm-lock.yaml"],
    // One seat of a paid test API, shared by every machine.
    sharedResources: [{ name: "tide-api", units: 1, neededBy: ["review"] }],
  };
  mkdirSync(own.ownClone, { recursive: true });
  writeFileSync(file, JSON.stringify(own, null, 2) + "\n");
  const saved = await settings.save({ repoPath: repo, remote: "origin", machine: "demo", by: "Ada", update: () => shared });
  if (!saved.ok) throw new Error(`The demo's shared settings could not be written: ${saved.error}`);
  return file;
}

/**
 * What the Settings page needs to read the demo's configuration without looking at this machine's PATH. A project setting
 * saved on the demo's page is a commit on the meta ref of the demo's own repository, so the page shows it at once.
 */
export function demoConfigOptions(dir: string, settings: MetaSettings = metaSettings()) {
  const started = new Date();
  return {
    programFound: () => true,
    checkCommandProblem: () => null,
    mergeQueue: { platform: "linux" as const, env: {}, remoteUrlOf: () => REMOTE_URL },
    sharedSettings: settings,
    // The saves made on the demo's page, after a synthetic older history of settings.
    settingsLog: () => demoSettingsLog(settings.log(join(dir, "repo")), started),
    // "Stop using Scope Soup" lists what a project Scope Soup ran for a while would leave; the demo has no git, so it is made up.
    offboard: async () => ({ now: new Date().toISOString(), available: true as const, plan: offboardPlan(demoFound(dir)), configFolder: dir, outFolder: defaultOutFolder(dir) }),
    // Settings' "Connect to Jira" looks at a fake Jira Cloud site (https://example.atlassian.net, project DEMO, synthetic issues)
    // with a made-up token; "Connect to GitHub Issues" finds no token. With DEMO_HOST=github, "Move back to the meta branch" reads a
    // fake GitHub repository and writes a meta branch in memory. No real host is ever asked.
    connect: demoConnect(),
    metaBranch: () => fakeMeta("D"),
  };
}

/** The Jira host DEMO_HOST=jira names: the fake Jira site's synthetic project, its Items those labelled frontend. */
const DEMO_JIRA_HOST = { kind: "jira", site: FAKE_SITE, project: "DEMO", deployment: "cloud", write: true, filter: "labels = frontend" };

/** The repository DEMO_HOST=github names: synthetic, on the fake GitHub. */
const DEMO_REPO = "example/tidepool";

/** The connect dialogs' hosts: the fake Jira site, and with DEMO_HOST=github a fake GitHub repository with a token for it. */
function demoConnect() {
  const jira = fakeJira({ deployment: "cloud", token: JIRA_TOKEN, email: CLOUD_EMAIL, user: CLOUD_ROBIN, issues: cloudIssues() });
  if (process.env.DEMO_HOST !== "github") return { env: { SCOPESOUP_JIRA_TOKEN: JIRA_TOKEN }, fetchImpl: jira.fetch };
  const github = fakeIssues(DEMO_REPO, [41, 42, 43, 44]);
  const titles = ["Tide table for the next seven days", "Moon phase on the chart", "Offline copy of the favourite harbours", "Swell height in metres"];
  [41, 42, 43, 44].forEach((number, index) => Object.assign(github.issues.get(String(number))!, { title: titles[index], body: number === 42 ? "Drawn on the chart of #41." : "Synthetic demo issue." }));
  const fetchImpl: FetchLike = (url, init) => (url.startsWith(ISSUES_API) ? github.fetch(url, init) : jira.fetch(url, init));
  return { env: { SCOPESOUP_JIRA_TOKEN: JIRA_TOKEN, SCOPESOUP_GITHUB_TOKEN: "ghp-demo-synthetic" }, fetchImpl, githubApi: ISSUES_API };
}

/** What offboarding would find on the demo project: a batch left after a failure, labels, the refs, the copies. Synthetic. */
export function demoFound(dir: string): Found {
  return {
    configFolder: dir,
    manifest: [{ kind: "label", repo: "example/tidepool", name: "priority:major", at: "2026-11-01T09:00:00.000Z", by: "scopesoup" }],
    remote: "origin",
    mainBranch: "main",
    remoteRefs: ["refs/scopesoup/merge-queue", "refs/scopesoup/meta", "refs/scopesoup/resources/tide-api/1"],
    remoteBranches: [
      { name: "scopesoup/batch-12-4be0c1d", sha: demoTip("batch-12"), merged: false },
      { name: "scopesoup/T-31", sha: demoTip("T-31"), merged: false },
      { name: "scopesoup/T-28", sha: demoTip("T-28"), merged: true },
      { name: "scopesoup/onboard", sha: demoTip("onboard"), merged: true },
    ],
    localBranches: [{ repo: join(dir, "repo"), name: "scopesoup/T-33", sha: demoTip("T-33"), merged: false, onRemote: false }],
    github: {
      repo: "example/tidepool",
      labels: ["bug", "scopesoup:claimed", "scopesoup:needs-decision", "scopesoup:review", "priority:major"],
      pulls: [{ number: 212, title: "Scope Soup batch 12", head: "scopesoup/batch-12-4be0c1d" }],
    },
    projectFiles: [{ path: "CLAUDE.md", change: "claude-md-section" }, { path: ".claude/settings.json", change: "plugin-settings" }, { path: ".scopesoup/scopesoup-setup.mjs", change: "setup-script" }],
    folders: [
      { path: join(dir, "workspaces"), what: "Scope Soup's worktrees and the merge queue's clone", exists: true },
      { path: join(dir, "data"), what: "the data folder (Scope Soup's database)", exists: true },
      { path: join(dir, "repo"), what: "Scope Soup's clone of the project", exists: true, holdsWork: "commits on a branch that no remote has" },
      { path: dir, what: "the config folder (this machine's settings, the manifest, the data folder)", exists: true },
    ],
    copies: [join(dir, "scopesoup.config.v0.json"), join(dir, "data", "scopesoup.v1.sqlite")],
    install: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  };
}

/** The commit an Item's branch points at in the demo, which has no git: 40 hex digits made from the id. */
export const demoTip = (id: string): string => createHash("sha1").update(`tidepool scopesoup/${id}`).digest("hex");

/**
 * The demo's Items host: in memory, over the demo's store, so Claim, Hand back, Release and New item can be shown. The
 * item commands' rules (`src/items/service.ts`) run on the server as on any host; this only keeps the lines they write, folded
 * as the meta branch folds them: a person's claim takes a free item, a release lets go of the writer's own hold or (`of`) any
 * person's, and a hand-back's revision makes the Item's change. Nothing leaves the process.
 */
export function demoItemsHost(store: Store, now: () => Date = () => new Date()): { host: string; work: WorkPort; write: WritePort } {
  const host = "demo";
  const outcome = (work: Ref): WriteOutcome => ({ work, shared: "local", conflict: false });
  const fold = (item: WorkItem, line: LogLineInput, at: string): WorkItem => {
    const by: LogWriter = { who: line.by.who, machine: "demo", agent: line.by.agent };
    const fields = line.fields ?? {};
    const next: WorkItem = { ...item, updatedAt: at, log: [...(item.log ?? []), { at, by, kind: line.kind, fields }] };
    const entry: LogEntry = { line: 0, at, by, kind: line.kind, data: { ...fields, at, by, kind: line.kind }, key: "" };
    next.history = [...(item.history ?? []), { at, by: actorOf(by), kind: line.kind, text: describeLine(entry) }];
    const held = item.holder;
    const own = held !== undefined && (held.actor.bot ? held.actor.id === actorOf(by).id : !by.agent && held.actor.id.split("@")[0] === by.who);
    if (line.kind === "claimed" && typeof fields.until === "string" && (!held || own || (held.actor.bot && held.until !== undefined && Date.parse(held.until) <= Date.parse(at)))) {
      next.holder = { actor: actorOf(by), until: fields.until };
    }
    if (line.kind === "released" && held && (own || (!held.actor.bot && !by.agent && fields.of === held.actor.id))) delete next.holder;
    if (line.kind === "revision" && typeof fields.sha === "string") {
      store.put(change(100 + Number(item.ref.id), [item.ref.id], {
        title: item.title, author: actorOf(by), updatedAt: at, ref: ref("change", 100 + Number(item.ref.id)),
        revisions: [{ id: fields.sha, sha: fields.sha, createdAt: at, author: actorOf(by) }],
        ...(typeof fields.branch === "string" ? { branch: fields.branch } : {}),
      }), by.who, at);
    }
    return next;
  };
  const reader: WorkPort = {
    listWork: async () => ({ items: store.list<WorkItem>("work", host), cursor: "" }),
    getWork: async (asked) => store.get<WorkItem>({ host, kind: "work", id: asked.id }),
  };
  const write: WritePort = {
    async createWork(input) {
      const at = now().toISOString();
      const id = String(Math.max(0, ...store.list<WorkItem>("work", host).map((each) => Number(each.ref.id)).filter(Number.isFinite)) + 1);
      let item: WorkItem = {
        ...work(id, { title: input.title, updatedAt: at, labels: input.labels ?? [], blockedBy: input.blockedBy ?? [] }),
        ...(input.body ? { body: input.body } : {}), ...(input.verification ? { verification: input.verification } : {}), ...(input.priority ? { priority: input.priority } : {}),
        // New Items land in Backlog (decision 120).
        ...(input.lane === "todo" ? {} : { backlog: true as const }),
      };
      for (const line of input.log ?? []) item = fold(item, line, at);
      store.put(item, input.log?.[0]?.by.who ?? "demo", at);
      return outcome(item.ref);
    },
    /** The demo keeps only the vote and Backlog or To do; the board's other edits are not offered on the demo's Items. */
    async editWork(asked, patch) {
      const item = await reader.getWork(asked);
      if (!item) throw new Error(`There is no item ${asked.id}.`);
      const at = now().toISOString();
      const { vote: _old, backlog: _lane, ...rest } = item;
      const backlog = patch.lane === undefined ? item.backlog : patch.lane === "backlog" ? true : undefined;
      store.put({ ...rest, ...((patch.vote ?? item.vote) ? { vote: patch.vote ?? item.vote } : {}), ...(backlog ? { backlog } : {}), updatedAt: at }, "demo", at);
      return outcome(item.ref);
    },
    async appendLog(asked, line) {
      const item = await reader.getWork(asked);
      if (!item) throw new Error(`There is no item ${asked.id}.`);
      const at = now().toISOString();
      store.put(fold(item, line, at), line.by.who, at);
      return outcome(item.ref);
    },
  };
  return { host, work: reader, write };
}

/**
 * The demo's diff of an Item's branch (no git): a branch for an Item with a change or a person's hold, at `demoTip`, so the
 * hand-back form has a commit to propose. Other Items have no branch yet.
 */
export function demoDiff(store: Store, item: Ref, now: Date): DiffView {
  const branch = `scopesoup/${item.id}`;
  const held = store.get<WorkItem>(item)?.holder;
  const changed = store.list<Change>("change").some((each) => each.works.some((one) => refKey(one) === refKey(item)));
  if (!changed && !(held && !held.actor.bot)) return { now: now.toISOString(), available: false, reason: `There is no branch ${branch} yet.` };
  const diff = "@@ -1,4 +1,5 @@\n export const tideRows = 4;\n-export const showSun = false;\n+export const showSun = true;\n+export const showMoon = true;\n export const units = \"m\";\n export const days = 7;\n";
  return {
    now: now.toISOString(), available: true, branch, base: createHash("sha1").update("tidepool main").digest("hex"), tip: demoTip(item.id),
    files: [{ path: "src/day/settings.ts", added: 2, removed: 1, binary: false, diff }], omitted: 0, totalAdded: 2, totalRemoved: 1,
  };
}

/** In the demo, a person "pushes" the Item's branch this long after claiming it. */
export const DEMO_PUSH_MS = 20_000;

/**
 * The demo's remote (no git): an Item's branch is on it when the Item has a change, or a person has held it for
 * `DEMO_PUSH_MS` (as if they pushed it by then; an Item seeded as held has no claim line and counts as pushed). Its tip is
 * `demoTip`, one commit beyond main. So the board shows the start command right after Claim, and Hand back works a little later.
 */
export function demoBranches(store: Store, now: () => Date = () => new Date()): RemoteBranches {
  const pushed = (branch: string): string | undefined => {
    const id = branch.startsWith("scopesoup/") ? branch.slice("scopesoup/".length) : "";
    const item = store.get<WorkItem>({ host: "demo", kind: "work", id });
    if (!item) return undefined;
    if (store.list<Change>("change").some((each) => each.works.some((one) => one.id === id && one.host === "demo"))) return id;
    if (!item.holder || item.holder.actor.bot) return undefined;
    const claimed = (item.log ?? []).filter((line) => line.kind === "claimed").at(-1);
    return !claimed || now().getTime() - Date.parse(claimed.at) >= DEMO_PUSH_MS ? id : undefined;
  };
  return {
    names: () => ({ remote: "origin", mainBranch: "main" }),
    exists: async (branch) => pushed(branch) !== undefined,
    async fetch(branch) {
      const id = pushed(branch);
      return id === undefined ? { state: "missing" } : { state: "ready", sha: demoTip(id), ahead: 1 };
    },
  };
}

const REPLIES: Record<string, string> = {
  triage: "Noted. I will take that into account the next time I look at this Item; nothing changes until then.",
  implement: "Understood. I will keep that in mind for the next change on this Item.",
  review: "Thanks. I will check that in my next review of this change.",
};

/**
 * A runner for the demo's chat turns: no process starts. Each turn is a session in the store that "writes" for a few seconds,
 * then succeeds with a short canned reply, written as a stream file in `dir`.
 */
export function demoChatRunner(store: Store, dir: string, replyAfterMs = 3000): ChatRunner {
  const live = new Map<string, Promise<Session>>();
  const busy = new Set<string>();
  let count = 0;
  return {
    async start(request) {
      const id = `demo-chat-${++count}`;
      const startedAt = new Date().toISOString();
      const started = session(id, request.subject, {
        role: request.role, status: "running", chat: true, startedAt, lastEventAt: startedAt, lastAction: "reading your message",
        ...(request.resume ? { agentSessionId: request.resume } : {}),
      });
      store.put(started, "demo", startedAt);
      const key = refKey(request.subject);
      busy.add(key);
      live.set(id, new Promise((resolveTurn) => {
        setTimeout(() => {
          const streamPath = join(dir, `${id}.jsonl`);
          const reply = REPLIES[request.role] ?? "Noted.";
          writeFileSync(streamPath, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: reply }] } }) + "\n");
          const finishedAt = new Date().toISOString();
          const { lastAction: _reading, ...rest } = started;
          const over: Session = { ...rest, status: "succeeded", finishedAt, lastEventAt: finishedAt, streamPath };
          store.put(over, "demo", finishedAt);
          busy.delete(key);
          resolveTurn(over);
        }, replyAfterMs);
      }));
      return started;
    },
    running: () => busy.size,
    busy: (subject: Ref) => busy.has(refKey(subject)),
    finished: (sessionId: string) => live.get(sessionId) ?? Promise.reject(new Error(`No demo turn ${sessionId}.`)),
    takeWorkspace: async () => null,
    releaseWorkspace: async () => undefined,
  };
}

/** The real chat (`src/orchestrator/chat.ts`) over the demo's runner and configuration. */
export function createDemoChat(store: Store, configFile: string, dir: string, replyAfterMs?: number, settings: MetaSettings = metaSettings()): Chat {
  const loader = createConfigLoader(configFile, undefined, { shared: settings });
  const config = (): ProjectConfig => {
    const state = loader.load();
    if (!state.config) throw new Error(state.error ?? "no project configuration");
    return state.config;
  };
  return createChat({ store, runner: demoChatRunner(store, dir, replyAfterMs), config, now: () => new Date().toISOString() });
}

const ACTIONS = ["writing tests for the phase calculation", "running the unit tests", "fixing a rounding error at new moon", "reading the calendar component", "updating the day row"];

/**
 * Keeps the demo alive: the session changes what it is doing, and a run that has passed
 * its estimate starts over, so the bars keep moving however long the demo is left open.
 */
export function tickDemo(store: Store, now: Date, step: number): void {
  const iso = now.toISOString();
  const live = store.get<ReturnType<typeof session>>(ref("session", "s-58", "scopesoup"));
  if (live) store.put({ ...live, lastAction: ACTIONS[step % ACTIONS.length], lastEventAt: iso }, "demo", iso);
  for (const each of store.list<Run>("run")) {
    if (each.status !== "running" || !each.startedAt) continue;
    if (now.getTime() - Date.parse(each.startedAt) > 7.5 * 60_000) store.put({ ...each, startedAt: iso }, "demo", iso);
  }
  store.setValue(KEYS.sync, JSON.stringify({ lastAt: iso }));
}

/**
 * The Settings page's version panel over a made-up release, with no network and no files: the demo runs the version
 * in package.json, "finds" the next minor version, and Get latest and Go back walk through the steps on timers (the
 * restart is pretended: the demo's server stays up and only says it runs the other version).
 */
export function demoUpgrader(now: () => Date = () => new Date(), stepMs = 2500): Pick<Upgrader, "view" | "check" | "getLatest" | "goBack" | "cancel" | "dismissNote"> {
  const own = versionOf(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
  const [major, minor] = own.split(".").map(Number);
  const next = `${major}.${(minor ?? 0) + 1}.0`;
  let version = own;
  let previous: string | null = null;
  let checkedAt: string | null = null;
  let task: UpgradeTask | null = null;
  let timers: NodeJS.Timeout[] = [];
  const notes = [
    "What changed:",
    "",
    "- The board shows the tide for the next seven days (synthetic notes for the demo).",
    "- Item pages load faster.",
    "",
    "Data formats: no change (config 1, meta branch 1, database 1), so going back just works.",
  ].join("\n");
  const active = () => task !== null && !["done", "failed"].includes(task.state);
  const set = (kind: UpgradeTask["kind"], to: string, state: UpgradeTask["state"], text: string) => {
    task = { kind, to, state, text, at: now().toISOString() };
  };
  const view = (): UpgradeView => {
    const available = checkedAt !== null && version !== next;
    return {
      now: now().toISOString(), version, install: "release", home: "C:/Users/sam/scopesoup", checking: false, checkedAt, checkProblem: null, checkOff: null,
      latest: checkedAt ? { version: next, notes, page: "https://github.com/mikaeltulldahl/scopesoup/releases", publishedAt: now().toISOString() } : null,
      available,
      getLatest: active() ? { can: false, why: "A switch is under way." } : available ? { can: true } : { can: false, why: "No newer release is known." },
      back: previous ? { version: previous, newer: previous === next, ...(active() ? { can: false, why: "A switch is under way." } : { can: true }) } : null,
      task,
      note: null,
      lastSwitch: previous ? { from: `scopesoup-${previous}`, to: `scopesoup-${version}`, at: now().toISOString(), backup: "C:/Users/sam/scopesoup/backups/before-scopesoup-" + next } : null,
    };
  };
  const walk = (kind: UpgradeTask["kind"], to: string, steps: [UpgradeTask["state"], string][]) => {
    timers.forEach(clearTimeout);
    timers = steps.map(([state, text], at) => setTimeout(() => {
      set(kind, `scopesoup-${to}`, state, text);
      if (state === "done") {
        previous = version;
        version = to;
      }
    }, at * stepMs));
  };
  const switching = (kind: UpgradeTask["kind"], to: string): [UpgradeTask["state"], string][] => [
    ["waiting", "Waiting until nothing runs: 1 session still running. Agents and merging are paused, so nothing new starts."],
    ["switching", `Switching to ${to}.`],
    ["restarting", `Restarting on ${to}. The board comes back in a moment.`],
    ["done", `Scope Soup ${to} runs now${kind === "upgrade" ? `; ${version} stays for Go back` : ""}. Agents and the merge queue start again as they were.`],
  ];
  return {
    view,
    async check() {
      checkedAt = now().toISOString();
      return view();
    },
    getLatest() {
      if (!view().getLatest.can) return view();
      set("upgrade", `scopesoup-${next}`, "downloading", `Downloading scopesoup-${next}.zip.`);
      walk("upgrade", next, [["downloading", `Checking and unpacking scopesoup-${next}.zip.`], ...switching("upgrade", next)]);
      return view();
    },
    goBack() {
      const to = previous;
      if (!to || active()) return view();
      set("back", `scopesoup-${to}`, "waiting", `Going back to ${to}.`);
      walk("back", to, switching("back", to));
      return view();
    },
    cancel() {
      if (task && (task.state === "waiting" || task.state === "downloading")) {
        timers.forEach(clearTimeout);
        set(task.kind, task.to, "failed", "Cancelled. Agents and merging stay paused: press Start to go on.");
      }
      return view();
    },
    dismissNote: view,
  };
}

async function main(): Promise<void> {
  const store = openStore(":memory:");
  // Everything the demo writes to disk (its configuration, chat replies) stays in this folder, deleted at the end.
  const dir = mkdtempSync(join(tmpdir(), "scopesoup-demo-"));
  const settings = metaSettings();
  const configFile = await writeDemoConfig(dir, settings);
  const loader = createConfigLoader(configFile, undefined, { shared: settings });
  // DEMO_EMPTY=1 starts with no items, to look at the empty board.
  if (!process.env.DEMO_EMPTY) seedDemo(store, new Date(), dir);
  const staticDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  if (!existsSync(staticDir)) console.warn("web/dist is missing: run `pnpm web:build` first. Serving the API only.");
  const server = createServer({
    store,
    staticDir,
    host: "127.0.0.1",
    port: process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT,
    onRefresh: () => store.appendEvent({ kind: "sync.requested", actor: "board" }, new Date().toISOString()),
    configFile,
    ...demoConfigOptions(dir, settings),
    machine: "demo",
    // Picks for Items whose work runs on another machine: kept in memory, and no other machine answers them in the demo.
    requests: memoryRequests([], "demo"),
    // The demo's name and repository in the header; "Open folder" opens the demo's temporary folders.
    project: () => {
      const loaded = loader.load().config;
      return loaded ? projectInfo(loaded, configFile, () => REMOTE_URL) : null;
    },
    planning: () => {
      const loaded = loader.load().config;
      return loaded ? { bugLabels: loaded.bugLabels, plannedSessions: loaded.settings.maxParallelSessions.value, reserve: usageReserve(loaded), allowances: allowancePlans(loaded, usageReserve(loaded).seven_day), level: loaded.level, ...(loaded.resources ? { resources: loaded.resources } : {}) } : { bugLabels: ["bug"] };
    },
    chat: createDemoChat(store, configFile, dir, undefined, settings),
    assumptions: [demoAssumptionHost(store)],
    items: demoItemsHost(store),
    // Approve on a draft makes its Item here (`src/server/drafts.ts`).
    restructure: [demoItemsHost(store)],
    branches: demoBranches(store),
    diff: async (item) => demoDiff(store, item, new Date()),
    // A synthetic commit history: the demo has no repository of the project.
    history: async (limit) => demoHistory(store, new Date(), limit),
    commit: async (sha) => demoCommit(sha, new Date()),
    upgrade: demoUpgrader(),
    // Item 66's images: synthetic pictures drawn in code, kept in memory.
    media: demoMedia(store),
  });
  const { url } = await server.start();
  let step = 0;
  const timer = setInterval(() => tickDemo(store, new Date(), ++step), 20_000);
  console.log(`Scope Soup demo (synthetic data) on ${url}`);
  console.log(`Its configuration is ${configFile}, deleted when the demo stops.`);
  const stop = () => {
    clearInterval(timer);
    void Promise.all([server.stop(), settings.stop()]).then(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      process.exit(0);
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
