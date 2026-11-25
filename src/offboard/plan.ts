// The offboarding plan. Pure: from what the scan found now (`Found`: the manifest plus Scope Soup's own names on the remote,
// on GitHub, in the project and on this machine) to a list in five groups, each entry with what removing it does and its
// default. The default is to keep anything that holds work: a branch not merged into the main branch, an open pull request, a
// clone or worktree with changes not pushed. Those are removed only when the person names that group's kept entries too.
// The project's history (merged commits, closed issues and pull requests, comments) is never on the list to change.

import type { ManifestEntry } from "../config/manifestTypes.ts";

export type Group = "work" | "items" | "github" | "project" | "machine";

export const GROUPS: readonly Group[] = ["work", "items", "github", "project", "machine"];

export const GROUP_TITLES: Record<Group, string> = {
  work: "Work in progress",
  items: "Items",
  github: "On GitHub",
  project: "In the project",
  machine: "On this machine",
};

/** What removing an entry does; `none` for what is only listed (kept, or done by the person). */
export type Action =
  | { do: "none" }
  | { do: "close-pull"; number: number }
  | { do: "delete-remote-branch"; branch: string }
  | { do: "delete-local-branch"; repo: string; branch: string }
  | { do: "export-items" }
  | { do: "delete-remote-ref"; ref: string }
  | { do: "delete-label"; name: string }
  | { do: "patch"; path: string; delete: boolean }
  | { do: "delete-path"; path: string }
  | { do: "unregister"; home: string; file: string };

export interface PlanEntry {
  group: Group;
  /** Stable within a plan: what the CLI's report names. */
  key: string;
  what: string;
  /** What happens to it when its group is removed. */
  onRemove: string;
  /** Without a yes for the group everything is kept; with one, "remove" entries go and "keep" ones stay unless named too. */
  default: "keep" | "remove";
  /** Why it is kept by default. */
  why?: string;
  /** Done by the person, not by Scope Soup (the installation, the plugin). */
  manual?: boolean;
  action: Action;
}

export interface PlanGroup {
  group: Group;
  title: string;
  /** One or two plain sentences on the group. */
  intro: string;
  entries: PlanEntry[];
}

export interface OffboardPlan {
  groups: PlanGroup[];
  /** Things to know before anything is removed. */
  notes: string[];
}

export interface FoundBranch {
  name: string;
  sha: string;
  /** Its tip is on the main branch. */
  merged: boolean;
}

export interface FoundLocalBranch extends FoundBranch {
  /** The repository it is in (Scope Soup's clone, or a pool clone's project folder). */
  repo: string;
  /** The remote has the branch at this commit. */
  onRemote: boolean;
}

export interface FoundPull {
  number: number;
  title: string;
  head: string;
}

export interface FoundFolder {
  path: string;
  what: string;
  exists: boolean;
  /** Set when it holds work that is nowhere else: changes not committed, commits not pushed. */
  holdsWork?: string;
  /** Not Scope Soup's: the person's (a pool clone). Listed, never removed. */
  yours?: boolean;
}

/** What the scan found now. Everything is optional in the sense that an empty list means nothing was found. */
export interface Found {
  configFolder: string;
  manifest: ManifestEntry[];
  remote: string | null;
  mainBranch: string;
  /** `refs/scopesoup/*` on the remote. */
  remoteRefs: string[];
  /** `scopesoup/*` branches on the remote. */
  remoteBranches: FoundBranch[];
  /** `scopesoup/*` branches in Scope Soup's clone and the pool clones that the remote does not have at the same commit. */
  localBranches: FoundLocalBranch[];
  /** The repository on GitHub, or null when the project is not on GitHub (nothing to look at there). */
  github: { repo: string; labels: string[]; pulls: FoundPull[] } | { repo: string; problem: string } | null;
  /** Project files on the main branch holding something of Scope Soup's: the path and what. */
  projectFiles: { path: string; change: "claude-md-section" | "plugin-settings" | "setup-script" }[];
  /** Folders and files on this machine, the config folder last. */
  folders: FoundFolder[];
  /** The `.v*` copies kept by format migrations. */
  copies: string[];
  /** Scope Soup's installation. */
  install: string;
  /** Set when the config is on the list of configs this machine knows, in Scope Soup's home `home` (`list` is the file). */
  registered?: { home: string; list: string; file: string } | null;
}

