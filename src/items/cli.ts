// `pnpm item <verb>`: the item commands for a person at a terminal or an interactive Claude Code
// session (docs/RUNNING.md, "Item commands"). On the meta branch they go through the running Scope Soup
// server's local API when it is up, and straight to the meta ref with the existing writer when not.
// On GitHub they go to the API with the token from SCOPESOUP_GITHUB_TOKEN, on Jira with the one from SCOPESOUP_JIRA_TOKEN.
// Tokens only from the environment; nothing here prints one.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createConfigLoader } from "../config/loader.ts";
import { findConfig } from "../config/locate.ts";
import type { ProjectConfig } from "../config/types.ts";
import type { FetchLike } from "../hosts/github/client.ts";
import { createClient } from "../hosts/github/client.ts";
import type { MetaBranchHost } from "../hosts/metaBranch/index.ts";
import { DEFAULT_META_REF } from "../hosts/metaBranch/index.ts";
import { createHosts, hostSettings } from "../hostSetup.ts";
import type { HostSettings } from "../hostSetup.ts";
import { FROM_CLAUDE_CODE } from "../model/people.ts";
import type { Git } from "../orchestrator/process.ts";
import { realGit } from "../orchestrator/process.ts";
import type { JiraHost } from "../hosts/jira/index.ts";
import type { Ref } from "../model/types.ts";
import type { Host } from "../ports/host.ts";
import { gitRemoteUrl } from "../config/mergeQueue.ts";
import { DEFAULT_PORT } from "../server/server.ts";
import { projectInfo, sameProject } from "../server/project.ts";
import type { ProjectIdentity } from "../server/project.ts";
import type { ClosedChoice } from "./githubImport.ts";
import { DEFAULT_COMMENTS, importIssues, isRepoName, reportText } from "./githubImport.ts";
import type { OnGitHub } from "./githubMove.ts";
import { MOVED_LABEL, moveIssues, moveText } from "./githubMove.ts";
import type { Backend, Details, ListFilter, NewItem, Row } from "./service.ts";
import { remoteBranches } from "./remoteBranch.ts";
import { createItem, detailsText, handBackItem, itemDetails, listItems, Refused, releaseItem, rowText, claimItem } from "./service.ts";

type Env = Record<string, string | undefined>;

export const USAGE = `Usage: pnpm item <verb> [options]

  new --title TEXT [--body-file FILE | --body TEXT] [--priority blocker|critical|major|minor] [--label NAME]... [--claim]
      File an item. With --claim you hold it from the start, in one write, so Scope Soup cannot pick it up first.
  claim ID [--as NAME]
      You hold the item. Scope Soup does not start it; it refuses when an agent holds it.
  handback ID [--note TEXT]
      The work is pushed to the item's branch, scopesoup/ID, on the remote. Scope Soup fetches it and records its newest commit,
      then reviews it, checks and merges it as for an agent's change. A branch that is not on the remote, or has no commits
      beyond the main branch, is refused.
  release ID [--note TEXT]
      Give the item back without a branch. An agent may pick it up.
  list [--mine | --free] [--all] [--search TEXT] [--json]
      What there is and who holds what. --search keeps the items whose id, title, labels or text hold every word.
  show ID [--json]
      One item in full: its facts, description and verification.
  import github --repo OWNER/NAME [--closed N|all] [--comments N|none] [--on-github leave|label|close [--yes]] [--dry-run]
                [--github-login LOGIN]
      Import the repository's GitHub Issues once into Items on the meta branch: every open issue (and the N most recently
      updated closed ones, or all, with --closed), in one meta commit by you, each with its last ${DEFAULT_COMMENTS} comments (--comments)
      marked as imported. An issue imported before is not imported again. --dry-run prints what would be done and writes
      nothing. The token is SCOPESOUP_GITHUB_TOKEN.
      GitHub is only read unless --on-github says otherwise: leave (the default) changes nothing there; label gives each open
      imported issue the label ${MOVED_LABEL} and a comment naming its Item; close does that and closes it as not planned.
      label and close are asked first in a terminal, or need --yes; pull requests are never touched. Run again to finish a
      step that stopped halfway: nothing is done twice.

Common: --config FILE (else SCOPESOUP_CONFIG, else ./scopesoup.config.json, else the config this machine knows for the git
repository you are in), --as NAME, --server URL, --no-server, --from SOURCE.
The person is --as, else SCOPESOUP_PERSON, else the meta author name of the configuration, else git's user.name.
On the meta branch the running server is used when it answers (SCOPESOUP_URL, default http://127.0.0.1:${DEFAULT_PORT}).`;

