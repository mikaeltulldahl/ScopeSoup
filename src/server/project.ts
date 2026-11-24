// Which project a board belongs to (its name, its repository, its page on GitHub), and opening the project's folders in
// the file manager. The page names a folder ("checkout", "clone", "config"); the path always comes from the configuration.

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { ProjectConfig } from "../config/types.ts";
import type { FolderName, ProjectView } from "../core/views.ts";

export const FOLDER_NAMES: readonly FolderName[] = ["checkout", "clone", "config"];

export function isFolderName(value: unknown): value is FolderName {
  return typeof value === "string" && (FOLDER_NAMES as readonly string[]).includes(value);
}

/** What the server knows of the project: the board's view, and the paths behind the folder names. */
export interface ProjectInfo {
  name: string;
  repository: string | null;
  github: string | null;
  folders: Partial<Record<FolderName, string>>;
}

/** Which project a server serves, as `/api/health` says it: the name and repository, nothing personal (no paths). */
export interface ProjectIdentity {
  name: string;
  repository: string | null;
}

/** Whether a server's project is the one asked for. A server that says nothing is not. */
export function sameProject(wanted: ProjectIdentity, served: ProjectIdentity | null): boolean {
  return served !== null && served.name === wanted.name && served.repository === wanted.repository;
}

const REPOSITORY_NAME = /^[\w.-]+\/[\w.-]+$/;

/** The GitHub page of "owner/name", or null when it is not one. */
export function githubPage(repository: string): string | null {
  return REPOSITORY_NAME.test(repository) ? `https://github.com/${repository}` : null;
}

/**
 * "owner/name" from a remote's URL (`https://host/owner/name.git`, `ssh://git@host/owner/name`, `git@host:owner/name.git`), with
 * its GitHub page when the host is github.com. Null for a local path or anything else.
 */
export function repositoryFromUrl(url: string): { name: string; github: string | null } | null {
  const text = url.trim();
  let host: string;
  let path: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let parsed: URL;
    try {
      parsed = new URL(text);
    } catch {
      return null;
    }
    if (parsed.protocol === "file:" || parsed.hostname === "") return null;
    host = parsed.hostname;
    path = parsed.pathname;
  } else {
    // scp-like: [user@]host:path. A single letter before the colon is a Windows drive, not a host.
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(text);
    if (!scp || /^[A-Za-z]$/.test(scp[1] ?? "")) return null;
    host = scp[1] ?? "";
    path = scp[2] ?? "";
  }
  const parts = path.replace(/\/+$/, "").replace(/\.git$/, "").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const name = parts.slice(-2).join("/");
  if (!REPOSITORY_NAME.test(name)) return null;
  return { name, github: host.toLowerCase() === "github.com" ? githubPage(name) : null };
}

/**
 * The project of a configuration: its name, its repository ("owner/name" from the GitHub host, else from the remote's URL, else
 * the remote's name) and its folders. `remoteUrlOf` is `git remote get-url`; a failure leaves the remote's name.
 */
export function projectInfo(config: ProjectConfig, configFile: string, remoteUrlOf: (repoPath: string, remote: string) => string): ProjectInfo {
  const folders: Partial<Record<FolderName, string>> = { clone: config.repoPath, config: dirname(configFile) };
  const checkout = config.ownClone ?? config.realPaths[0];
  if (checkout !== undefined) folders.checkout = checkout;
  if (config.host?.kind === "github") return { name: config.project, repository: config.host.repo, github: githubPage(config.host.repo), folders };
  let url = config.remoteUrl ?? "";
  if (url === "") {
    try {
      url = remoteUrlOf(config.repoPath, config.remote);
    } catch {
      url = "";
    }
  }
  const found = repositoryFromUrl(url);
  return { name: config.project, repository: found?.name ?? config.remote, github: found?.github ?? null, folders };
}

/** Whether a path is an absolute folder that is there. */
export function isFolder(path: string): boolean {
  if (!isAbsolute(path)) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The board's view of the project: the folders listed are the ones that are there. */
export function projectView(info: ProjectInfo, folderThere: (path: string) => boolean = isFolder): ProjectView {
  const folders = FOLDER_NAMES.filter((name) => {
    const path = info.folders[name];
    return path !== undefined && folderThere(path);
  });
  return { name: info.name, repository: info.repository, github: info.github, folders };
}

/** The file manager's program for a platform: Explorer, Finder (`open`), or `xdg-open`. */
export function fileManager(platform: NodeJS.Platform): string {
  if (platform === "win32") return "explorer.exe";
  if (platform === "darwin") return "open";
  return "xdg-open";
}

/** Opens one folder in the file manager. The server calls it only with a path from the configuration; tests give a fake. */
export type FolderOpener = (path: string) => Promise<void>;

/**
 * Starts the file manager on the folder and does not wait for it: no shell (the path is one argument, never parsed), detached.
 * Resolves once the program started; rejects when it could not be.
 *
 * Not `windowsHide`: Explorer takes it for the window it opens, and the folder opened as a hidden window (tried on Windows 11).
 * Explorer has no console window to hide.
 */
export function openFolder(path: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(fileManager(platform), [path], { detached: true, stdio: "ignore", windowsHide: false, shell: false });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolvePromise();
    });
  });
}
