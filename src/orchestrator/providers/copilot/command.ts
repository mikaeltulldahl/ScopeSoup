// The `copilot -p` command line for one session, and how a role's `allowedTools` become Copilot's permission rules.
// Copilot names a shell command by its program and, for git, npm, pnpm and the like, its first subcommand only: `shell(git:*)`
// allows every git command, `shell(git push)` every push, and a rule for `git push --force` matches nothing. So a Claude-style
// entry is mapped only when the mapping allows no more than the entry did; anything else is left out (narrower, never wider).

import { fileURLToPath } from "node:url";
import { COPILOT_DEFAULT_AUTO_TIER } from "../../../config/defaults.ts";
import type { CopilotConfig, ProjectConfig } from "../../../config/types.ts";
import type { SessionRole } from "../../../model/types.ts";
import type { Env, Launch, ProgramAdvice } from "../../agent.ts";
import { resolveExecutable } from "../../executable.ts";
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

/**
 * One `Bash(...)` entry as a Copilot shell rule, or null when it cannot be held: `Bash(git *)` is `shell(git:*)`,
 * `Bash(pnpm check*)` is `shell(pnpm check:*)`, `Bash(git status)` is `shell(git status)`. Three words or more, a flag in the
 * subcommand's place, or a wildcard inside the command cannot be said without allowing more.
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

/** Whether a rule allows `git <sub>` (and so every flag of it). */
export function allowsGit(rules: readonly string[], sub: string): boolean {
  return rules.some((rule) => rule === "shell" || rule === "shell(git:*)" || rule === `shell(git ${sub}:*)` || rule === `shell(git ${sub})`);
}

/**
 * Why the role's sessions cannot be held to the core rules on Copilot, or null. Every session is refused `--no-verify`
 * (`docs/RULES.md`); Copilot cannot refuse a flag, so a role that may run `git commit` at all could skip the hooks.
 */
export function copilotRefusal(config: ProjectConfig, role: SessionRole): string | null {
  const rules = copilotRules(config.roles[role].allowedTools).allow;
  const commits = allowsGit(rules, "commit");
  if (!commits) return null;
  return `Refused: Copilot CLI cannot refuse \`git commit --no-verify\` while it allows \`git commit\` (its rules name a command, never a flag), so roles.${role} may not run on Copilot with these allowedTools. Run ${role} on Claude, or take git commit out of its allowedTools.`;
}

/** The driver that runs the CLI and asks again once for an answer that fits (`driver.ts`). */
export const DRIVER = fileURLToPath(new URL("./driver.ts", import.meta.url));
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

/** The usage file Copilot writes beside the session's stream. */
export function usageFile(streamPath: string): string {
  return `${streamPath}.usage.json`;
}

export interface CopilotLaunchRequest {
  config: ProjectConfig;
  role: SessionRole;
  prompt: string;
  schema?: string;
  resume?: string;
  env: Env;
  streamPath?: string;
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
 * The child to spawn: Node running the driver, which runs the CLI. The prompt travels on stdin to the driver. The CLI's path
 * is found here (on Windows the real .exe, never a shim), so a missing program fails the session before anything starts.
 */
export function buildLaunch(request: CopilotLaunchRequest): Launch {
  const program = resolveExecutable(copilotConfig(request.config).path, { env: request.env, advice: ADVICE });
  const spec: DriverSpec = {
    program,
    args: copilotArgs(request.config, request.role, request.streamPath),
    // A resumed session is reminded of the answer too: its message may be findings, not the prompt.
    prompt: request.schema ? `${request.prompt}\n\n${answerInstruction(request.schema)}` : request.prompt,
    ...(request.resume ? { resume: request.resume } : {}),
    ...(request.schema ? { schema: request.schema } : {}),
  };
  return { command: process.execPath, args: [...NODE_FLAGS, DRIVER], stdin: JSON.stringify(spec), env: { ...request.env } };
}