/** Labels Scope Soup makes and names itself; any other label is on the list only when the manifest says Scope Soup created it. */
export const SCOPESOUP_LABELS: readonly string[] = ["scopesoup:needs-decision", "scopesoup:claimed", "scopesoup:assumption", "scopesoup:review"];
/** Put on issues imported into Items: kept by default, it says where each went. */
export const MOVED_LABEL = "moved-to-scopesoup";

const BATCH = /^scopesoup\/batch-\d+-[0-9a-f]{7,40}$/;

const short = (sha: string) => sha.slice(0, 7);

function workGroup(found: Found): PlanEntry[] {
  const entries: PlanEntry[] = [];
  if (found.github && "pulls" in found.github) {
    for (const pull of found.github.pulls) {
      const batch = BATCH.test(pull.head);
      entries.push({
        group: "work", key: `pull ${pull.number}`,
        what: `Open pull request #${pull.number} "${pull.title}" (${pull.head})${batch ? ", a batch left after a failure" : ""}`,
        onRemove: `closed on GitHub, not merged; its comments stay`,
        default: "keep", why: "open: it holds work not on the main branch",
        action: { do: "close-pull", number: pull.number },
      });
    }
  }
  for (const branch of found.remoteBranches) {
    const batch = BATCH.test(branch.name);
    entries.push({
      group: "work", key: `branch ${branch.name}`,
      what: `Branch ${branch.name} on the remote (${short(branch.sha)})${batch ? ", a batch's branch" : ""}${branch.merged ? ", merged" : ", not merged"}`,
      onRemove: "deleted on the remote",
      default: branch.merged ? "remove" : "keep",
      ...(branch.merged ? {} : { why: `not merged into ${found.mainBranch}` }),
      action: { do: "delete-remote-branch", branch: branch.name },
    });
  }
  for (const branch of found.localBranches) {
    const holds = !branch.merged && !branch.onRemote;
    entries.push({
      group: "work", key: `local ${branch.repo} ${branch.name}`,
      what: `Branch ${branch.name} in ${branch.repo} (${short(branch.sha)})${branch.merged ? ", merged" : branch.onRemote ? ", also on the remote" : ", only here"}`,
      onRemove: "deleted in that clone",
      default: holds ? "keep" : "remove",
      ...(holds ? { why: `not merged into ${found.mainBranch} and not on the remote` } : {}),
      action: { do: "delete-local-branch", repo: branch.repo, branch: branch.name },
    });
  }
  return entries;
}

function itemsGroup(found: Found): PlanEntry[] {
  const refs = [...found.remoteRefs].sort();
  const entries: PlanEntry[] = [];
  const meta = refs.includes("refs/scopesoup/meta");
  if (meta) {
    entries.push({
      group: "items", key: "export",
      what: "Export the Items and the shared settings from refs/scopesoup/meta",
      onRemove: "written as Markdown files (one per Item, with its log) to the export folder, before any ref is deleted",
      default: "remove", action: { do: "export-items" },
    });
  }
  for (const ref of refs) {
    const what = ref === "refs/scopesoup/meta" ? "the Items and the shared settings" : ref === "refs/scopesoup/merge-queue" ? "the merge queue lease" : ref.startsWith("refs/scopesoup/resources/") ? "a shared resource's lease" : ref.startsWith("refs/scopesoup/media/") ? "an Item's images" : "Scope Soup's";
    entries.push({
      group: "items", key: `ref ${ref}`,
      what: `${ref} on the remote: ${what}`,
      onRemove: ref === "refs/scopesoup/meta" ? "deleted on the remote, only after the export above worked" : "deleted on the remote",
      default: "remove", action: { do: "delete-remote-ref", ref },
    });
  }
  return entries;
}

