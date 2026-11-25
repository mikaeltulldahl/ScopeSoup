// The demo's History: SYNTHETIC activity and a SYNTHETIC commit history for the imaginary tide-table project. The
// demo has no git repository of the project, so its commits are made up here and linked to its Items the way the real
// history is (src/core/commitLinks.ts). Nothing here comes from a real project.

import { commitLinks, linkCommit } from "../core/commitLinks.ts";
import { layoutLanes } from "../core/graph.ts";
import type { SettingsSave } from "../core/activity.ts";
import { at as plus, ref } from "../core/testing.ts";
import type { CommitView, HistoryCommit, HistoryView } from "../core/views.ts";
import type { LogRecord, LogWriter, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import type { Store } from "../store/store.ts";

/** A made-up full commit id, the same for the same word. */
export function demoSha(word: string): string {
  let hash = 2166136261;
  for (const char of word) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  let out = "";
  for (let i = 0; out.length < 40; i++) {
    hash = Math.imul(hash ^ i, 16777619) >>> 0;
    out += (hash >>> 28).toString(16);
  }
  return out;
}

const HOUR = 60;
const DAY = 24 * HOUR;
const PEOPLE = ["mira", "jonas", "ines", "robin"];
const MACHINES: Record<string, string> = { mira: "demo", jonas: "laptop-b", ines: "laptop-c", robin: "laptop-d" };
const person = (who: string): LogWriter => ({ who, machine: MACHINES[who] ?? "demo", agent: false });
const SOUP: LogWriter = { who: "scopesoup", machine: "demo", agent: true };
/** The done Items merged by batch 4 (their changes 130, 131 and 133), with the commits that merged them. */
const MERGED_BY_BATCH_4 = [30, 31, 33];

/**
 * Activity that the seeded board alone does not show: who created each Item, a triage draft accepted, a question
 * answered, the merges of batch 4 in the Items' logs, switches pressed and an upgrade. Times are before `now`.
 */
export function seedDemoActivity(store: Store, now: Date, version: string): void {
  const base = now.toISOString();
  const at = (minutes: number) => plus(minutes, base);
  store.tx(() => {
    for (const work of store.list<WorkItem>("work", "demo")) {
      const id = Number(work.ref.id);
      const log: LogRecord[] = [...(work.log ?? [])];
      if (!log.some((line) => line.kind === "created")) {
        // Older Items were filed earlier: from about six days ago (#30) to about a day ago (#82).
        const created = at(-Math.round((90 - id) * 2.4 * HOUR + (id % 5) * 17));
        log.unshift({ at: created, by: person(PEOPLE[id % PEOPLE.length]!), kind: "created", fields: {} });
      }
      const extra: LogRecord[] = [];
      const createdAt = Date.parse(log[0]!.at);
      const after = (minutes: number) => new Date(createdAt + minutes * 60_000).toISOString();
      if (id === 30) extra.push({ at: after(50), by: person("robin"), kind: "edited", fields: { changed: "description", via: "triage, round 1", was: "A list of harbours." } });
      if (id === 31) {
        extra.push({ at: after(40), by: SOUP, kind: "question", fields: { question: "Does the day view show the next tide or the whole day?", options: [{ label: "The whole day", description: "" }, { label: "The next tide", description: "" }], recommendation: "The whole day" } });
        extra.push({ at: after(95), by: person("jonas"), kind: "answer", fields: { answer: "The whole day", to: after(40), toBy: SOUP } });
      }
      if (MERGED_BY_BATCH_4.includes(id)) extra.push({ at: at(-183), by: SOUP, kind: "merged", fields: { sha: demoSha(`merged-${id}`), target: "main", batch: 4 } });
      if (extra.length > 0 || log.length !== (work.log ?? []).length) {
        store.put({ ...work, log: [...log, ...extra].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)) }, "demo", base);
      }
    }
    const event = (minutes: number, kind: string, actor: string, data: Record<string, unknown> = {}, subject?: string) =>
      store.appendEvent({ kind, actor, data, ...(subject ? { subject } : {}) }, at(minutes));
    const [major, minor] = version.split(".").map(Number);
    event(-3 * DAY - 2 * HOUR, "scopesoup.upgraded", "scopesoup", { from: `${major}.${Math.max(0, (minor ?? 1) - 1)}.4`, to: version });
    event(-2 * DAY - 5 * HOUR, "control.stopped", "mira", { via: "board", triage: "started", implement: "started", review: "started", mergeQueue: "started" });
    for (const name of ["triage", "implement", "review", "merge_queue"]) event(-2 * DAY - 4 * HOUR, `control.${name}_started`, "mira", { via: "board" });
    event(-26 * HOUR, "control.implement_paused", "jonas", { via: "board" });
    event(-25 * HOUR, "control.implement_started", "jonas", { via: "board" });
    event(-400, "orchestrator.draft_rejected", "ines", { reason: "A person rejected the triage's rewrite (round 1).", round: 1 }, refKey(ref("work", 64)));
  });
}

