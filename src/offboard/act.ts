// Offboarding's removals, only for the entries the person said yes to (`chosen` in plan.ts). In the plan's order: work in
// progress, the Items (exported to Markdown before any ref is deleted, and the meta ref kept when the export failed), GitHub,
// the project's patch (written to the export folder for the person to commit; Scope Soup's clone is used to make it, the person's
// checkout never), then this machine, the config folder last. Every step says what it did; a failed step stops nothing else
// but what depends on it. Nothing is forced: a branch or ref is deleted with a plain push, a path only when it is Scope Soup's.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knownConfigsPath, unregisterConfig } from "../config/locate.ts";
import { overlaps, within } from "../config/validate.ts";
import { META_REF } from "../hosts/metaBranch/settings.ts";
import type { Git } from "../orchestrator/process.ts";
import type { OffboardPlan, PlanEntry } from "./plan.ts";
import { strippedFile } from "./projectFiles.ts";
import type { OffboardGitHub, OffboardSetup } from "./scan.ts";

export interface ActOptions {
  git: Git;
  setup: OffboardSetup;
  github?: OffboardGitHub | null;
  /** Where the Items, the patch and the report go. Must be outside every folder that is removed. */
  out: string;
  /** Scope Soup's installation: never removed. */
  install: string;
}