function githubGroup(found: Found): PlanEntry[] {
  const gh = found.github;
  if (!gh) return [];
  const entries: PlanEntry[] = [];
  const created = new Set(found.manifest.flatMap((entry) => (entry.kind === "label" && entry.repo.toLowerCase() === gh.repo.toLowerCase() ? [entry.name.toLowerCase()] : [])));
  if ("problem" in gh) {
    entries.push({ group: "github", key: "github", what: `GitHub (${gh.repo}) could not be read: ${gh.problem}`, onRemove: "Nothing: set SCOPESOUP_GITHUB_TOKEN and run it again.", default: "keep", why: "not read", manual: true, action: { do: "none" } });
  } else {
    for (const name of gh.labels) {
      const lower = name.toLowerCase();
      if (lower === MOVED_LABEL) {
        entries.push({ group: "github", key: `label ${name}`, what: `Label ${name}, on the issues imported into Items`, onRemove: "deleted from the repository and so from every issue", default: "keep", why: "it says which issues moved to Items", action: { do: "delete-label", name } });
      } else if (SCOPESOUP_LABELS.includes(lower) || created.has(lower)) {
        entries.push({ group: "github", key: `label ${name}`, what: `Label ${name}${created.has(lower) ? ", created by Scope Soup" : ""}`, onRemove: "deleted from the repository and so from every issue (claims and questions included)", default: "remove", action: { do: "delete-label", name } });
      }
    }
  }
  entries.push({ group: "github", key: "comments", what: "Comments Scope Soup left: claims, logs, questions and answers, triage drafts, batch pull request comments", onRemove: "Kept: they are the project's history.", default: "keep", why: "history is never rewritten", action: { do: "none" } });
  return entries;
}

const PROJECT_TEXT: Record<Found["projectFiles"][number]["change"], string> = {
  "claude-md-section": "the Scope Soup section",
  "plugin-settings": "the Scope Soup plugin lines",
  "setup-script": "the setup script (Scope Soup's setup of a fresh clone)",
};

function projectGroup(found: Found): PlanEntry[] {
  return found.projectFiles.map((file) => ({
    group: "project" as const, key: `file ${file.path}`,
    what: `${file.path} on ${found.mainBranch}: ${PROJECT_TEXT[file.change]}`,
    onRemove: file.change === "setup-script" ? "deleted, in a patch for you to read and commit" : "taken out, in a patch for you to read and commit",
    default: "remove" as const,
    action: { do: "patch" as const, path: file.path, delete: file.change === "setup-script" },
  }));
}

function machineGroup(found: Found): PlanEntry[] {
  const entries: PlanEntry[] = [];
  if (found.registered) {
    const { home, list, file } = found.registered;
    entries.push({ group: "machine", key: "registered", what: `${file} on this machine's list of configs, ${list}: scopesoup commands run in the project's repository use it`, onRemove: "taken off the list", default: "remove", action: { do: "unregister", home, file } });
  }
  for (const copy of found.copies) {
    entries.push({ group: "machine", key: `copy ${copy}`, what: `${copy}: a copy kept by a format migration`, onRemove: "deleted", default: "remove", action: { do: "delete-path", path: copy } });
  }
  for (const folder of found.folders) {
    if (!folder.exists) continue;
    if (folder.yours) {
      entries.push({ group: "machine", key: `folder ${folder.path}`, what: `${folder.path}: ${folder.what}`, onRemove: "Kept: yours, not made by Scope Soup (its scopesoup/* branches are under Work in progress).", default: "keep", why: "not Scope Soup's", action: { do: "none" } });
      continue;
    }
    entries.push({
      group: "machine", key: `folder ${folder.path}`, what: `${folder.path}: ${folder.what}`,
      onRemove: "deleted",
      default: folder.holdsWork ? "keep" : "remove",
      ...(folder.holdsWork ? { why: folder.holdsWork } : {}),
      action: { do: "delete-path", path: folder.path },
    });
  }
  entries.push({ group: "machine", key: "install", what: `Scope Soup's installation, ${found.install}`, onRemove: "Yours to delete when Scope Soup is no longer running.", default: "keep", manual: true, action: { do: "none" } });
  entries.push({ group: "machine", key: "plugin", what: "The Claude Code plugin scopesoup@scopesoup", onRemove: "Yours to uninstall: /plugin uninstall scopesoup@scopesoup", default: "keep", manual: true, action: { do: "none" } });
  return entries;
}

