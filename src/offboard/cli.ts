// `pnpm offboard`: stop using Scope Soup on a project and leave nothing behind that the person did not choose to keep.
//
//   pnpm offboard [--config <scopesoup.config.json>] [--data <folder>]            the plan, grouped; nothing is changed
//   pnpm offboard --remove work,items,github,project,machine [--include-kept work,...] [--out <folder>]
//   pnpm offboard record setup-script|claude-md|plugin-settings [--config <scopesoup.config.json>]
//
// Without --remove it only shows the plan. With it, only the groups named are acted on, and in each only the entries whose
// default is "remove"; --include-kept names the groups whose kept entries (unmerged branches, open pull requests, folders with
// work in them) go too. Acting needs Scope Soup stopped: it refuses while the board answers on SCOPESOUP_PORT (default 4310).
// `record` is how the onboarding skill notes what it changed in the project (the manifest, `src/config/manifest.ts`).
// Exit code 0 when everything asked was done, 1 when something was not, 2 for a wrong command line.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { findConfig, installHome } from "../config/locate.ts";
import { recordInManifest, type ManifestThing } from "../config/manifest.ts";
import { realGit, type Git } from "../orchestrator/process.ts";
import { act, reportText } from "./act.ts";
import { githubPort } from "./github.ts";
import { chosen, GROUPS, offboardPlan, planText, type Group, type OffboardPlan } from "./plan.ts";
import { defaultOutFolder, readSetup, scan, type OffboardGitHub, type OffboardSetup } from "./scan.ts";
import { CLAUDE_MD, PLUGIN_SETTINGS, SETUP_SCRIPT } from "./projectFiles.ts";

export const INSTALL = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const USAGE = "Usage: pnpm offboard [--config <scopesoup.config.json>] [--data <folder>] [--remove <groups>|all] [--include-kept <groups>|all] [--out <folder>]\n       pnpm offboard record setup-script|claude-md|plugin-settings [--config <scopesoup.config.json>]";

export interface PlanOptions {
  git?: Git;
  /** Made from the GitHub repository the setup names; default: the real one with SCOPESOUP_GITHUB_TOKEN, or none. */
  github?: (repo: string) => OffboardGitHub | null;
  dataDir?: string;
  install?: string;
  /** Scope Soup's home, whose list of configs the config is taken off; default `installHome()`, null for none. */
  home?: string | null;
}

/** Reads and scans, then plans: what the CLI prints and the Settings page shows. Reads only. */
export async function planFor(configFile: string, options: PlanOptions = {}): Promise<{ setup: OffboardSetup; plan: OffboardPlan; github: OffboardGitHub | null }> {
  const git = options.git ?? realGit;
  const setup = await readSetup(configFile, git);
  const token = process.env.SCOPESOUP_GITHUB_TOKEN;
  const github = setup.githubRepo ? (options.github ? options.github(setup.githubRepo) : token ? githubPort(token, setup.githubRepo) : null) : null;
  const found = await scan(setup, { git, github, install: options.install ?? INSTALL, home: options.home === undefined ? installHome() : options.home, ...(options.dataDir ? { dataDir: options.dataDir } : {}) });
  const plan = offboardPlan(found);
  if (setup.problems.length > 0) plan.notes.push(...setup.problems);
  return { setup, plan, github };
}

/** Parses a list of groups ("all" for every one); throws on a name that is not a group. */
export function parseGroups(text: string | undefined): Set<Group> {
  if (!text) return new Set();
  if (text.trim() === "all") return new Set(GROUPS);
  const out = new Set<Group>();
  for (const name of text.split(",").map((each) => each.trim()).filter(Boolean)) {
    if (!(GROUPS as readonly string[]).includes(name)) throw new Error(`${name} is not a group: give ${GROUPS.join(", ")} or all`);
    out.add(name as Group);
  }
  return out;
}