export interface ActReport {
  done: string[];
  failed: string[];
  kept: string[];
  /** Files written to the export folder. */
  written: string[];
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

async function run(git: Git, args: string[], cwd: string, input?: string, env?: Record<string, string>): Promise<string> {
  const result = await git(args, cwd, input, env);
  if (result.code !== 0) throw new Error(`git ${args[0]}: ${(result.stderr || result.stdout).trim().split("\n")[0] ?? "failed"}`);
  return result.stdout;
}

/**
 * The Items and shared settings of the remote's meta ref (singleplayer: the one in Scope Soup's clone, nothing fetched), as
 * Markdown files: `items/<id>.md` (item.md, then its log).
 */
export async function exportItems(git: Git, setup: Pick<OffboardSetup, "repoPath" | "remote" | "singleplayer">, out: string): Promise<string[]> {
  const repo = setup.repoPath;
  if (!setup.singleplayer) await run(git, ["fetch", "-q", "--no-tags", setup.remote, META_REF], repo);
  const sha = (await run(git, ["rev-parse", "--verify", setup.singleplayer ? `${META_REF}^{commit}` : "FETCH_HEAD"], repo)).trim();
  const paths = (await run(git, ["ls-tree", "-r", "--name-only", sha], repo)).split("\n").filter(Boolean);
  const show = (path: string) => run(git, ["show", `${sha}:${path}`], repo);
  const written: string[] = [];
  const write = (name: string, text: string) => {
    const path = join(out, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
    written.push(path);
  };
  const ids = [...new Set(paths.flatMap((path) => {
    const match = /^items\/([^/]+)\/item\.md$/.exec(path);
    return match && ID.test(match[1] ?? "") ? [match[1] as string] : [];
  }))];
  for (const id of ids) {
    const item = await show(`items/${id}/item.md`);
    const log = paths.includes(`items/${id}/log.jsonl`) ? await show(`items/${id}/log.jsonl`) : "";
    const tail = log.trim() === "" ? "" : `\n\n## Log, as Scope Soup kept it\n\n\`\`\`jsonl\n${log.trimEnd()}\n\`\`\`\n`;
    write(join("items", `${id}.md`), `${item.trimEnd()}\n${tail}`);
  }
  if (paths.includes("settings/settings.json")) write("settings.json", await show("settings/settings.json"));
  if (paths.includes("settings/log.jsonl")) write("settings-log.jsonl", await show("settings/log.jsonl"));
  write("README.md", [
    "# Exported from Scope Soup",
    "",
    `The Items and shared settings of \`${META_REF}\` at commit ${sha}, exported when Scope Soup was offboarded.`,
    `\`items/<id>.md\` is each Item as Scope Soup kept it (a header between \`---\` lines, then the description), followed by its log. ${ids.length} Item(s).`,
    "",
  ].join("\n"));
  return written;
}

/** One patch of the project's files without Scope Soup's parts, made from the main branch in Scope Soup's clone with a scratch index. */
export async function projectPatch(git: Git, setup: OffboardSetup, entries: PlanEntry[]): Promise<string> {
  const repo = setup.repoPath;
  await run(git, ["fetch", "-q", "--no-tags", setup.remote, `refs/heads/${setup.mainBranch}`], repo);
  const main = (await run(git, ["rev-parse", "FETCH_HEAD"], repo)).trim();
  const scratch = mkdtempSync(join(tmpdir(), "scopesoup-offboard-"));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, "index") };
    await run(git, ["read-tree", main], repo, undefined, env);
    for (const entry of entries) {
      if (entry.action.do !== "patch") continue;
      const path = entry.action.path;
      const text = await run(git, ["show", `${main}:${path}`], repo);
      const next = strippedFile(path, text);
      if (next === undefined) continue;
      if (next === null) await run(git, ["update-index", "--force-remove", "--", path], repo, undefined, env);
      else {
        const blob = (await run(git, ["hash-object", "-w", "--stdin"], repo, next)).trim();
        await run(git, ["update-index", "--cacheinfo", `100644,${blob},${path}`], repo, undefined, env);
      }
    }
    const tree = (await run(git, ["write-tree"], repo, undefined, env)).trim();
    return await run(git, ["diff", "--binary", main, tree], repo);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Why a path may not be removed, or null: it must not be or hold the person's checkout, a real path, the installation or the export folder. */
export function pathRefusal(path: string, setup: OffboardSetup, install: string, out: string): string | null {
  for (const each of setup.protectedPaths) if (overlaps(each, path)) return `it overlaps your own ${each}`;
  for (const each of setup.pool) if (overlaps(each.clone, path)) return `it overlaps the pool clone ${each.clone}`;
  if (overlaps(install, path)) return "it overlaps Scope Soup's installation";
  if (within(path, out)) return "the export folder is inside it";
  if (/^([A-Za-z]:)?[\\/]*$/.test(path)) return "it is a drive's root";
  return null;
}

export async function act(plan: OffboardPlan, entries: PlanEntry[], options: ActOptions): Promise<ActReport> {
  const { git, setup } = options;
  const report: ActReport = { done: [], failed: [], kept: [], written: [] };
  const picked = new Set(entries.map((entry) => entry.key));
  for (const group of plan.groups) for (const entry of group.entries) if (!picked.has(entry.key) && !entry.manual) report.kept.push(entry.what);
  mkdirSync(options.out, { recursive: true });
  const repo = setup.repoPath;
  let exported: boolean | null = null;
  const step = async (entry: PlanEntry, work: () => Promise<string | void>) => {
    try {
      const said = await work();
      report.done.push(said ?? entry.what);
    } catch (error) {
      report.failed.push(`${entry.what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const patches = entries.filter((entry) => entry.action.do === "patch");
  for (const entry of entries) {
    const action = entry.action;
    switch (action.do) {
      case "none":
        break;
      case "close-pull":
        await step(entry, async () => {
          if (!options.github) throw new Error("GitHub is not reachable (SCOPESOUP_GITHUB_TOKEN)");
          await options.github.closePull(action.number);
          return `Closed pull request #${action.number}`;
        });
        break;
      case "delete-remote-branch":
        await step(entry, async () => {
          await run(git, ["push", "-q", setup.remote, "--delete", `refs/heads/${action.branch}`], repo);
          return `Deleted ${action.branch} on the remote`;
        });
        break;
      case "delete-local-branch":
        await step(entry, async () => {
          // A pool clone may have it checked out: step off it at the same commit, only when nothing is changed there.
          const current = (await git(["symbolic-ref", "-q", "--short", "HEAD"], action.repo)).stdout.trim();
          if (current === action.branch) {
            if ((await run(git, ["status", "--porcelain"], action.repo)).trim() !== "") throw new Error("it is checked out with changes not committed");
            await run(git, ["checkout", "-q", "--detach"], action.repo);
          }
          await run(git, ["branch", "-q", "-D", action.branch], action.repo);
          return `Deleted ${action.branch} in ${action.repo}`;
        });
        break;
      case "export-items":
        await step(entry, async () => {
          const written = await exportItems(git, setup, options.out);
          report.written.push(...written);
          exported = true;
          return `Exported the Items to ${options.out}`;
        });
        exported ??= false;
        break;
      case "delete-remote-ref":
        await step(entry, async () => {
          if (action.ref === META_REF && exported !== true) throw new Error("kept: the Items were not exported first");
          await run(git, ["push", "-q", setup.remote, "--delete", action.ref], repo);
          // So that Scope Soup's clone does not push it back if it is kept.
          await git(["update-ref", "-d", action.ref], repo);
          return `Deleted ${action.ref} on the remote`;
        });
        break;
      case "delete-label":
        await step(entry, async () => {
          if (!options.github) throw new Error("GitHub is not reachable (SCOPESOUP_GITHUB_TOKEN)");
          await options.github.deleteLabel(action.name);
          return `Deleted the label ${action.name}`;
        });
        break;
      case "patch":
        if (entry !== patches[0]) break;
        try {
          const patch = await projectPatch(git, setup, patches);
          const file = join(options.out, "scopesoup-offboard.patch");
          writeFileSync(file, patch);
          report.written.push(file);
          report.done.push(`Wrote ${file}: ${patches.map((each) => (each.action.do === "patch" ? each.action.path : "")).join(", ")} without Scope Soup's parts. Apply it in your checkout (git apply) and commit it.`);
        } catch (error) {
          report.failed.push(`The project's patch: ${error instanceof Error ? error.message : String(error)}`);
        }
        break;
      case "unregister":
        await step(entry, async () => {
          unregisterConfig(action.home, action.file);
          return `Took ${action.file} off ${knownConfigsPath(action.home)}`;
        });
        break;
      case "delete-path":
        await step(entry, async () => {
          const refused = pathRefusal(action.path, setup, options.install, options.out);
          if (refused) throw new Error(`not removed: ${refused}`);
          rmSync(action.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
          return `Deleted ${action.path}`;
        });
        break;
    }
  }
  // Worktrees whose folders went are forgotten by Scope Soup's clone, when it is kept.
  if (entries.some((entry) => entry.action.do === "delete-path") && existsSync(repo)) await git(["worktree", "prune"], repo).catch(() => undefined);
  return report;
}

export function reportText(report: ActReport, out: string): string[] {
  return [
    `Done (${report.done.length}):`, ...report.done.map((line) => `- ${line}`),
    ...(report.failed.length > 0 ? [`Not done (${report.failed.length}):`, ...report.failed.map((line) => `- ${line}`)] : []),
    `Kept (${report.kept.length}):`, ...report.kept.map((line) => `- ${line}`),
    ...(report.written.length > 0 ? [`Written to ${out}:`, ...report.written.map((line) => `- ${line}`)] : []),
  ];
}
