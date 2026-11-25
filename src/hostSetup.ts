// Which hosts Scope Soup syncs, from the project's configuration file or, when the file has no
// `host`, from the environment as before. Tokens always come from the environment.
//
// The rule: a `host` in the file wins, and the SCOPESOUP_GITHUB_REPO, SCOPESOUP_WRITE,
// SCOPESOUP_META_* variables are then not read. The machine's name is only the file's `machineName`.

import type { HostConfig, ProjectConfig } from "./config/types.ts";
import { createGitHubHost } from "./hosts/github/index.ts";
import { createJiraHost } from "./hosts/jira/index.ts";
import { createMetaBranchHost, DEFAULT_META_REF } from "./hosts/metaBranch/index.ts";
import type { Host } from "./ports/host.ts";

type Env = Record<string, string | undefined>;
type GitHubHostConfig = Extract<HostConfig, { kind: "github" }>;
type MetaBranchHostConfig = Extract<HostConfig, { kind: "metaBranch" }>;
type JiraHostConfig = Extract<HostConfig, { kind: "jira" }>;

/** The hosts to sync, as plain settings. The environment can name both; the file names one. */
export interface HostSettings {
  /** "file" when the configuration file's `host` decided, "environment" otherwise. */
  from: "file" | "environment";
  meta?: MetaBranchHostConfig;
  github?: GitHubHostConfig;
  /** A Jira project; only from the configuration file. */
  jira?: JiraHostConfig;
  /**
   * This machine's name in claims and log lines on either host: the file's `machineName`, never the computer's host
   * name. Absent only without a configuration file, and then nothing may be written.
   */
  machine?: string;
  /** The hosts are for a person's item commands (`scopesoup item`), not for the server: Jira then sees agents' claims whoever wrote them. */
  personCommands?: boolean;
}

const ENV_HOST_VARIABLES = ["SCOPESOUP_GITHUB_REPO", "SCOPESOUP_WRITE", "SCOPESOUP_META_REPO", "SCOPESOUP_META_WRITE", "SCOPESOUP_META_AUTHOR_NAME", "SCOPESOUP_META_AUTHOR_EMAIL", "SCOPESOUP_META_PREFIX", "SCOPESOUP_META_REMOTE", "SCOPESOUP_META_FETCH_SECONDS"];

/** The environment variables that are set but not read because the file has a `host`. */
export function ignoredVariables(settings: HostSettings, env: Env): string[] {
  return settings.from === "file" ? ENV_HOST_VARIABLES.filter((name) => env[name] !== undefined) : [];
}

export function hostSettings(config: ProjectConfig | null, env: Env, resolvePath: (path: string) => string): HostSettings {
  const host = config?.host;
  if (host) {
    if (host.kind === "github") return { from: "file", github: host, machine: config.machineName };
    if (host.kind === "jira") return { from: "file", jira: host, machine: config.machineName };
    return { from: "file", meta: host, machine: config.machineName };
  }
  const settings: HostSettings = { from: "environment", ...(config ? { machine: config.machineName } : {}) };
  if (env.SCOPESOUP_META_REPO) {
    const write = env.SCOPESOUP_META_WRITE === "1";
    const remote = env.SCOPESOUP_META_REMOTE ?? "origin";
    settings.meta = {
      kind: "metaBranch",
      repoPath: resolvePath(env.SCOPESOUP_META_REPO),
      write,
      remote: remote === "none" ? null : remote,
      fetchSeconds: Number(env.SCOPESOUP_META_FETCH_SECONDS ?? 60),
      ...(env.SCOPESOUP_META_AUTHOR_NAME ? { authorName: env.SCOPESOUP_META_AUTHOR_NAME } : {}),
      ...(env.SCOPESOUP_META_AUTHOR_EMAIL ? { authorEmail: env.SCOPESOUP_META_AUTHOR_EMAIL } : {}),
      ...(env.SCOPESOUP_META_PREFIX ? { prefix: env.SCOPESOUP_META_PREFIX } : {}),
    };
    if (write && (!settings.meta.authorName || !settings.meta.authorEmail)) {
      throw new Error("SCOPESOUP_META_WRITE=1 with SCOPESOUP_META_REPO needs SCOPESOUP_META_AUTHOR_NAME and SCOPESOUP_META_AUTHOR_EMAIL: meta commits are made as that person.");
    }
  }
  if (env.SCOPESOUP_GITHUB_REPO) {
    settings.github = {
      kind: "github",
      repo: env.SCOPESOUP_GITHUB_REPO,
      write: env.SCOPESOUP_WRITE === "1",
    };
  }
  if (!settings.machine && (settings.meta?.write || settings.github?.write)) {
    throw new Error(`${settings.meta?.write ? "SCOPESOUP_META_WRITE=1" : "SCOPESOUP_WRITE=1"} needs a configuration file with machineName (for example "machineName": "desk"): claims and log lines name this machine. SCOPESOUP_MACHINE is no longer read.`);
  }
  return settings;
}