const INTROS: Record<Group, string> = {
  work: "Branches Scope Soup pushed and pull requests it opened. Anything not merged is kept unless you say so for this group's kept entries too: nothing unmerged is lost by default.",
  items: "The Items and settings on the project's meta ref, and Scope Soup's leases. The Items are exported as Markdown files before the ref is deleted.",
  github: "Labels Scope Soup created. Its comments stay: they are history.",
  project: "What onboarding added to the project's files. Taken out as a patch you read and commit; your checkout is not touched.",
  machine: "Scope Soup's clones, worktrees and folders on this machine, the config folder last. Your own checkout and pool clones are never removed.",
};

/** The plan, in the order it is acted on: work, Items (export first), GitHub, the project's patch, then this machine. */
export function offboardPlan(found: Found): OffboardPlan {
  const lists: Record<Group, PlanEntry[]> = {
    work: workGroup(found),
    items: itemsGroup(found),
    github: githubGroup(found),
    project: projectGroup(found),
    machine: machineGroup(found),
  };
  const notes = [
    "Pausing is not leaving: Pause on the overview's lanes and Stop on the board, or level 0, stop Scope Soup's work and can be undone. Nothing below is needed for that.",
    "Stop Scope Soup (Stop on the board, then end the program) before anything is removed.",
    "The project's history is never rewritten: merged commits, closed issues and pull requests, and comments stay.",
  ];
  if (found.github === null) notes.push("The project is not on GitHub (or Scope Soup made nothing there): there is nothing to remove on GitHub.");
  return { groups: GROUPS.map((group) => ({ group, title: GROUP_TITLES[group], intro: INTROS[group], entries: lists[group] })), notes };
}

/** The entries a run removes: of each group with a yes, the "remove" ones, and the "keep" ones too where the person said so. Never a manual one. */
export function chosen(plan: OffboardPlan, remove: ReadonlySet<Group>, includeKept: ReadonlySet<Group>): PlanEntry[] {
  return plan.groups.flatMap((group) =>
    remove.has(group.group) ? group.entries.filter((entry) => !entry.manual && entry.action.do !== "none" && (entry.default === "remove" || includeKept.has(group.group))) : []);
}

/** The plan as text: one block per group. */
export function planText(plan: OffboardPlan): string[] {
  const lines: string[] = [];
  for (const note of plan.notes) lines.push(`- ${note}`);
  for (const group of plan.groups) {
    lines.push("", `${group.title} (${group.group})`, `  ${group.intro}`);
    if (group.entries.length === 0) lines.push("  Nothing found.");
    for (const entry of group.entries) {
      const mark = entry.manual ? "you" : entry.action.do === "none" ? "kept" : entry.default;
      lines.push(`  [${mark}] ${entry.what}`, `         ${entry.manual || entry.action.do === "none" ? entry.onRemove : `on removal: ${entry.onRemove}`}${entry.why && !entry.manual && entry.action.do !== "none" ? ` (kept by default: ${entry.why})` : ""}`);
    }
  }
  return lines;
}

/** `GET /api/offboard`: the plan for the Settings page's "Stop using Scope Soup", read only. */
export type OffboardView =
  | { now: string; available: true; plan: OffboardPlan; configFolder: string; outFolder: string }
  | { now: string; available: false; reason: string };
