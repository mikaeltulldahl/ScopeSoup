// `scopesoup open`: one command that shows the board. Run in the project's repository (a clone or a worktree), it finds this
// machine's config (findConfig), starts Scope Soup for the project in the background when the board does not answer (no console
// window on Windows, output in `<data folder>/scopesoup.log`), waits until the board answers, then opens it in the default
// browser. When the board answers already, it only opens the browser. The Start menu shortcut `scopesoup shortcut` makes runs it.

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import http from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findConfig, installHome } from "./config/locate.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODE_FLAGS = "--disable-warning=ExperimentalWarning";

/** How the server is started in the background. */
export interface ServerSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  /** Where its output goes. */
  logFile: string;
}

/** What `openBoard` does to the machine, so a test can fake each. */
export interface OpenDeps {
  /** Whether something answers HTTP at `url`. */
  probe(url: string): Promise<boolean>;
  spawnServer(spec: ServerSpec): void;
  openBrowser(url: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface OpenOptions {
  /** The folder the command runs in (the project's repository). */
  cwd: string;
  env: Record<string, string | undefined>;
  /** Scope Soup's home; null for a development checkout. */
  home: string | null;
  platform: NodeJS.Platform;
  /** How long to wait for the board after starting it. */
  timeoutMs?: number;
}

export type OpenResult = { ok: true; url: string; started: boolean; logFile: string } | { ok: false; error: string };

/** The board's address from the environment, as `scopesoup start` reads it. */
export function boardUrl(env: Record<string, string | undefined>): string {
  const host = env.SCOPESOUP_HOST?.trim() || "127.0.0.1";
  const port = Number(env.SCOPESOUP_PORT) || 4310;
  const shown = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  return `http://${shown}:${port}`;
}

/** The launcher in Scope Soup's home, when there is one: it restarts Scope Soup after an upgrade. */
export function launcherIn(home: string | null, platform: NodeJS.Platform): string | null {
  if (!home) return null;
  const file = join(home, "bin", platform === "win32" ? "scopesoup.cmd" : "scopesoup");
  return existsSync(file) ? file : null;
}

export function serverSpec(options: OpenOptions, configFile: string, logFile: string, dataDir: string): ServerSpec {
  const env = { ...options.env, SCOPESOUP_CONFIG: configFile, SCOPESOUP_DATA: dataDir };
  const launcher = launcherIn(options.home, options.platform);
  if (launcher) {
    return options.platform === "win32"
      ? { command: "cmd.exe", args: ["/d", "/c", launcher, "start"], cwd: options.cwd, env, logFile }
      : { command: "sh", args: [launcher, "start"], cwd: options.cwd, env, logFile };
  }
  // A development checkout has no launcher: run this version's main.ts.
  return { command: process.execPath, args: [NODE_FLAGS, join(ROOT, "src", "main.ts")], cwd: options.cwd, env, logFile };
}

export async function openBoard(options: OpenOptions, deps: OpenDeps): Promise<OpenResult> {
  const found = findConfig({ env: options.env, cwd: options.cwd, home: options.home });
  if (!found.ok) return { ok: false, error: found.error };
  const url = boardUrl(options.env);
  const dataDir = resolve(options.env.SCOPESOUP_DATA ?? join(dirname(found.file), "data"));
  const logFile = join(dataDir, "scopesoup.log");
  if (await deps.probe(url)) {
    deps.openBrowser(url);
    return { ok: true, url, started: false, logFile };
  }
  deps.spawnServer(serverSpec(options, found.file, logFile, dataDir));
  const timeout = options.timeoutMs ?? 60_000;
  const deadline = deps.now() + timeout;
  while (deps.now() < deadline) {
    await deps.sleep(500);
    if (await deps.probe(url)) {
      deps.openBrowser(url);
      return { ok: true, url, started: true, logFile };
    }
  }
  return { ok: false, error: `Scope Soup was started but the board did not answer on ${url} within ${Math.round(timeout / 1000)} seconds. See ${logFile}.` };
}

/** The real thing: HTTP probe, a detached background process, the default browser. */
export const realDeps: OpenDeps = {
  probe: (url) => new Promise((done) => {
    const request = http.get(url, { timeout: 1500 }, (response) => {
      response.resume();
      done((response.statusCode ?? 500) < 500);
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => done(false));
  }),
  spawnServer: (spec) => {
    mkdirSync(dirname(spec.logFile), { recursive: true });
    const log = openSync(spec.logFile, "a");
    try {
      const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env as NodeJS.ProcessEnv, detached: true, windowsHide: true, stdio: ["ignore", log, log] });
      child.on("error", () => undefined);
      child.unref();
    } finally {
      closeSync(log);
    }
  },
  openBrowser: (url) => {
    const [command, args]: [string, string[]] = process.platform === "win32" ? ["cmd.exe", ["/d", "/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
    const child = spawn(command, args, { detached: true, windowsHide: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  },
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  now: () => Date.now(),
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await openBoard({ cwd: process.env.INIT_CWD ?? process.cwd(), env: process.env, home: installHome(), platform: process.platform }, realDeps);
  if (result.ok) {
    console.log(result.started ? `Started Scope Soup (log: ${result.logFile}) and opened ${result.url}.` : `Scope Soup is running: opened ${result.url}.`);
  } else {
    console.error(result.error);
    process.exitCode = 1;
  }
}