/**
 * The demo's History of settings: the saves made on the demo's own page since it started, then synthetic older ones
 * (the real first save, made when the demo starts, is left out: the synthetic history has its own).
 */
export function demoSettingsLog(real: SettingsSave[], started: Date): SettingsSave[] {
  const at = (minutes: number) => plus(minutes, started.toISOString());
  const since = real.filter((entry) => Date.parse(entry.at) > started.getTime());
  const older: SettingsSave[] = [
    { at: at(-20 * HOUR), who: "ines", machine: "laptop-c", changes: [{ key: "settings.stallTimeoutMinutes.value", from: 10, to: 15 }, { key: "settings.stallTimeoutMinutes.reason", from: "Default.", to: "The browser suite is quiet for long stretches." }] },
    { at: at(-2 * DAY - 3 * HOUR), who: "jonas", machine: "laptop-b", changes: [{ key: "level", from: 3, to: 4 }, { key: "checkCommand", to: ["pnpm", "run", "check"] }] },
    { at: at(-4 * DAY), who: "mira", machine: "demo", changes: [{ key: "roles.triage.model", from: "haiku" }] },
    { at: at(-5 * DAY - 6 * HOUR), who: "robin", machine: "laptop-d", changes: [{ key: "level", from: 2, to: 3 }, { key: "roles.triage.model", to: "haiku" }] },
    { at: at(-6 * DAY - 8 * HOUR), who: "Ada", machine: "demo", changes: ["project", "level", "bugLabels", "setupCommand", "setupWatch", "sharedResources"].map((key) => ({ key, to: key === "level" ? 2 : key })) },
  ];
  return [...since, ...older];
}

interface DemoCommit {
  sha: string;
  parents: string[];
  author: string;
  at: string;
  subject: string;
}

const FILLER = [
  "Update the tide data for the test harbours",
  "Tidy the day view's styles",
  "Faster start on old phones",
  "Bump the build tools",
  "Fix a typo in the first-run screen",
  "Clearer error when the tide source is down",
  "Move the harbour list to its own file",
  "Translate the settings screen",
];

