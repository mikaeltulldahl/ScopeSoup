// `pnpm meta:accept`: takes the fetched meta history that sharing refused (docs/RUNNING.md, "When
// the meta ref refuses what it fetched"). It reads the same settings as Scope Soup itself:
//   SCOPESOUP_META_REPO, SCOPESOUP_META_REMOTE, SCOPESOUP_META_AUTHOR_NAME,
//   SCOPESOUP_META_AUTHOR_EMAIL, and takes the machine's name as `--machine <name>`: the
//   configuration's `machineName`, so that this machine's own commits are known by their trailer.
// Stop Scope Soup first: two writers on one repository would each move the ref.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createMetaBranchHost, DEFAULT_META_REF } from "./adapter.ts";
import type { AcceptReport } from "./writer.ts";

/** What the command prints, one line per fact. */
export function describeAccept(report: AcceptReport, ref: string): string[] {
  const lines = [
    report.backup ? `Saved this machine's ${ref} as ${report.backup} (to go back: git update-ref ${ref} ${report.backup}).` : `There was no ${ref} here before.`,
    `Took the fetched history ${report.accepted.slice(0, 12)} as the remote's.`,
    `Put ${report.replayed} of this machine's unshared ${report.replayed === 1 ? "commit" : "commits"} on top of it.`,
  ];
  if (report.notReplayed.length > 0) lines.push(`Not put on top, because this machine did not make them (they are in the backup): ${report.notReplayed.map((id) => id.slice(0, 12)).join(", ")}.`);
  for (const move of report.renamed) lines.push(`This machine's new item ${move.from} is now ${move.to}: the accepted history has another item ${move.from}.`);
  if (report.conflicts.length > 0) lines.push(`In conflict now (both versions of item.md kept): ${report.conflicts.join(", ")}.`);
  lines.push(report.sharing.state === "shared" ? "Pushed: the remote has it all." : `Not pushed yet (${report.sharing.state}): ${report.sharing.problem ?? "it goes with the next round"}.`);
  lines.push("Lines the accepted history removed stay removed.");
  return lines;
}

const USAGE = "Usage: pnpm meta:accept --machine <name>, where <name> is the machineName in Scope Soup's configuration file: this machine's own commits are the ones that carry it.";

export async function main(env: NodeJS.ProcessEnv = process.env, print: (line: string) => void = console.log, argv: string[] = process.argv.slice(2)): Promise<number> {
  let machine: string | undefined;
  try {
    machine = parseArgs({ args: argv, options: { machine: { type: "string" } }, strict: true, allowPositionals: false }).values.machine?.trim();
  } catch (error) {
    print(`${error instanceof Error ? error.message : String(error)}. ${USAGE}`);
    return 2;
  }
  if (!machine) {
    print(USAGE);
    return 2;
  }
  const repo = env.SCOPESOUP_META_REPO;
  const name = env.SCOPESOUP_META_AUTHOR_NAME;
  const email = env.SCOPESOUP_META_AUTHOR_EMAIL;
  if (!repo || !name || !email) {
    print("Set SCOPESOUP_META_REPO, SCOPESOUP_META_AUTHOR_NAME and SCOPESOUP_META_AUTHOR_EMAIL as for Scope Soup itself (and SCOPESOUP_META_REMOTE if you set it there).");
    return 2;
  }
  const ref = DEFAULT_META_REF;
  const remote = env.SCOPESOUP_META_REMOTE ?? "origin";
  const host = createMetaBranchHost({ repoDir: resolve(repo), allowWrites: true, person: { name, email }, machine, remote: remote === "none" ? null : remote });
  try {
    const report = await (host.writer as NonNullable<typeof host.writer>).accept();
    for (const line of describeAccept(report, ref)) print(line);
    return 0;
  } catch (error) {
    print(`Nothing accepted: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await host.stop();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}
