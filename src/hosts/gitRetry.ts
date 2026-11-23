// Runs a git command once more when Windows ended it from outside. Under load, a git
// that had started sometimes exits with 4294967295 (-1 as an unsigned 32-bit number) and prints
// nothing: git itself never exits that way (it dies with 128), so the process was ended by
// something else (TerminateProcess with -1) or failed before it ran. Only that is retried, once,
// and only for a command that is safe to run again: one that reads, or one that writes an object
// by its content, or moves a ref only from the value it was read at (a repeat of a move that had
// in fact happened fails instead of writing twice). Every retry is logged.
//
// This sits under src/hosts beside spawnRetry.ts, so the orchestrator and the tests can use it too.

/** The exit code of a process Windows ended from outside with -1. */
export const ENDED_FROM_OUTSIDE = 4294967295;

/** The git command in the arguments: the first that is not an option or a `-c` value. */
export function gitCommand(args: readonly string[]): string {
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "-c" || args[index] === "-C") index++;
    else if (!args[index]?.startsWith("-")) return args[index] ?? "";
  }
  return "";
}

/** Commands that only read. */
const READS = new Set(["cat-file", "ls-tree", "rev-parse", "for-each-ref", "show-ref", "show", "log", "diff", "diff-tree", "merge-base", "rev-list", "ls-files", "ls-remote", "name-rev", "describe", "var", "version"]);

/** Writes of an object named by its content: a repeat writes the same object, or an unreferenced one. */
const OBJECT_WRITES = new Set(["hash-object", "mktree", "commit-tree"]);

/** `git config` options that only read. */
const CONFIG_READ_OPTIONS = new Set(["--get", "--get-all", "--local", "--global", "--system", "--null", "-z", "--type=bool", "--bool"]);

/**
 * True when running the command again cannot do anything the first run would not have: it reads,
 * writes objects by content, reads one config value, or is an `update-ref` that names the old value.
 */
export function isSafeToRepeat(args: readonly string[]): boolean {
  const command = gitCommand(args);
  if (READS.has(command) || OBJECT_WRITES.has(command)) return true;
  const rest = args.slice(args.indexOf(command) + 1);
  if (command === "config") {
    const options = rest.filter((arg) => arg.startsWith("-"));
    const names = rest.filter((arg) => !arg.startsWith("-"));
    return names.length === 1 && options.every((option) => CONFIG_READ_OPTIONS.has(option));
  }
  if (command === "update-ref") {
    // update-ref [-m <message>] <ref> <new> <old>, or update-ref -d <ref> <old>: a compare-and-swap.
    const positional: string[] = [];
    let deleting = false;
    for (let index = 0; index < rest.length; index++) {
      const arg = rest[index] as string;
      if (arg === "-m") index++;
      else if (arg === "-d") deleting = true;
      else if (arg === "--stdin" || arg.startsWith("-")) return false;
      else positional.push(arg);
    }
    return positional.length === (deleting ? 2 : 3);
  }
  return false;
}

/** True when this outcome of git is one to run again: ended from outside, nothing on stderr, a command safe to repeat. */
export function shouldRetryGit(args: readonly string[], code: number | null, stderr: string): boolean {
  return code === ENDED_FROM_OUTSIDE && stderr.trim() === "" && isSafeToRepeat(args);
}

export interface GitRetryOptions {
  /** Told once per retry. Default: console.warn. */
  log?: (line: string) => void;
}

function line(args: readonly string[], ms: number): string {
  return `git ${gitCommand(args)}: exited with ${ENDED_FROM_OUTSIDE} and no output on stderr after ${ms} ms (ended from outside); running it once more`;
}

/** Runs `attempt` (one git with `args`), and once more when `shouldRetryGit` says so. The second outcome is returned as it is. */
export async function retryGitOnce<T extends { code: number | null; stderr: string }>(args: readonly string[], attempt: () => Promise<T>, options: GitRetryOptions = {}): Promise<T> {
  const started = Date.now();
  const first = await attempt();
  if (!shouldRetryGit(args, first.code, first.stderr)) return first;
  (options.log ?? console.warn)(line(args, Date.now() - started));
  return attempt();
}

/** The same for a synchronous git that throws when it fails (`execFileSync`: the error carries `status` and `stderr`). */
export function retryGitOnceSync<T>(args: readonly string[], attempt: () => T, options: GitRetryOptions = {}): T {
  const started = Date.now();
  try {
    return attempt();
  } catch (error) {
    const { status, stderr } = error as { status?: unknown; stderr?: unknown };
    const text = stderr === undefined || stderr === null ? "" : String(stderr);
    if (typeof status !== "number" || !shouldRetryGit(args, status, text)) throw error;
    (options.log ?? console.warn)(line(args, Date.now() - started));
    return attempt();
  }
}
