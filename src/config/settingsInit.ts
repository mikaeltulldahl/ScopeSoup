// `pnpm settings:init <settings.json> --as <name> [--config <scopesoup.config.json>]`: the first person on a project writes
// its shared settings to the meta ref (`refs/scopesoup/meta`), as one commit named after them, and pushes it. Used by the
// scopesoup-onboard skill. The meta ref is fetched first; when the project has shared settings already, nothing is written: the
// person is joining a project Scope Soup already runs, and writes only their own machine's private file.
// Exit code 0 when written, 1 when refused, 2 for a wrong command line.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { findConfig } from "./locate.ts";
import { recordInManifest } from "./manifest.ts";
import { type MetaSettings, metaSettings } from "./metaSettings.ts";
import { repositoryOf, SaveRefused, SHARED_WHERE, validateFiles } from "./shared.ts";

const USAGE = "Usage: pnpm settings:init <settings.json> --as <your name> [--config <this machine's scopesoup.config.json>]";

type Obj = Record<string, unknown>;

/** Writes the shared settings, or says why not. `settings` is injectable for tests. */
export async function initSettings(sharedFile: string, privateFile: string, by: string, settings: MetaSettings = metaSettings()): Promise<{ ok: boolean; lines: string[] }> {
  let sharedRaw: unknown;
  let privateRaw: unknown;
  try {
    sharedRaw = JSON.parse(readFileSync(sharedFile, "utf8"));
    privateRaw = JSON.parse(readFileSync(privateFile, "utf8"));
  } catch (error) {
    return { ok: false, lines: [error instanceof Error ? error.message : String(error)] };
  }
  const where = repositoryOf(privateRaw, dirname(privateFile));
  if (!where.machine) return { ok: false, lines: [`${privateFile} has no machineName: the commit names this machine.`] };
  const checked = validateFiles(privateRaw, sharedRaw, dirname(privateFile));
  if (!checked.ok) return { ok: false, lines: [`${sharedFile} with ${privateFile} is not valid. ${checked.errors.length} problem(s):`, ...checked.errors.map((error) => `- ${error}`)] };
  const fetched = await settings.fetch(where.repoPath, where.remote, where.machine, where.multiplayer);
  if (fetched.problem) return { ok: false, lines: [`The meta ref could not be fetched from ${where.remote}, so nothing was written (the project may have shared settings there already): ${fetched.problem}`] };
  if (settings.read(where.repoPath).ok) {
    return { ok: false, lines: [`This project has ${SHARED_WHERE} already: you are joining a project Scope Soup runs. Nothing was written. Write only this machine's private file (${privateFile}); change a shared setting on the Settings page.`] };
  }
  const done = await settings.save({
    repoPath: where.repoPath,
    remote: where.remote,
    multiplayer: where.multiplayer,
    machine: where.machine,
    by,
    update: (current) => {
      // Another machine may have written them since the fetch: then this is not the first person after all.
      if (Object.keys(current).length > 0) throw new SaveRefused(`This project has ${SHARED_WHERE} already: you are joining. Nothing was written.`);
      return sharedRaw as Obj;
    },
  });
  if (!done.ok) return { ok: false, lines: [`Not written: ${done.error}`] };
  // Offboarding's record of what Scope Soup made outside the config folder.
  recordInManifest(privateFile, [
    { kind: "ref", ref: "refs/scopesoup/meta", what: "the shared settings and the Items" },
    { kind: "folder", path: where.repoPath, what: "Scope Soup's clone of the project" },
  ], "onboarding");
  return {
    ok: true,
    lines: [
      `Wrote ${SHARED_WHERE} in ${where.repoPath}${done.commit ? ` as ${done.commit.slice(0, 7)}` : ""}, by ${by}.`,
      done.sharing.state === "shared" ? `Pushed to ${where.remote}: everyone who joins reads them from there.` : done.sharing.state === "local" ? (where.metaRemote === null ? "Singleplayer: they stay in this clone, and nothing is pushed under refs/scopesoup/." : "The repository has no remote: they stay on this machine.") : `Not pushed yet: ${done.sharing.problem ?? "it goes with the next push"} Scope Soup pushes it when it starts.`,
    ],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void (async () => {
    let parsed;
    try {
      parsed = parseArgs({ args: process.argv.slice(2), options: { as: { type: "string" }, config: { type: "string" } }, allowPositionals: true, strict: true });
    } catch (error) {
      console.error(`${error instanceof Error ? error.message : String(error)}. ${USAGE}`);
      process.exitCode = 2;
      return;
    }
    const file = parsed.positionals[0];
    const by = parsed.values.as?.trim();
    if (!file || !by) {
      console.error(USAGE);
      process.exitCode = 2;
      return;
    }
    const base = process.env.INIT_CWD ?? process.cwd();
    const found = findConfig({ given: parsed.values.config, cwd: base });
    if (!found.ok) {
      console.error(found.error);
      process.exitCode = 1;
      return;
    }
    const settings = metaSettings();
    const result = await initSettings(resolve(base, file), found.file, by, settings);
    await settings.stop();
    for (const line of result.lines) console.log(line);
    process.exitCode = result.ok ? 0 : 1;
  })();
}
