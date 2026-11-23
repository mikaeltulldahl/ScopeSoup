// Finds the real executable behind a command name. On Windows `spawn` without a shell can only
// start an .exe (or .com): a `.cmd` or `.bat` shim, which is what npm installs, throws EINVAL.
// Everything else (POSIX) is left to the operating system's own lookup.

import { statSync } from "node:fs";
import { win32 } from "node:path";

export class ExecutableNotFound extends Error {}

export interface ResolveOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** True when the path is a file. Replaceable in tests. */
  isFile?: (path: string) => boolean;
  /** What the person should change when nothing startable is found. Default: a general one. */
  advice?: { shim: string; missing: string };
}

const GENERAL_ADVICE = {
  shim: "Give the full path of the real .exe in the project configuration.",
  missing: "Install it, or give the full path of the .exe in the project configuration.",
};

const DIRECT = [".exe", ".com"];

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The environment variable's value whatever its case (Windows keeps `Path`, not `PATH`). */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

/**
 * The path to start for `command`. On Windows: the command as given when it names an .exe/.com,
 * else the first match in the PATH search, trying `.exe` and `.com` before anything
 * else. When only a shim (.cmd, .bat, .ps1 or no extension) exists, throws with the shim's path and
 * what to do about it. Elsewhere returns the command unchanged.
 */
export function resolveExecutable(command: string, options: ResolveOptions = {}): string {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return command;
  const isFile = options.isFile ?? fileExists;
  const env = options.env ?? process.env;
  const path = win32;

  const hasDirectory = path.isAbsolute(command) || /[\\/]/.test(command);
  const directories = hasDirectory ? [""] : (envValue(env, "PATH") ?? "").split(";").map((dir) => dir.trim().replace(/^"(.*)"$/, "$1")).filter((dir) => dir !== "");
  const extension = path.extname(command).toLowerCase();
  const startable = (base: string): string[] => (DIRECT.includes(extension) ? [base] : extension === "" ? DIRECT.map((suffix) => base + suffix) : []);
  const shims = (base: string): string[] => (extension === "" ? [".cmd", ".bat", ".ps1"].map((suffix) => base + suffix) : DIRECT.includes(extension) ? [] : [base]);

  let shim: string | undefined;
  for (const dir of directories) {
    const base = dir === "" ? command : path.join(dir, command);
    for (const candidate of startable(base)) if (isFile(candidate)) return candidate;
    for (const candidate of shims(base)) if (isFile(candidate)) shim ??= candidate;
  }
  const advice = options.advice ?? GENERAL_ADVICE;
  if (shim !== undefined) {
    throw new ExecutableNotFound(`Found ${shim}, which is a shell shim, and a shim cannot be started without a shell. ${advice.shim}`);
  }
  throw new ExecutableNotFound(`Could not find ${command}${hasDirectory ? "" : " on PATH"}. ${advice.missing}`);
}

