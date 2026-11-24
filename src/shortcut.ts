// `scopesoup shortcut`: makes the button. On Windows it writes a shortcut (.lnk, through PowerShell's WScript.Shell, no admin)
// named "Scope Soup – <project>" in the person's own Start menu Programs folder, and with --desktop on the Desktop and with
// --startup in the Startup folder (starts at login). Each runs `scopesoup open` (src/open.ts) in the project's repository,
// through the launcher in Scope Soup's home, so it works without the PATH. Every shortcut goes on the manifest (a "folder" entry
// naming the file), so offboarding lists it and deletes it.
//
//   scopesoup shortcut [--name <project>] [--repo <the project's clone>] [--desktop] [--startup] [--config <file>]

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findConfig, installHome } from "./config/locate.ts";
import { recordInManifest } from "./config/manifest.ts";
import { launcherIn } from "./open.ts";

export type Place = "Programs" | "Desktop" | "Startup";

const PLACE_WORDS: Record<Place, string> = { Programs: "Start menu", Desktop: "desktop", Startup: "Startup folder, starts at login" };

export interface ShortcutOptions {
  /** The project's name, for "Scope Soup – <project>". */
  project: string;
  /** The project's repository folder: where `scopesoup open` runs. */
  repo: string;
  places: Place[];
  home: string | null;
  platform: NodeJS.Platform;
  /** The project's config file, for the manifest. */
  configFile: string;
}

/** PowerShell runs `script` with `env` added and returns what it printed. A test fakes it. */
export type RunPowerShell = (script: string, env: Record<string, string>) => string;

export const realPowerShell: RunPowerShell = (script, env) =>
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { encoding: "utf8", env: { ...process.env, ...env }, windowsHide: true, timeout: 60_000 });

/** Writes one shortcut in each place of SS_PLACES and prints its path. The parameters come as variables, never in the text. */
export const SHORTCUT_SCRIPT = [
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "$shell = New-Object -ComObject WScript.Shell",
  "foreach ($place in $env:SS_PLACES.Split(',')) {",
  "  $folder = [Environment]::GetFolderPath($place)",
  "  $link = $shell.CreateShortcut((Join-Path $folder ($env:SS_NAME + '.lnk')))",
  "  $link.TargetPath = $env:SS_TARGET",
  "  $link.Arguments = 'open'",
  "  $link.WorkingDirectory = $env:SS_REPO",
  "  $link.WindowStyle = 7",
  "  $link.Description = 'Starts Scope Soup if it is not running and opens the board'",
  "  $link.Save()",
  "  Write-Output $link.FullName",
  "}",
].join("\n");

/** The shortcut's name for the project, without the characters Windows refuses in a file name. */
export const shortcutName = (project: string): string => `Scope Soup – ${project.replace(/[\\/:*?"<>|\r\n]+/g, " ").trim() || "project"}`;

export function makeShortcuts(options: ShortcutOptions, run: RunPowerShell = realPowerShell): { ok: true; files: { place: Place; file: string }[] } | { ok: false; error: string } {
  if (options.platform !== "win32") return { ok: false, error: "Shortcuts are not supported on this system yet. Run `scopesoup open` in the project's repository." };
  const launcher = launcherIn(options.home, options.platform);
  if (!launcher) return { ok: false, error: "There is no launcher in Scope Soup's home (bin/scopesoup.cmd). Run `setup-home` from the release first." };
  if (!existsSync(options.repo)) return { ok: false, error: `There is no folder ${options.repo}.` };
  const out = run(SHORTCUT_SCRIPT, { SS_PLACES: options.places.join(","), SS_NAME: shortcutName(options.project), SS_TARGET: launcher, SS_REPO: options.repo });
  const lines = out.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  if (lines.length !== options.places.length) return { ok: false, error: `PowerShell made ${lines.length} of ${options.places.length} shortcuts: ${out.trim()}` };
  const files = options.places.map((place, index) => ({ place, file: lines[index]! }));
  recordInManifest(options.configFile, files.map(({ place, file }) => ({ kind: "folder" as const, path: file, what: `a Scope Soup shortcut (${PLACE_WORDS[place]}) that starts Scope Soup and opens the board` })), "shortcut");
  return { ok: true, files };
}

const USAGE = "Usage: scopesoup shortcut [--name <project>] [--repo <the project's clone>] [--desktop] [--startup] [--config <scopesoup.config.json>]";

interface Parsed { name?: string; repo?: string; config?: string; desktop: boolean; startup: boolean }

export function parseArgs(args: string[]): Parsed | null {
  const out: Parsed = { desktop: false, startup: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--desktop") out.desktop = true;
    else if (arg === "--startup") out.startup = true;
    else if ((arg === "--name" || arg === "--repo" || arg === "--config") && args[i + 1] !== undefined) out[arg.slice(2) as "name" | "repo" | "config"] = args[++i]!;
    else return null;
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    console.error(USAGE);
    process.exitCode = 2;
  } else {
    const cwd = process.env.INIT_CWD ?? process.cwd();
    const found = findConfig({ given: parsed.config, cwd });
    if (!found.ok) {
      console.error(found.error);
      process.exitCode = 1;
    } else {
      let repo = resolve(cwd, parsed.repo ?? ".");
      if (!parsed.repo) {
        try {
          repo = resolve(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", windowsHide: true }).trim());
        } catch {
          // Not in a repository: the folder itself.
        }
      }
      const places: Place[] = ["Programs", ...(parsed.desktop ? ["Desktop" as const] : []), ...(parsed.startup ? ["Startup" as const] : [])];
      const result = makeShortcuts({ project: parsed.name ?? basename(repo), repo, places, home: installHome(), platform: process.platform, configFile: found.file });
      if (result.ok) {
        for (const { place, file } of result.files) console.log(`Made ${file} (${PLACE_WORDS[place]}). Offboarding removes it.`);
      } else {
        console.error(result.error);
        process.exitCode = 1;
      }
    }
  }
}
