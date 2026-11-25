// The `copilot -p` command line for one session, and how a role's `allowedTools` become Copilot's permission rules.
// Copilot names a shell command by its program and, for git, npm, pnpm and the like, its first subcommand only: `shell(git:*)`
// allows every git command, `shell(git push)` every push, and a rule for `git push --force` matches nothing. So a Claude-style
// entry is mapped only when the mapping allows no more than the entry did; anything else is left out (narrower, never wider).
// No Node modules here or in what the provider's index imports: the board's build reads the provider list through
// `config/levels.ts`. What needs Node (finding copilot.exe, reading files) is in `driver.ts` or passed in by the caller.

import { COPILOT_DEFAULT_AUTO_TIER } from "../../../config/defaults.ts";
import type { CopilotConfig, ProjectConfig } from "../../../config/types.ts";
import type { SessionRole } from "../../../model/types.ts";
import type { Env, Launch, ProgramAdvice } from "../../agent.ts";
import { answerInstruction } from "./answer.ts";

export function copilotConfig(config: ProjectConfig): CopilotConfig {
  return config.copilot ?? { path: "copilot", prefixArgs: [], extraArgs: [] };
}

export const ADVICE: ProgramAdvice = {
  shim: "Set copilot.path in the project configuration to the real copilot.exe.",
  missing: "Install GitHub Copilot CLI and sign in (`copilot login`), or set copilot.path in the project configuration to the full path of the .exe.",
};

/** The environment variables Copilot signs in with, strongest first (`copilot help environment`). */
export const TOKEN_ENV = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;

export interface CopilotRules {
  /** `--allow-tool` rules. */
  allow: string[];
  /** `--deny-tool` rules: they win over every allow. */
  deny: string[];
  /** The allowedTools entries no rule could hold without allowing more; their commands are refused. */
  left: string[];
}

const FILE_WRITES = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** Reads in the working folder need no rule: Copilot allows them. */
const FILE_READS = new Set(["Read", "Glob", "Grep", "LS"]);

/** Git subcommands that only read: a rule for one of them may allow every flag of it. */
export const READ_ONLY_GIT = new Set(["status", "log", "diff", "show", "blame", "shortlog", "ls-files", "ls-tree", "rev-parse", "cat-file", "grep"]);

/**
 * One `Bash(...)` entry as a Copilot shell rule, or null when it cannot be held: `Bash(git *)` is `shell(git:*)`,
 * `Bash(pnpm check*)` is `shell(pnpm check:*)`. A rule names a command whatever its flags follow, so an exact entry
 * (`Bash(git branch)`) cannot be held, except for a read-only git subcommand (`Bash(git status)` is `shell(git status)`).
 * Three words or more, a flag in the subcommand's place, or a wildcard inside the command cannot be held either.
 */