/** True when a Scope Soup board answers on the port: acting then is refused. */
export async function boardRunning(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

export interface RunOptions extends PlanOptions {
  remove: Set<Group>;
  includeKept: Set<Group>;
  out?: string;
  running?: () => Promise<boolean>;
}

/** The whole command: prints the plan, and acts when groups were given. */
export async function offboard(configFile: string, options: RunOptions): Promise<{ ok: boolean; lines: string[] }> {
  const { setup, plan, github } = await planFor(configFile, options);
  if (options.remove.size === 0) {
    return {
      ok: true,
      lines: [
        "What Scope Soup left for this project, grouped. [remove] goes when you say yes for its group; [keep] stays unless you also name that group with --include-kept.",
        ...planText(plan),
        "", "Nothing was changed. To remove, name the groups: pnpm offboard --remove <groups> (and --include-kept <groups> for their kept entries).",
      ],
    };
  }
  const lines = [`Removing: ${[...options.remove].join(", ")}${options.includeKept.size > 0 ? `; kept entries too in: ${[...options.includeKept].join(", ")}` : ""}.`];
  if (await (options.running ?? (() => boardRunning(Number(process.env.SCOPESOUP_PORT ?? 4310))))()) {
    lines.push("Scope Soup is still running (its board answers). Press Stop on the board, end the program, and run this again. Nothing was changed.");
    return { ok: false, lines };
  }
  const out = resolve(options.out ?? defaultOutFolder(setup.configFolder));
  const entries = chosen(plan, options.remove, options.includeKept);
  const report = await act(plan, entries, { git: options.git ?? realGit, setup, github, out, install: options.install ?? INSTALL });
  const text = reportText(report, out);
  writeFileSync(join(out, "report.txt"), text.join("\n") + "\n");
  lines.push("", ...text, `The report is in ${join(out, "report.txt")}.`);
  return { ok: report.failed.length === 0, lines };
}

/** What `pnpm offboard record <what>` notes on the manifest. */
export function recordThings(what: string): ManifestThing[] | null {
  if (what === "setup-script") return [{ kind: "project-file", path: SETUP_SCRIPT, change: "setup-script" }, { kind: "branch", branch: "scopesoup/onboard", what: "the setup script, for the person to merge" }];
  if (what === "claude-md") return [{ kind: "project-file", path: CLAUDE_MD, change: "claude-md-section" }];
  if (what === "plugin-settings") return [{ kind: "project-file", path: PLUGIN_SETTINGS, change: "plugin-settings" }];
  return null;
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      options: { config: { type: "string" }, data: { type: "string" }, remove: { type: "string" }, "include-kept": { type: "string" }, out: { type: "string" } },
      allowPositionals: true, strict: true,
    });
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  // pnpm runs the script in Scope Soup's folder; a relative path means the one the person typed it in.
  const base = process.env.INIT_CWD ?? process.cwd();
  const found = findConfig({ given: parsed.values.config, cwd: base });
  if (!found.ok) {
    console.error(found.error);
    process.exitCode = 1;
    return;
  }
  const configFile = found.file;
  if (parsed.positionals[0] === "record") {
    const things = recordThings(parsed.positionals[1] ?? "");
    if (!things) {
      console.error(USAGE);
      process.exitCode = 2;
      return;
    }
    const added = recordInManifest(configFile, things, "onboarding");
    console.log(added.length > 0 ? `Noted on ${join(dirname(configFile), "scopesoup.manifest.jsonl")}.` : "Already noted.");
    return;
  }
  if (parsed.positionals.length > 0) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  let remove: Set<Group>;
  let includeKept: Set<Group>;
  try {
    remove = parseGroups(parsed.values.remove);
    includeKept = parseGroups(parsed.values["include-kept"]);
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const data = parsed.values.data ?? process.env.SCOPESOUP_DATA;
  const result = await offboard(configFile, {
    remove, includeKept,
    ...(data ? { dataDir: resolve(base, data) } : {}),
    ...(parsed.values.out ? { out: resolve(base, parsed.values.out) } : {}),
  });
  for (const line of result.lines) console.log(line);
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
