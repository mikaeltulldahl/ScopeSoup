// "Open in my diff tool": runs `git difftool --no-prompt <base> <tip> [-- <file>]` in the clone that holds an Item's branch,
// with the person's own tool. Only the GLOBAL git config says which tool: the repository's config is code from the
// repository, so nothing it says about a diff tool is used (see `diffToolArgs`). No shell, detached, started on a click only.

import { spawn } from "node:child_process";
import type { ProjectConfig } from "../config/types.ts";
import type { Ref } from "../model/types.ts";
import type { Store } from "../store/store.ts";
import { itemDiff } from "./diff.ts";
import type { Git } from "./process.ts";
import { itemRepository } from "./workspaces.ts";

/** What the page shows when no tool is configured. */
export const NO_DIFF_TOOL = "Set a diff tool in your git config: git config --global diff.tool vscode (and, for a tool git does not know, difftool.<name>.cmd).";

/** Starts git and does not wait for the tool. Resolves once git started; rejects when it could not. Tests give a fake. */
export type DiffLauncher = (args: string[], cwd: string) => Promise<void>;

export const launchGit: DiffLauncher = (args, cwd) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, { cwd, detached: true, stdio: "ignore", windowsHide: true, shell: false });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolvePromise();
    });
  });

export interface OpenDiffDeps {
  store: Store;
  config: () => ProjectConfig;
  git: Git;
  now: () => Date;
  launch?: DiffLauncher;
}

export type OpenDiffResult = { ok: true; tool: string; file?: string } | { ok: false; status: number; code: string; message: string };

/** A tool name is used inside a config key, so only plain characters are taken. */
const TOOL_NAME = /^[A-Za-z0-9_+-]+$/;

async function globalValue(git: Git, cwd: string, key: string): Promise<string> {
  const read = await git(["config", "--global", "--get", key], cwd);
  return read.code === 0 ? read.stdout.replace(/\r?\n$/, "") : "";
}

/**
 * The arguments of git. Every setting that picks or defines a diff tool is given on the command line from the GLOBAL config
 * (an empty value when the global config has none), and a command-line setting beats the repository's: `diff.tool`, the tool's
 * `difftool.<name>.cmd` and `.path`, their `mergetool.<name>` fallbacks, and `difftool.guiDefault`. A tool that only the
 * repository defines is then "not a valid diff tool" to git, and nothing runs.
 */
export async function diffToolArgs(git: Git, repo: string, base: string, tip: string, file?: string): Promise<{ args: string[]; tool: string } | null> {
  const tool = await globalValue(git, repo, "diff.tool");
  if (!TOOL_NAME.test(tool)) return null;
  const pinned = [`diff.tool=${tool}`];
  for (const section of ["difftool", "mergetool"]) {
    for (const part of ["cmd", "path"]) pinned.push(`${section}.${tool}.${part}=${await globalValue(git, repo, `${section}.${tool}.${part}`)}`);
  }
  pinned.push("difftool.guiDefault=false");
  const overrides = pinned.flatMap((setting) => ["-c", setting]);
  return { args: [...overrides, "difftool", "--no-prompt", base, tip, ...(file === undefined ? [] : ["--", `:(literal)${file}`])], tool };
}

/** Opens the Item's change (or one file of it, which must be one the diff shows) in the person's diff tool. */
export async function openInDiffTool(deps: OpenDiffDeps, item: Ref, file?: string): Promise<OpenDiffResult> {
  const fail = (status: number, code: string, message: string): OpenDiffResult => ({ ok: false, status, code, message });
  const view = await itemDiff(deps, item);
  if (!view.available) return fail(404, "NO_DIFF", view.reason);
  if (file !== undefined && !view.files.some((each) => each.path === file)) return fail(400, "BAD_FILE", "That file is not one of the change's files.");
  let repo: string | null;
  try {
    repo = itemRepository(deps.store, deps.config(), item);
  } catch (error) {
    return fail(404, "NO_DIFF", error instanceof Error ? error.message : String(error));
  }
  if (!repo) return fail(404, "NO_DIFF", "No clone holds this item's branch.");
  const built = await diffToolArgs(deps.git, repo, view.base, view.tip, file);
  if (!built) return fail(409, "NO_DIFF_TOOL", NO_DIFF_TOOL);
  try {
    await (deps.launch ?? launchGit)(built.args, repo);
  } catch (error) {
    return fail(500, "OPEN_FAILED", `Could not start git: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ok: true, tool: built.tool, ...(file === undefined ? {} : { file }) };
}
