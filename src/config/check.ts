// `pnpm config:check [file] [--shared <settings.json>]` (without a file: the config `findConfig` finds, src/config/locate.ts): validates this machine's private file together with the project's
// shared settings, as the orchestrator does, then prints the errors or the recommendations. Used by the
// scopesoup-onboard skill. The shared settings are read from the meta ref (`refs/scopesoup/meta`) of the repository the private file
// names, fetched from its remote first; or with `--shared` from a file (the first person's, before `pnpm settings:init` writes it).
// Exit code 0 when the file is valid (advice or not), 1 when it is missing or invalid.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findConfig } from "./locate.ts";
import { metaSettings } from "./metaSettings.ts";
import { CONFIG_VERSION } from "./migrate.ts";
import { recommendations } from "./recommend.ts";
import { fileSettings, parseShared, repositoryOf, SHARED_WHERE, type SharedSettings, validateFiles } from "./shared.ts";

export interface CheckResult {
  ok: boolean;
  /** What to print, one line each. */
  lines: string[];
}

/** Checks one file. `readFile` is injectable for tests. */
export function checkConfigFile(file: string, readFile: (path: string) => string = (path) => readFileSync(path, "utf8"), shared: SharedSettings = metaSettings()): CheckResult {
  const path = resolve(file);
  let text: string;
  try {
    text = readFile(path);
  } catch (error) {
    return { ok: false, lines: [`Cannot read ${path}: ${message(error)}`] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, lines: [`${path} is not valid JSON: ${message(error)}`] };
  }
  const where = repositoryOf(raw, dirname(path));
  const read = parseShared(shared.read(where.repoPath));
  if (!read.ok) return { ok: false, lines: [read.error] };
  const result = validateFiles(raw, read.raw, dirname(path));
  if (!result.ok) {
    return { ok: false, lines: [`${path} with ${SHARED_WHERE} is not valid. ${result.errors.length} problem(s):`, ...result.errors.map((error) => `- ${error}`)] };
  }
  const { config } = result;
  const lines = [
    `${path} with ${SHARED_WHERE} is valid.`,
    `  project ${JSON.stringify(config.project)}, repoPath ${config.repoPath}, main branch ${config.mainBranch} on ${config.remote}`,
    `  host ${config.host?.kind ?? "(from the environment)"}, workspaces ${config.workspaces.kind}, level ${config.level}${config.level >= 4 ? " (merges through the merge queue)" : ""}`,
  ];
  if (config.host?.kind === "jira") {
    const jira = config.host;
    lines.push(`  Jira ${jira.deployment === "cloud" ? "Cloud" : "Data Center"} ${jira.site}, project ${jira.project}: ${jira.write ? "writes on (issues, comments, labels, properties; changes stay on the git remote)" : "read-only (Scope Soup shows its Items and writes nothing to Jira)"}; token from SCOPESOUP_JIRA_TOKEN${jira.deployment === "cloud" ? ` with ${jira.email ?? "no email"}` : " (a personal access token)"}`);
  }
  // The setup of a fresh clone, as onboarding wrote it.
  if (config.setupCommand) lines.push(`  setup ${config.setupCommand.join(" ")}, again when ${config.setupWatch ? config.setupWatch.join(", ") || "nothing (it runs once per folder)" : "a lockfile"} changes`);
  // The check only reads: an older format is migrated, and written, when Scope Soup starts.
  if (result.from < CONFIG_VERSION) lines.push(`  The file is format ${result.from}: Scope Soup migrates it to format ${CONFIG_VERSION} when it starts, keeping a copy of the old file. It changes:`);
  for (const notice of result.notices) lines.push(`  Notice: ${notice}`);
  const advice = recommendations(config);
  if (advice.length === 0) lines.push("No recommendations.");
  else lines.push("Recommendations:", ...advice.map((line) => `- ${line}`));
  return { ok: true, lines };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--shared");
  const sharedPath = at < 0 ? undefined : args[at + 1];
  // pnpm runs the script in Scope Soup's folder; relative paths and the repository are the ones the person typed it in.
  const base = process.env.INIT_CWD ?? process.cwd();
  const found = findConfig({ given: args.find((arg, index) => !arg.startsWith("--") && (at < 0 || index !== at + 1)), cwd: base });
  const file = found.file;
  const run = async (): Promise<void> => {
    if (!found.ok) {
      console.log(found.error);
      process.exitCode = 1;
      return;
    }
    let shared: SharedSettings;
    if (sharedPath) shared = fileSettings(resolve(base, sharedPath));
    else {
      // A person joining a project fetches its shared settings here first (a clone does not bring refs/scopesoup/meta).
      const meta = metaSettings();
      shared = meta;
      try {
        const raw = JSON.parse(readFileSync(resolve(file), "utf8")) as unknown;
        const where = repositoryOf(raw, dirname(resolve(file)));
        if (where.machine) {
          const report = await meta.fetch(where.repoPath, where.remote, where.machine);
          if (report.problem) console.log(`Fetching the shared settings: ${report.problem}`);
        }
      } catch {
        // The check below says what is wrong with the file.
      }
      await meta.stop();
    }
    const result = checkConfigFile(file, undefined, shared);
    for (const line of result.lines) console.log(line);
    process.exitCode = result.ok ? 0 : 1;
  };
  void run();
}