/** The made-up commits, newest first: a main branch over nine days and the open Items' branches. */
function demoCommits(now: Date): { commits: DemoCommit[]; tips: Map<string, string[]>; main: Set<string> } {
  const base = now.toISOString();
  const at = (minutes: number) => plus(-minutes, base);
  const main: DemoCommit[] = [];
  // Oldest first while building: 44 commits on main, one about every five hours.
  // The last merges are the Items' own: #36 half a day ago, then batch 4's three at the time the batch merged.
  const merges = new Map<number, [number, string, string, number]>([
    [40, [36, "Times in the harbour's own time zone", demoSha("zone-merged"), 720]],
    [41, [30, "Pick a harbour from a list", demoSha("merged-30"), 185]],
    [42, [31, "Today's high and low tide", demoSha("merged-31"), 184]],
    [43, [33, "App icon and name", demoSha("merged-33"), 183]],
  ]);
  for (let i = 0; i < 44; i++) {
    const merge = merges.get(i);
    const sha = merge ? merge[2] : demoSha(`main-${i}`);
    const subject = merge ? `${merge[1]} (#${merge[0]})` : i === 0 ? "First commit: an empty app" : FILLER[i % FILLER.length]!;
    main.push({ sha, parents: i === 0 ? [] : [main[i - 1]!.sha], author: merge ? "Scope Soup agent" : PEOPLE[i % PEOPLE.length]!, at: at(merge ? merge[3] : (44 - i) * 5 * HOUR), subject });
  }
  const off = (index: number) => main[index]!.sha;
  const branch: DemoCommit[] = [
    { sha: demoSha("wind-1"), parents: [off(38)], author: "Scope Soup agent", at: at(70), subject: "Wind arrows on the hourly view" },
    { sha: demoSha("search-1"), parents: [off(39)], author: "Scope Soup agent", at: at(25), subject: "Harbour search that forgives typos" },
    { sha: demoSha("sunrise-1"), parents: [off(37)], author: "Scope Soup agent", at: at(165), subject: "Sunrise and sunset row" },
    { sha: demoSha("sunrise-2"), parents: [demoSha("sunrise-1")], author: "Scope Soup agent", at: at(106), subject: "Sunrise and sunset in the harbour's own time zone" },
  ];
  const commits = [...main, ...branch].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const tips = new Map<string, string[]>([
    // #58's branch was just made from the tip of main: it starts there and has nothing of its own yet.
    [main.at(-1)!.sha, ["main", "scopesoup/58"]],
    [demoSha("wind-1"), ["scopesoup/60"]],
    [demoSha("search-1"), ["scopesoup/63"]],
    [demoSha("sunrise-2"), ["scopesoup/66"]],
  ]);
  return { commits, tips, main: new Set(main.map((each) => each.sha)) };
}

export function demoHistory(store: Store, now: Date, requested: number): HistoryView {
  const limit = Math.min(500, Math.max(1, Number.isFinite(requested) ? Math.floor(requested) : 50));
  const { commits, tips, main } = demoCommits(now);
  const shown = commits.slice(0, limit);
  const links = commitLinks(store.list<WorkItem>("work"), (work) => `scopesoup/${work.ref.id}`);
  const layout = layoutLanes(shown);
  const rows: HistoryCommit[] = shown.map((commit, index) => {
    const refs = tips.get(commit.sha) ?? [];
    const onMain = main.has(commit.sha);
    return { ...commit, refs, onMain, ...linkCommit({ sha: commit.sha, subject: commit.subject, refs, onMain, firstParent: onMain }, links), graph: layout.rows[index]! };
  });
  return { now: now.toISOString(), available: true, mainBranch: "main", commits: rows, lanes: layout.lanes, limit, more: commits.length > limit };
}

export function demoCommit(sha: string, now: Date): CommitView {
  const commit = demoCommits(now).commits.find((each) => each.sha.startsWith(sha));
  if (!commit) return { now: now.toISOString(), available: false, reason: `No commit ${sha} in the demo's history.` };
  const file = commit.subject.toLowerCase().includes("tide") ? "src/day/tides.ts" : "src/app/changes.ts";
  const diff = `@@ -1,2 +1,3 @@\n export const harbours = loadHarbours();\n+// ${commit.subject}\n export const days = 7;\n`;
  return {
    now: now.toISOString(), available: true, sha: commit.sha,
    message: `${commit.subject}\n\nA synthetic commit of the demo's made-up history.`,
    files: [{ path: file, added: 1, removed: 0, binary: false, diff }], omitted: 0, totalAdded: 1, totalRemoved: 0,
  };
}