export interface CliDeps {
  env: Env;
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
  git?: Git;
  /** Replaces `fetch` for the server calls, for tests. */
  fetch?: typeof fetch;
  /** Replaces host creation, for tests: a host from the settings, without the real git or network. */
  makeHosts?: (settings: HostSettings, env: Env) => Host[];
  now?: () => Date;
  /** Replaces `fetch` and the API's address for `item import github`, for tests against a fake GitHub. */
  githubFetch?: FetchLike;
  githubApi?: string;
  /** Asks the person a question in the terminal and gives the answer; absent when stdin is not a terminal. */
  ask?: (question: string) => Promise<string>;
  /** Scope Soup's home, whose list of configs is matched against the repository in `cwd`; default from SCOPESOUP_HOME or the install. */
  home?: string | null;
  /** Replaces `git remote get-url`, for tests. */
  remoteUrlOf?: (repoPath: string, remote: string) => string;
  /** Replaces the wait of a claim on Jira, for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** What a verb does, wherever it runs. */
interface Doer {
  create(input: NewItem): Promise<{ message: string }>;
  claim(id: string, from?: string): Promise<{ message: string }>;
  handback(id: string, input: { note?: string }): Promise<{ message: string }>;
  release(id: string, note?: string): Promise<{ message: string }>;
  list(filter: ListFilter): Promise<Row[]>;
  show(id: string): Promise<Details>;
  /** Frees what the doer holds (a host's git processes). */
  close(): Promise<void>;
}

export interface Setup {
  config: ProjectConfig | null;
  settings: HostSettings;
  /** Where the project's git repository is: a hand-back fetches the item's branch from its remote into it. */
  repo: string;
  remote: string;
  mainBranch: string;
  /** Which project the found config is, as a server says it in `/api/health`; null without a config (then any server is used). */
  identity: ProjectIdentity | null;
}

export function loadSetup(deps: CliDeps, configPath: string | undefined): Setup {
  const found = findConfig({ given: configPath, env: deps.env, cwd: deps.cwd, ...(deps.home !== undefined ? { home: deps.home } : {}) });
  const file = found.file;
  // Without a config the host may come from the environment (SCOPESOUP_META_REPO, SCOPESOUP_GITHUB_REPO).
  if (!found.ok && !deps.env.SCOPESOUP_META_REPO && !deps.env.SCOPESOUP_GITHUB_REPO) throw new Refused(found.error);
  let config: ProjectConfig | null = null;
  if (found.ok && existsSync(file)) {
    // A session may run these: an older file is read migrated, and only the server writes it.
    const state = createConfigLoader(file, undefined, { write: false }).load();
    if (!state.config) throw new Refused(state.error ?? `${file} could not be read.`);
    config = state.config;
  } else if (found.ok) throw new Refused(`There is no configuration file ${file}.`);
  const settings = hostSettings(config, deps.env, (path) => resolve(deps.cwd, path));
  if (!settings.meta && !settings.github && !settings.jira) throw new Refused(`No item host is configured: ${file} has no \`host\` and neither SCOPESOUP_META_REPO nor SCOPESOUP_GITHUB_REPO is set.`);
  const identity = config ? projectInfo(config, file, deps.remoteUrlOf ?? gitRemoteUrl) : null;
  return {
    config, settings, repo: config?.repoPath ?? deps.cwd, remote: config?.remote ?? "origin", mainBranch: config?.mainBranch ?? "main",
    identity: identity ? { name: identity.name, repository: identity.repository } : null,
  };
}

/** The person's name: the option, the environment, the configuration, git; never a guess. Reading (`show`, `list` without `--mine`) needs none. */
async function personName(deps: CliDeps, setup: Setup, asked: string | undefined, reading = false): Promise<string> {
  const given = asked?.trim() || deps.env.SCOPESOUP_PERSON?.trim() || setup.settings.meta?.authorName?.trim();
  if (given) return given;
  const read = await (deps.git ?? realGit)(["config", "user.name"], setup.repo);
  const name = read.code === 0 ? read.stdout.trim() : "";
  if (name) return name;
  if (reading) return "someone";
  throw new Refused("Who are you? Give --as NAME, or set SCOPESOUP_PERSON, the meta author name in the configuration, or git's user.name.");
}

// --- the server, when it is up ---

/** Whether a server answers at `base`, and which project it says it serves (absent when it does not say). */
async function serverAt(deps: CliDeps, base: string): Promise<{ project?: ProjectIdentity | null } | null> {
  try {
    const response = await (deps.fetch ?? fetch)(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as { project?: ProjectIdentity | null } | null;
    return { project: body?.project ?? null };
  } catch {
    return null;
  }
}

function serverDoer(deps: CliDeps, base: string, who: string): Doer {
  const call = async (method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> => {
    const response = await (deps.fetch ?? fetch)(`${base}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json: { error?: { code?: string; message?: string }; message?: string } & Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      // Not JSON: the status says enough.
    }
    if (!response.ok) {
      const message = json.error?.message ?? `the server answered ${response.status}`;
      if (json.error?.code === "REFUSED" || json.error?.code === "ITEM_NOT_FOUND") throw new Refused(message);
      throw new Error(message);
    }
    return json;
  };
  const said = async (path: string, body: Record<string, unknown>): Promise<{ message: string }> => {
    const json = (await call("POST", path, { ...body, as: who })) as { message?: string; ref?: string; problem?: string };
    return { message: json.message ?? `Done (${json.ref ?? "ok"}).${json.problem ? ` Note: ${json.problem}` : ""}` };
  };
  return {
    create: (input) => said("/api/items", { title: input.title, ...(input.claim ? { claim: true } : {}), ...(input.from ? { from: input.from } : {}), ...(input.body ? { body: input.body } : {}), ...(input.priority ? { priority: input.priority } : {}), ...(input.labels?.length ? { labels: input.labels } : {}) }),
    claim: (id, from) => said("/api/item/claim", { id, ...(from ? { from } : {}) }),
    handback: (id, input) => said("/api/item/handback", { id, ...input }),
    release: (id, note) => said("/api/item/release", { id, ...(note ? { note } : {}) }),
    async list(filter) {
      const query = new URLSearchParams({ as: who, ...(filter.mine ? { mine: "1" } : {}), ...(filter.free ? { free: "1" } : {}), ...(filter.all ? { all: "1" } : {}), ...(filter.search ? { search: filter.search } : {}) });
      return ((await call("GET", `/api/item/rows?${query}`)) as { rows: Row[] }).rows;
    },
    async show(id) {
      return ((await call("GET", `/api/item/show?${new URLSearchParams({ as: who, id })}`)) as { item: Details }).item;
    },
    async close() {},
  };
}

// --- directly on the host ---

function hostDoer(backend: Backend, host: Host): Doer {
  return {
    create: (input) => createItem(backend, input),
    claim: (id, from) => claimItem(backend, id, from ? { from } : {}),
    handback: (id, input) => handBackItem(backend, id, input),
    release: (id, note) => releaseItem(backend, id, note),
    list: (filter) => listItems(backend, filter),
    show: (id) => itemDetails(backend, id),
    close: async () => void (await host.stop?.()),
  };
}

interface Opened {
  doer: Doer;
  /** `server`, `meta ref` or `GitHub`: said once, so the person knows where the write went. */
  via: string;
  kind: "metaBranch" | "github" | "jira";
}

/** How long a person's claim on Jira waits for an agent's claim written meanwhile: the agents' own settle time. */
const JIRA_CLAIM_SETTLE_MS = 2000;

/** Jira: after the settle time, the agent whose live claim stands on the issue, if any. */
function jiraAfterClaim(host: JiraHost, sleep: (ms: number) => Promise<void>, now: () => Date) {
  return async (ref: Ref): Promise<string | undefined> => {
    await sleep(JIRA_CLAIM_SETTLE_MS);
    const live = (await host.read(ref)).claims.filter((each) => !each.released && Date.parse(each.until) > now().getTime());
    return live[0] ? `scopesoup on ${live[0].machine}` : undefined;
  };
}

async function open(deps: CliDeps, setup: Setup, values: { as?: string; server?: string; "no-server"?: boolean }, reading = false): Promise<Opened> {
  const now = deps.now ?? (() => new Date());
  const meta = setup.settings.meta;
  if (meta) {
    const who = await personName(deps, setup, values.as, reading);
    if (!values["no-server"]) {
      const base = (values.server ?? deps.env.SCOPESOUP_URL ?? `http://127.0.0.1:${deps.env.SCOPESOUP_PORT ?? DEFAULT_PORT}`).replace(/\/+$/, "");
      const server = await serverAt(deps, base);
      if (server) {
        if (!setup.identity || sameProject(setup.identity, server.project ?? null)) return { doer: serverDoer(deps, base, who), via: `the Scope Soup server at ${base}`, kind: "metaBranch" };
        const theirs = server.project ? `${server.project.name} (${server.project.repository ?? "no repository"})` : "no project";
        deps.err(`The Scope Soup server at ${base} serves ${theirs}, not ${setup.identity.name} (${setup.identity.repository ?? "no repository"}): not used; going to the meta ref.`);
      }
    }
    const host = (deps.makeHosts ?? ((settings, env) => createHosts(settings, env, () => undefined)))({ from: setup.settings.from, meta, machine: setup.settings.machine }, deps.env)[0];
    if (!host?.work) throw new Refused("The meta host cannot be read.");
    const backend: Backend = { kind: "metaBranch", host: host.info.id, ...(host.info.machine ? { machine: host.info.machine } : {}), who, work: host.work, write: host.write ?? {}, now, mainBranch: setup.mainBranch, branches: branchesOf(deps, setup) };
    return { doer: hostDoer(backend, host), via: "the meta ref (no server for this project)", kind: "metaBranch" };
  }
  const jira = setup.settings.jira;
  if (jira) {
    // `personCommands`: an agent's claim is seen whoever wrote it, since the person's token need not be the server's.
    const host = (deps.makeHosts ?? ((settings, env) => createHosts(settings, env, () => undefined)))({ from: setup.settings.from, jira, machine: setup.settings.machine, personCommands: true }, deps.env)[0] as JiraHost | undefined;
    if (!host?.work || !("read" in host)) throw new Refused("The Jira host cannot be read.");
    // On Jira, as on GitHub, the person is the token's account: the assignee is whoever the token acts as.
    const me = await host.info.whoami();
    if (values.as && values.as !== me.id && values.as !== me.name) throw new Refused(`On Jira the item is held by the token's account, ${me.name}; --as ${values.as} cannot hold it.`);
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
    const backend: Backend = {
      kind: "jira", host: host.info.id, who: me.id, name: me.name, work: host.work, write: host.write ?? {}, now, mainBranch: setup.mainBranch, branches: branchesOf(deps, setup),
      afterClaim: jiraAfterClaim(host, sleep, now),
    };
    return { doer: hostDoer(backend, host), via: `Jira ${jira.project} as ${me.name}`, kind: "jira" };
  }
  const github = setup.settings.github;
  if (!github) throw new Refused("No item host is configured.");
  const host = (deps.makeHosts ?? ((settings, env) => createHosts(settings, env, () => undefined)))({ from: setup.settings.from, github, machine: setup.settings.machine }, deps.env)[0];
  if (!host?.work) throw new Refused("The GitHub host cannot be read.");
  // On GitHub the person is the token's user: the assignee is whoever the token acts as.
  const login = (await host.info.whoami()).id;
  if (values.as && values.as !== login) throw new Refused(`On GitHub the item is held by the token's user, ${login}; --as ${values.as} cannot hold it.`);
  const backend: Backend = { kind: "github", host: host.info.id, who: login, work: host.work, write: host.write ?? {}, now, mainBranch: setup.mainBranch, branches: branchesOf(deps, setup) };
  return { doer: hostDoer(backend, host), via: `GitHub ${github.repo} as ${login}`, kind: "github" };
}

// --- the branch of a hand-back ---

/** The project's remote, as `repoPath`, `remote` and `mainBranch` name it: a hand-back reads the item's branch there. */
const branchesOf = (deps: CliDeps, setup: Setup) => remoteBranches(deps.git ?? realGit, () => ({ repo: setup.repo, remote: setup.remote, mainBranch: setup.mainBranch }));

const OPTIONS = {
  title: { type: "string" },
  body: { type: "string" },
  "body-file": { type: "string" },
  priority: { type: "string" },
  label: { type: "string", multiple: true },
  as: { type: "string" },
  note: { type: "string" },
  from: { type: "string" },
  config: { type: "string" },
  server: { type: "string" },
  "no-server": { type: "boolean" },
  claim: { type: "boolean" },
  mine: { type: "boolean" },
  free: { type: "boolean" },
  all: { type: "boolean" },
  json: { type: "boolean" },
  search: { type: "string" },
  repo: { type: "string" },
  closed: { type: "string" },
  "dry-run": { type: "boolean" },
  "github-login": { type: "string" },
  comments: { type: "string" },
  "on-github": { type: "string" },
  yes: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

/** Runs one command line. Returns the exit code: 0 done, 1 refused or failed, 2 misuse. */
export async function runItemCli(argv: string[], deps: CliDeps): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    deps.err(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [verb, id] = positionals;
  if (values.help || !verb) {
    (values.help ? deps.out : deps.err)(USAGE);
    return values.help ? 0 : 2;
  }
  if (verb === "import") return runImport(positionals[1], values, deps);
  if (!["new", "claim", "handback", "release", "list", "show"].includes(verb)) {
    deps.err(`Unknown verb "${verb}".\n\n${USAGE}`);
    return 2;
  }
  if (verb !== "new" && verb !== "list" && !id) {
    deps.err(`item ${verb} needs the item's id.\n\n${USAGE}`);
    return 2;
  }
  let opened: Opened | undefined;
  try {
    const setup = loadSetup(deps, values.config);
    const reading = verb === "show" || (verb === "list" && !values.mine);
    opened = await open(deps, setup, { ...(values.as ? { as: values.as } : {}), ...(values.server ? { server: values.server } : {}), ...(values["no-server"] ? { "no-server": true } : {}) }, reading);
    const { doer } = opened;
    // An interactive Claude Code session says so in the claim (its shells set CLAUDECODE).
    const from = values.from ?? (deps.env.CLAUDECODE ? FROM_CLAUDE_CODE : undefined);
    switch (verb) {
      case "new": {
        if (values.body !== undefined && values["body-file"] !== undefined) throw new Refused("Give --body or --body-file, not both.");
        let body = values.body;
        if (values["body-file"] !== undefined) {
          try {
            body = readFileSync(resolve(deps.cwd, values["body-file"]), "utf8");
          } catch (error) {
            throw new Refused(`Cannot read ${values["body-file"]}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        deps.out((await doer.create({ title: values.title ?? "", ...(body ? { body } : {}), ...(values.priority ? { priority: values.priority } : {}), ...(values.label?.length ? { labels: values.label } : {}), ...(values.claim ? { claim: true, ...(from ? { from } : {}) } : {}) })).message);
        break;
      }
      case "claim":
        deps.out((await doer.claim(id as string, from)).message);
        break;
      case "handback":
        deps.out((await doer.handback(id as string, values.note ? { note: values.note } : {})).message);
        break;
      case "release":
        deps.out((await doer.release(id as string, values.note)).message);
        break;
      case "list": {
        if (values.mine && values.free) throw new Refused("--mine and --free together list nothing.");
        const rows = await doer.list({ ...(values.mine ? { mine: true } : {}), ...(values.free ? { free: true } : {}), ...(values.all ? { all: true } : {}), ...(values.search?.trim() ? { search: values.search.trim() } : {}) });
        if (values.json) deps.out(JSON.stringify(rows, null, 2));
        else if (rows.length === 0) deps.out("No items.");
        else for (const row of rows) deps.out(rowText(row));
        break;
      }
      case "show": {
        const details = await doer.show(id as string);
        deps.out(values.json ? JSON.stringify(details, null, 2) : detailsText(details));
        break;
      }
    }
    return 0;
  } catch (error) {
    deps.err(error instanceof Refused ? `Not done: ${error.message}` : `Failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await opened?.doer.close();
  }
}

// --- import ---

/** `item import github`: GitHub Issues into Items on the meta branch, once. Straight on the meta ref, never through the server. */
async function runImport(
  source: string | undefined,
  values: { repo?: string; closed?: string; comments?: string; "on-github"?: string; yes?: boolean; "dry-run"?: boolean; "github-login"?: string; config?: string; as?: string },
  deps: CliDeps,
): Promise<number> {
  if (source !== "github") {
    deps.err(`item import needs the source; only "github" is supported: item import github --repo OWNER/NAME\n\n${USAGE}`);
    return 2;
  }
  const repo = values.repo?.trim() ?? "";
  if (!isRepoName(repo)) {
    deps.err(`item import github needs --repo OWNER/NAME${repo ? ` (got "${repo}")` : ""}.\n\n${USAGE}`);
    return 2;
  }
  let closed: ClosedChoice = "none";
  if (values.closed !== undefined) {
    const text = values.closed.trim().toLowerCase();
    if (text === "all") closed = "all";
    else if (/^[1-9][0-9]{0,6}$/.test(text)) closed = Number(text);
    else {
      deps.err(`--closed takes a number of issues (1 or more) or "all" (got "${values.closed}").\n\n${USAGE}`);
      return 2;
    }
  }
  // How many comments come along.
  let comments = DEFAULT_COMMENTS;
  if (values.comments !== undefined) {
    const text = values.comments.trim().toLowerCase();
    if (text === "none") comments = 0;
    else if (/^[0-9]{1,3}$/.test(text)) comments = Number(text);
    else {
      deps.err(`--comments takes a number of comments (0 to 999) or "none" (got "${values.comments}").\n\n${USAGE}`);
      return 2;
    }
  }
  const dryRun = values["dry-run"] === true;
  // The step on GitHub. Never without a yes: --yes, or the answer to the question in a terminal; otherwise refused before anything.
  const onGitHub = (values["on-github"]?.trim().toLowerCase() ?? "leave") as OnGitHub;
  if (!["leave", "label", "close"].includes(onGitHub)) {
    deps.err(`--on-github takes leave, label or close (got "${values["on-github"]}").\n\n${USAGE}`);
    return 2;
  }
  if (values.yes && onGitHub === "leave") {
    deps.err(`--yes says yes to a step on GitHub, and --on-github is leave: there is nothing to say yes to.\n\n${USAGE}`);
    return 2;
  }
  if (onGitHub !== "leave" && !dryRun && !values.yes && !deps.ask) {
    deps.err(`--on-github ${onGitHub} writes to GitHub and needs a yes: run it in a terminal to be asked, or add --yes. Nothing was done.`);
    return 2;
  }
  let host: MetaBranchHost | undefined;
  try {
    const setup = loadSetup(deps, values.config);
    const meta = setup.settings.meta;
    if (!meta) throw new Refused("The import writes Items to a meta branch, and this project's items are on GitHub or Jira: there is nothing to import into.");
    const token = deps.env.SCOPESOUP_GITHUB_TOKEN;
    if (!token) throw new Refused("Set SCOPESOUP_GITHUB_TOKEN to a token that can read the repository's issues. The token is only read from the environment.");
    host = (deps.makeHosts ?? ((settings, env) => createHosts(settings, env, () => undefined)))({ from: setup.settings.from, meta, machine: setup.settings.machine }, deps.env)[0] as MetaBranchHost | undefined;
    const writer = host && "writer" in host ? host.writer : null;
    if (!writer) throw new Refused("Writes to the meta branch are off here (host.write in the configuration, or SCOPESOUP_META_WRITE=1), so nothing can be imported, not even as a dry run.");
    const person = await personName(deps, setup, values.as);
    const client = createClient({ token, repo, ...(deps.githubFetch ? { fetchImpl: deps.githubFetch } : {}), ...(deps.githubApi ? { apiUrl: deps.githubApi } : {}) });
    const report = await importIssues({
      client, writer, repo, person, closed, comments, now: (deps.now ?? (() => new Date()))(),
      ...(values["github-login"]?.trim() ? { login: values["github-login"].trim() } : {}),
      ...(dryRun ? { dryRun: true } : {}),
    });
    for (const line of reportText(report, repo, dryRun)) deps.out(line);
    if (onGitHub === "leave") return 0;

    const targets = report.rows.map((row) => ({ number: row.number, id: row.id, open: row.open, labels: row.githubLabels }));
    const where = `the meta ref \`${DEFAULT_META_REF}\` of this project`;
    const step = { client, targets, choice: onGitHub, where, ...(report.login ? { login: report.login } : {}) };
    if (dryRun) {
      for (const line of moveText(await moveIssues({ ...step, dryRun: true }), onGitHub, repo, true)) deps.out(line);
      return 0;
    }
    // The Items must be where others can see them before GitHub says the issues moved.
    if (report.shared === "pending") throw new Refused(`the Items are not on the remote yet${report.problem ? ` (${report.problem})` : ""}, so GitHub was left as it is. Run the same command again once they are shared.`);
    const open = targets.filter((target) => target.open);
    if (open.length === 0) {
      deps.out(`On GitHub: no open imported issue in ${repo} to change.`);
      return 0;
    }
    if (!values.yes) {
      const what = onGitHub === "close" ? `label them ${MOVED_LABEL}, comment the Item on each and close them as not planned` : `label them ${MOVED_LABEL} and comment the Item on each`;
      const answer = await (deps.ask as (question: string) => Promise<string>)(`Change ${open.length} open issue(s) on GitHub ${repo}: ${what}? Pull requests are not touched. Type yes to go on: `);
      if (!/^\s*y(es)?\s*$/i.test(answer)) {
        deps.out("GitHub was left as it is.");
        return 0;
      }
    }
    const moved = await moveIssues(step);
    for (const line of moveText(moved, onGitHub, repo, false)) deps.out(line);
    return moved.failed ? 1 : 0;
  } catch (error) {
    deps.err(error instanceof Refused ? `Not done: ${error.message}` : `Failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await host?.stop?.();
  }
}
