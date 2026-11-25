// `pnpm config:host jira --site <https address> --project <KEY> [--deployment cloud|datacenter] [--email <Cloud account email>]
// [--filter <JQL condition>] [--component <name>]... [--read-only] [--look]`: the Jira host that onboarding writes (the
// scopesoup-onboard skill), built and checked with what Settings' "Connect to Jira" uses (`connectionOf`, the configuration's
// own validation, `lookAtHost`), so the skill repeats none of those checks. It prints the shared `host` and, for Jira Cloud, this
// machine's `jira.email`, as JSON to put into the two files. With `--look` it also reads the host once with the token from the
// environment (`SCOPESOUP_JIRA_TOKEN`: never asked for, printed or written) and says how many open issues would be the Items.
// Exit code 0 when valid (and, with --look, looked at), 1 when the host is not valid, 2 for a wrong command line, 3 when the host
// is valid but could not be looked at (no token set, or Jira refused it): the files may still be written.

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { validateFiles } from "./config/shared.ts";
import { type ConnectDeps, connectionOf, lookAtHost } from "./server/connect.ts";

const USAGE = "Usage: pnpm config:host jira --site <https address> --project <KEY> [--deployment cloud|datacenter] [--email <Cloud account email>] [--filter <JQL condition>] [--component <name>]... [--read-only] [--look]";

export interface HostPart {
  ok: boolean;
  /** 0 valid, 1 not valid, 3 valid but not looked at. */
  code: 0 | 1 | 3;
  lines: string[];
}

export interface JiraAnswers {
  site: string;
  project: string;
  deployment?: string;
  email?: string;
  filter?: string;
  components?: string[];
  readOnly?: boolean;
}

/** Builds and checks the Jira host; with `look`, reads it once through `deps`. */
export async function jiraHostPart(answers: JiraAnswers, deps: ConnectDeps, look: boolean): Promise<HostPart> {
  const given = connectionOf({ kind: "jira", ...answers, write: answers.readOnly !== true });
  if (!given.ok) return { ok: false, code: 1, lines: [given.error] };
  const { connection } = given;
  // The configuration's own validation, on the two files as they will be: this host and this machine's email.
  const checked = validateFiles(
    { version: 1, machineName: "check", repoPath: ".", ...(connection.email ? { jira: { email: connection.email } } : {}) },
    { project: "check", host: connection.host },
    process.cwd(),
  );
  if (!checked.ok) return { ok: false, code: 1, lines: [`The Jira host is not valid. ${checked.errors.length} problem(s):`, ...checked.errors.map((error) => `- ${error}`)] };
  const out = { host: connection.host, ...(connection.email ? { private: { jira: { email: connection.email } } } : {}) };
  const lines = ["The host for the shared settings, and this machine's private part (put each in its file):", JSON.stringify(out, null, 2)];
  if (connection.host.deployment === "cloud" && !connection.email) lines.push("Jira Cloud needs the email of the account the API token belongs to (--email): it is kept in this machine's private file.");
  if (!look) return { ok: true, code: 0, lines };
  const seen = await lookAtHost("jira", connection, deps);
  if (seen.problems.length > 0) return { ok: true, code: 3, lines: [...lines, "Not looked at:", ...seen.problems.map((problem) => `- ${problem}`)] };
  return { ok: true, code: 0, lines: [...lines, ...seen.lines] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void (async () => {
    let parsed;
    try {
      parsed = parseArgs({
        args: process.argv.slice(2),
        options: { site: { type: "string" }, project: { type: "string" }, deployment: { type: "string" }, email: { type: "string" }, filter: { type: "string" }, component: { type: "string", multiple: true }, "read-only": { type: "boolean" }, look: { type: "boolean" } },
        allowPositionals: true,
        strict: true,
      });
    } catch (error) {
      console.error(`${error instanceof Error ? error.message : String(error)}. ${USAGE}`);
      process.exitCode = 2;
      return;
    }
    const v = parsed.values;
    if (parsed.positionals[0] !== "jira" || !v.site || !v.project) {
      console.error(USAGE);
      process.exitCode = 2;
      return;
    }
    const result = await jiraHostPart(
      { site: v.site, project: v.project, ...(v.deployment ? { deployment: v.deployment } : {}), ...(v.email ? { email: v.email } : {}), ...(v.filter ? { filter: v.filter } : {}), ...(v.component ? { components: v.component } : {}), ...(v["read-only"] ? { readOnly: true } : {}) },
      { env: process.env },
      v.look === true,
    );
    for (const line of result.lines) console.log(line);
    process.exitCode = result.code;
  })();
}