export function shellRule(tool: string): string | null | undefined {
  const match = /^Bash(?:\((.*)\))?$/.exec(tool.trim());
  if (!match) return undefined;
  const inner = (match[1] ?? "*").trim();
  if (inner === "*" || inner === "") return "shell";
  const open = /(?::\*|\s*\*)$/.test(inner);
  const words = inner.replace(/(?::\*|\s*\*)$/, "").trim().split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return "shell";
  if (words.length > 2 || words.some((word) => /[*?"'`{}()$;&|<>]/.test(word)) || words[1]?.startsWith("-")) return null;
  if (!open && !(words[0] === "git" && READ_ONLY_GIT.has(words[1] ?? ""))) return null;
  return `shell(${words.join(" ")}${open ? ":*" : ""})`;
}

/**
 * The permission rules for a role's allowedTools. A push is always refused: Copilot cannot refuse a force push alone
 * (`docs/DECISIONS.md`), so it refuses every `git push`.
 */
export function copilotRules(allowedTools: readonly string[]): CopilotRules {
  const allow: string[] = [];
  const left: string[] = [];
  const add = (rule: string) => {
    if (!allow.includes(rule)) allow.push(rule);
  };
  for (const tool of allowedTools) {
    const name = tool.trim();
    if (FILE_READS.has(name)) continue;
    if (FILE_WRITES.has(name)) {
      add("write");
      continue;
    }
    const rule = shellRule(name);
    if (rule) add(rule);
    else left.push(name);
  }
  return { allow, deny: ["shell(git push)"], left };
}

/** The git commands a rule allows beyond the read-only ones: `git` for every git command, else `git <sub>`; null for none. */
export function gitBeyondReading(rule: string): string | null {
  if (rule === "shell" || rule === "shell(git:*)") return "git";
  const match = /^shell\(git (\S+?)(?::\*)?\)$/.exec(rule);
  return match && !READ_ONLY_GIT.has(match[1] ?? "") ? `git ${match[1]}` : null;
}

/**
 * Why the role's sessions cannot be held to the core rules on Copilot, or null. Every session is refused `--no-verify`
 * (`docs/RULES.md`), and commit, merge, rebase, pull, am, revert, cherry-pick and stash make commits or run hooks. Copilot
 * cannot refuse a flag, so a role may run no git command on it but the read-only ones (`READ_ONLY_GIT`).
 */
export function copilotRefusal(config: ProjectConfig, role: SessionRole): string | null {
  const beyond = copilotRules(config.roles[role].allowedTools).allow.map(gitBeyondReading).filter((text): text is string => text !== null);
  if (beyond.length === 0) return null;
  return `Refused: Copilot CLI cannot refuse a flag such as \`--no-verify\` (its rules name a command, never its flags), so a role on it may run only read-only git commands, and roles.${role} allows ${beyond.map((text) => `\`${text}\``).join(", ")}. Run ${role} on Claude, or take those out of its allowedTools.`;
}

/** A `file:` URL as a path on this machine (`C:\\x\\y.ts` on Windows, `/x/y.ts` elsewhere), without `node:url`. */
export function pathOfFileUrl(url: URL): string {
  const path = decodeURIComponent(url.pathname);
  return /^\/[A-Za-z]:/.test(path) ? path.slice(1).replace(/\//g, "\\") : path;
}

/** The driver that runs the CLI and asks again once for an answer that fits (`driver.ts`). */
export const DRIVER = pathOfFileUrl(new URL("./driver.ts", import.meta.url));
const NODE_FLAGS = ["--disable-warning=ExperimentalWarning"];

/** What the driver is sent on stdin. */
export interface DriverSpec {
  program: string;
  /** The CLI's arguments, without `-p` and `--resume`. */
  args: string[];
  prompt: string;
  resume?: string;
  /** The answer's schema on one line; absent: free text. */
  schema?: string;
}

/** The usage file Copilot writes beside the session's stream: `<stream><USAGE_SUFFIX>`. */
export const USAGE_SUFFIX = ".usage.json";
/** The usage file of the driver's second run (asking again), so it does not overwrite the first run's. */
export const RETRY_USAGE_SUFFIX = ".usage-2.json";

export function usageFile(streamPath: string): string {
  return `${streamPath}${USAGE_SUFFIX}`;
}

export function retryUsageFile(path: string): string {
  return path.endsWith(USAGE_SUFFIX) ? `${path.slice(0, -USAGE_SUFFIX.length)}${RETRY_USAGE_SUFFIX}` : path;
}

export interface CopilotLaunchRequest {
  config: ProjectConfig;
  role: SessionRole;
  prompt: string;
  schema?: string;
  resume?: string;
  env: Env;
  streamPath?: string;
  /** The Node program that runs Scope Soup, which runs the driver. */
  nodePath?: string;
}

/** The CLI's own arguments for one session of a role (the prompt and `--resume` are the driver's). */
export function copilotArgs(config: ProjectConfig, role: SessionRole, streamPath?: string): string[] {
  const copilot = copilotConfig(config);
  const spec = config.roles[role];
  const args = [...copilot.prefixArgs, "--output-format", "json", "--model", spec.model];
  // Fusion and Auto route among the plan's models by a profile; a named model takes none. No `--reasoning-effort`: Fusion refuses it.
  if (/^(fusion|auto)$/i.test(spec.model)) args.push("--auto-tier", spec.autoTier ?? COPILOT_DEFAULT_AUTO_TIER);
  // Nothing the person did not ask for: no question form, no built-in GitHub tools on the person's account, no self-update.
  args.push("--no-ask-user", "--disable-builtin-mcps", "--no-auto-update");
  const rules = copilotRules(spec.allowedTools);
  for (const rule of rules.allow) args.push(`--allow-tool=${rule}`);
  for (const rule of rules.deny) args.push(`--deny-tool=${rule}`);
  // The sign-in token stays out of the commands the agent runs.
  args.push(`--secret-env-vars=${TOKEN_ENV.join(",")}`);
  if (streamPath) args.push("--usage-output-file", usageFile(streamPath));
  args.push(...copilot.extraArgs);
  return args;
}

/**
 * The child to spawn: Node running the driver, which runs the CLI. The prompt travels on stdin to the driver. The driver finds
 * the CLI's real path (on Windows the .exe, never a shim) and ends the session with `ADVICE` when there is none.
 */
export function buildLaunch(request: CopilotLaunchRequest): Launch {
  if (!request.nodePath) throw new Error("the Copilot provider runs its driver with Node, and the launch named no Node program");
  const program = copilotConfig(request.config).path;
  const spec: DriverSpec = {
    program,
    args: copilotArgs(request.config, request.role, request.streamPath),
    // A resumed session is reminded of the answer too: its message may be findings, not the prompt.
    prompt: request.schema ? `${request.prompt}\n\n${answerInstruction(request.schema)}` : request.prompt,
    ...(request.resume ? { resume: request.resume } : {}),
    ...(request.schema ? { schema: request.schema } : {}),
  };
  return { command: request.nodePath, args: [...NODE_FLAGS, DRIVER], stdin: JSON.stringify(spec), env: { ...request.env } };
}
