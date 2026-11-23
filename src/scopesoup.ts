// The one command a person and a project's sessions call: `scopesoup <command> ...`, through the launcher in Scope Soup's
// home (src/upgrade/home.ts), which runs this file of the current version. Each command is one of the scripts a release
// has; this file only picks it, so `scopesoup item list` is `pnpm item list` without a path.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setupHome } from "./upgrade/home.ts";
import { versionOf } from "./upgrade/version.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Each command and the file that runs it, relative to the version's folder. */
export const COMMANDS: Readonly<Record<string, string>> = {
  start: "src/main.ts",
  item: "src/item.ts",
  "config:check": "src/config/check.ts",
  "config:register": "src/config/register.ts",
  "config:setup": "src/config/setupScript.ts",
  "settings:init": "src/config/settingsInit.ts",
  offboard: "src/offboard/cli.ts",
  "meta:accept": "src/hosts/metaBranch/accept.ts",
};

const USAGE = [
  "usage: scopesoup <command> [...]",
  "  start           start Scope Soup (the board on http://127.0.0.1:4310)",
  "  item ...        file, claim, hand back and list Items",
  "  config:check    check this machine's scopesoup.config.json",
  "  config:register put a project's scopesoup.config.json on this machine's list, so commands run in its repository find it",
  "  version         print the version that runs",
  "  setup-home      make this release Scope Soup's current version and write the launcher (once, after unpacking)",
  `  also: ${Object.keys(COMMANDS).filter((name) => !["start", "item", "config:check", "config:register"].includes(name)).join(", ")}`,
].join("\n");

async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command === "version" || command === "--version") {
    console.log(versionOf(root));
    return;
  }
  if (command === "setup-home") {
    const setup = setupHome(root);
    console.log(`Scope Soup's home: ${setup.home}`);
    console.log(`Current version: ${setup.current}`);
    console.log(`Launcher: ${join(setup.bin, process.platform === "win32" ? "scopesoup.cmd" : "scopesoup")}`);
    for (const line of setup.pathAdvice) console.log(line);
    return;
  }
  const file = command ? COMMANDS[command] : undefined;
  if (!file) {
    console.error(USAGE);
    process.exitCode = command ? 2 : 0;
    return;
  }
  // The script sees itself as the program that was started, as under `node <file>`.
  const path = join(root, file);
  process.argv = [process.argv[0]!, path, ...rest];
  await import(pathToFileURL(path).href);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
