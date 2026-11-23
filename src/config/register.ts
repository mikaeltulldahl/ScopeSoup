// `scopesoup config:register <scopesoup.config.json>`: puts a project's config on the list of configs this machine knows, in
// Scope Soup's home, so commands run in the project's repository find it without --config (src/config/locate.ts). The onboarding
// skill runs it after the config checks clean; offboarding takes the config off the list.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installHome, knownConfigsPath, registerConfig } from "./locate.ts";

const USAGE = "Usage: scopesoup config:register <path to scopesoup.config.json>";

/** Registers `file` in `home`: the lines to print and whether it worked. */
export function register(home: string | null, file: string): { ok: boolean; lines: string[] } {
  if (!home) return { ok: false, lines: ["This Scope Soup is not installed in a home (a development checkout): there is no list of configs. Give --config or set SCOPESOUP_CONFIG."] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { ok: false, lines: [existsSync(file) ? `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}` : `There is no file ${file}.`] };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, lines: [`${file} is not a Scope Soup config (not a JSON object).`] };
  const added = registerConfig(home, file);
  return { ok: true, lines: [added ? `Added ${file} to ${knownConfigsPath(home)}: scopesoup commands run in the project's repository use it.` : `${file} is on ${knownConfigsPath(home)} already.`] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0]!.startsWith("-")) {
    console.error(USAGE);
    process.exitCode = 2;
  } else {
    // pnpm runs the script in Scope Soup's folder; a relative path means the one the person typed it in.
    const result = register(installHome(), resolve(process.env.INIT_CWD ?? process.cwd(), args[0]!));
    for (const line of result.lines) (result.ok ? console.log : console.error)(line);
    process.exitCode = result.ok ? 0 : 1;
  }
}