/** Creates the hosts. The GitHub host reads its token from SCOPESOUP_GITHUB_TOKEN, the Jira host from SCOPESOUP_JIRA_TOKEN. */
export function createHosts(settings: HostSettings, env: Env, log: (line: string) => void = console.log, onLabelCreated?: (repo: string, name: string) => void): Host[] {
  const configured: Host[] = [];
  const meta = settings.meta;
  if (meta) {
    if (meta.write && !meta.prefix) log("Warning: no id prefix is set (meta.prefix in this machine's scopesoup.config.json, or SCOPESOUP_META_PREFIX), so no item can be created on this machine. Give each machine its own prefix (A, B, ...).");
    configured.push(createMetaBranchHost({
      repoDir: meta.repoPath,
      ...(meta.write && meta.authorName && meta.authorEmail
        ? {
          allowWrites: true,
          person: { name: meta.authorName, email: meta.authorEmail },
          ...(settings.machine ? { machine: settings.machine } : {}),
          remote: meta.remote,
          fetchIntervalMs: meta.fetchSeconds * 1000,
          ...(meta.prefix ? { idPrefix: meta.prefix } : {}),
        }
        : {}),
    }));
  }
  const gh = settings.github;
  if (gh) {
    const token = env.SCOPESOUP_GITHUB_TOKEN;
    if (!token) throw new Error(`The GitHub host ${gh.repo} is configured but SCOPESOUP_GITHUB_TOKEN is not set. The token is only read from the environment.`);
    // Claim comments name the machine, as the meta branch's lines do.
    configured.push(createGitHubHost({ token, repo: gh.repo, allowWrites: gh.write, conventions: true, ...(settings.machine ? { machine: settings.machine } : {}), ...(onLabelCreated ? { onLabelCreated: (name: string) => onLabelCreated(gh.repo, name) } : {}) }));
  }
  const jira = settings.jira;
  if (jira) {
    const token = env.SCOPESOUP_JIRA_TOKEN;
    if (!token) throw new Error(`The Jira host ${jira.site} (project ${jira.project}) is configured but SCOPESOUP_JIRA_TOKEN is not set. The token is only read from the environment: ${jira.deployment === "cloud" ? "a Jira Cloud API token" : "a personal access token"}.`);
    // Claims name the machine, as on GitHub. The project's changes stay on its git remote: Jira has no pull requests.
    configured.push(createJiraHost({
      site: jira.site, project: jira.project, deployment: jira.deployment, token, conventions: true, allowWrites: jira.write,
      ...(settings.machine ? { machine: settings.machine } : {}),
      ...(settings.personCommands ? { claimsOfAnyone: true } : {}),
      ...(jira.issueType ? { issueType: jira.issueType } : {}),
      ...(jira.childIssueType ? { childIssueType: jira.childIssueType } : {}),
      ...(jira.transitions ? { transitions: jira.transitions } : {}),
      ...(jira.resolutions ? { resolutions: jira.resolutions } : {}),
      ...(jira.relatesLink ? { relatesLink: jira.relatesLink } : {}),
      ...(jira.duplicateLink ? { duplicateLink: jira.duplicateLink } : {}),
      ...(jira.commentLimit ? { commentLimit: jira.commentLimit } : {}),
      ...(jira.answerers ? { answerers: jira.answerers } : {}),
      ...(jira.email ? { email: jira.email } : {}),
      ...(jira.priorities ? { priorities: jira.priorities } : {}),
      ...(jira.abandonedResolutions ? { abandonedResolutions: jira.abandonedResolutions } : {}),
      ...(jira.blocksLink ? { blocksLink: jira.blocksLink } : {}),
    }));
  }
  return configured;
}

export function describeHosts(settings: HostSettings): string {
  const names = [
    ...(settings.meta ? [`${DEFAULT_META_REF} in ${settings.meta.repoPath}`] : []),
    ...(settings.github ? [settings.github.repo] : []),
    ...(settings.jira ? [`Jira project ${settings.jira.project} on ${settings.jira.site}${settings.jira.write ? "" : " (read-only)"}`] : []),
  ];
  if (names.length === 0) return "No host is configured: nothing is synced.";
  return `Syncing ${names.join(" and ")} (host from the ${settings.from === "file" ? "configuration file" : "environment"}).`;
}
