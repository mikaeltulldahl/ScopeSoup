// What the Windows .exe runs (`pnpm release --exe`, src/exe/build.ts): it sets up Scope Soup's home from the release and
// the Node runtime packed inside it, on a machine without Node, admin rights or the network.
//
//   scopesoup-<version>-win-x64.exe [--home <folder>]
//
// It unpacks `scopesoup-<version>/` and `node/node.exe` into the home (default %LOCALAPPDATA%\ScopeSoup, asked when run in a
// console without --home), runs that release's `setup-home` with that Node (the pointer and the launcher, src/upgrade/home.ts),
// and says what to do next. Everything it writes is inside the home; it changes no setting of the machine (not the PATH).
//
// This file is the .exe's whole program, so it imports nothing: the build strips its types and its `export` keywords and
// embeds it as a CommonJS script, which reaches Node's modules through `process.getBuiltinModule`. Only the pack format and
// the pure parts are exported, for the build and the tests.

/** The folder in the home that holds the bundled Node (the launcher puts it on its own PATH: `BUNDLED_NODE` in home.ts). */
export const NODE_DIR = "node";
/** The name of the packed release inside the .exe (a SEA asset). */
export const PAYLOAD_ASSET = "payload";
const MAGIC = "SSP1";
const NODE_FLAGS = "--disable-warning=ExperimentalWarning";

/** What the pack says about itself, before the files' bytes. */
export interface PackHeader {
  version: string;
  /** The release folder's name, `scopesoup-<version>`. */
  folder: string;
  /** The bundled Node's version, `v26.1.0`. */
  node: string;
  files: { path: string; size: number }[];
}

/** One file to pack: its path inside the home (forward slashes) and its bytes. */
export interface PackEntry {
  path: string;
  bytes: Uint8Array;
}

/** Why `path` may not be written into the home, or null: only the release folder and `node/`, no `..`, nothing absolute. */
export function entryProblem(path: string, folder: string): string | null {
  if (path === "" || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return `${path} is not a relative path with forward slashes`;
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return `${path} has an empty, . or .. part`;
  if (parts.length < 2 || (parts[0] !== folder && parts[0] !== NODE_DIR)) return `${path} is not inside ${folder}/ or ${NODE_DIR}/`;
  return null;
}

/** The pack: a magic, the header's length, the header (JSON) and the files' bytes one after the other, gzipped. */
export function packFiles(header: Omit<PackHeader, "files">, entries: readonly PackEntry[]): Uint8Array {
  const { Buffer } = process.getBuiltinModule("node:buffer");
  const zlib = process.getBuiltinModule("node:zlib");
  for (const entry of entries) {
    const problem = entryProblem(entry.path, header.folder);
    if (problem) throw new Error(problem);
  }
  const full: PackHeader = { ...header, files: entries.map((entry) => ({ path: entry.path, size: entry.bytes.length })) };
  const json = Buffer.from(JSON.stringify(full), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(json.length);
  return zlib.gzipSync(Buffer.concat([Buffer.from(MAGIC, "ascii"), length, json, ...entries.map((entry) => Buffer.from(entry.bytes))]), { level: 9 });
}

/** Reads a pack back: the header and each file. Throws when it is not a pack or a path would leave the home. */
export function readPack(packed: Uint8Array): { header: PackHeader; entries: PackEntry[] } {
  const { Buffer } = process.getBuiltinModule("node:buffer");
  const zlib = process.getBuiltinModule("node:zlib");
  const raw = zlib.gunzipSync(packed);
  if (raw.length < 8 || raw.subarray(0, 4).toString("ascii") !== MAGIC) throw new Error("The .exe holds no Scope Soup release.");
  const length = raw.readUInt32LE(4);
  const header = JSON.parse(raw.subarray(8, 8 + length).toString("utf8")) as PackHeader;
  if (!/^scopesoup-\d+\.\d+\.\d+$/.test(header.folder) || header.folder !== `scopesoup-${header.version}`) throw new Error(`The packed release folder ${header.folder} is not named after version ${header.version}.`);
  const entries: PackEntry[] = [];
  let at = 8 + length;
  for (const file of header.files) {
    const problem = entryProblem(file.path, header.folder);
    if (problem) throw new Error(problem);
    if (at + file.size > raw.length) throw new Error("The packed release is cut short.");
    entries.push({ path: file.path, bytes: raw.subarray(at, at + file.size) });
    at += file.size;
  }
  for (const needed of [`${header.folder}/package.json`, `${header.folder}/src/scopesoup.ts`, `${NODE_DIR}/node.exe`]) {
    if (!entries.some((entry) => entry.path === needed)) throw new Error(`The packed release has no ${needed}.`);
  }
  return { header, entries: entries.map((entry) => ({ path: entry.path, bytes: Buffer.from(entry.bytes) })) };
}

export interface ExeArgs {
  home: string | null;
  help: boolean;
}

/** `--home <folder>`, `--home=<folder>`, `--help`. Throws on anything else. */
export function parseArgs(args: readonly string[]): ExeArgs {
  let home: string | null = null;
  let help = false;
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!;
    if (arg === "--help" || arg === "-h" || arg === "/?") help = true;
    else if (arg === "--home") {
      const value = args[++at];
      if (!value) throw new Error("--home needs a folder.");
      home = value;
    } else if (arg.startsWith("--home=") && arg.length > "--home=".length) home = arg.slice("--home=".length);
    else throw new Error(`Unknown argument ${arg}.`);
  }
  return { home, help };
}

/** The home proposed when none is given: %LOCALAPPDATA%\ScopeSoup (the person's own folder, no admin rights needed). */
export function defaultHome(env: Readonly<Record<string, string | undefined>>): string {
  const { win32 } = process.getBuiltinModule("node:path");
  const local = env.LOCALAPPDATA?.trim() || (env.USERPROFILE?.trim() ? win32.join(env.USERPROFILE.trim(), "AppData", "Local") : "");
  if (!local) throw new Error("LOCALAPPDATA is not set: give the folder with --home.");
  return win32.join(local, "ScopeSoup");
}

/** The two parts the home gets: the release folder and the Node folder, each the files that go into it. */
export function partsOf(header: PackHeader): { release: string[]; node: string[] } {
  const release = header.files.filter((file) => file.path.startsWith(`${header.folder}/`)).map((file) => file.path);
  const node = header.files.filter((file) => file.path.startsWith(`${NODE_DIR}/`)).map((file) => file.path);
  return { release, node };
}

/** The one line naming the version that runs, or null (as `readPointer` in home.ts). */
function pointerOf(home: string): string | null {
  const fs = process.getBuiltinModule("node:fs");
  const path = process.getBuiltinModule("node:path");
  try {
    const line = fs.readFileSync(path.join(home, "current"), "utf8").split(/\r?\n/)[0]?.trim() ?? "";
    return /^scopesoup-\d+\.\d+\.\d+$/.test(line) ? line : null;
  } catch {
    return null;
  }
}

/** Writes `entries` (paths starting with `top/`) into `<home>/<top>` through a temporary folder renamed into place. */
function writePart(home: string, top: string, entries: readonly PackEntry[]): void {
  const fs = process.getBuiltinModule("node:fs");
  const path = process.getBuiltinModule("node:path");
  const temp = path.join(home, `.unpack-${top}-${process.pid}`);
  fs.rmSync(temp, { recursive: true, force: true });
  try {
    for (const entry of entries) {
      const target = path.join(temp, ...entry.path.split("/").slice(1));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.bytes);
    }
    const target = path.join(home, top);
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (error) {
      throw new Error(`${target} could not be replaced; is Scope Soup running from it? Stop it and run this again. (${error instanceof Error ? error.message : String(error)})`);
    }
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

/** What `install` did, for the summary. */
export interface InstallResult {
  home: string;
  folder: string;
  node: string;
  releaseWritten: boolean;
  nodeWritten: boolean;
}

/**
 * Unpacks the pack into `home`: the release folder unless it is there and the version that runs (it is never replaced
 * under a running Scope Soup), and `node/` unless it already holds this Node. Returns what was written.
 */
export function install(packed: Uint8Array, home: string): InstallResult {
  const fs = process.getBuiltinModule("node:fs");
  const path = process.getBuiltinModule("node:path");
  const { header, entries } = readPack(packed);
  fs.mkdirSync(home, { recursive: true });
  const inUse = pointerOf(home) === header.folder && fs.existsSync(path.join(home, header.folder, "package.json"));
  if (!inUse) writePart(home, header.folder, entries.filter((entry) => entry.path.startsWith(`${header.folder}/`)));
  const versionFile = path.join(home, NODE_DIR, "VERSION");
  let nodeThere = "";
  try {
    nodeThere = fs.readFileSync(versionFile, "utf8").trim();
  } catch { /* none yet */ }
  const nodeWritten = nodeThere !== header.node || !fs.existsSync(path.join(home, NODE_DIR, "node.exe"));
  if (nodeWritten) {
    writePart(home, NODE_DIR, entries.filter((entry) => entry.path.startsWith(`${NODE_DIR}/`)));
    fs.writeFileSync(versionFile, header.node);
  }
  return { home, folder: header.folder, node: header.node, releaseWritten: !inUse, nodeWritten };
}

/** The command that runs the release's `setup-home` with the bundled Node. */
export function setupHomeCommand(home: string, folder: string): { command: string; args: string[] } {
  const { win32 } = process.getBuiltinModule("node:path");
  return { command: win32.join(home, NODE_DIR, "node.exe"), args: [NODE_FLAGS, win32.join(home, folder, "src", "scopesoup.ts"), "setup-home"] };
}

/** What the person does next, after `setup-home` has printed the home, the launcher and how to add it to the PATH. */
export function nextSteps(home: string): string[] {
  const { win32 } = process.getBuiltinModule("node:path");
  const launcher = win32.join(home, "bin", "scopesoup.cmd");
  return [
    "",
    "Scope Soup is set up. Next:",
    "  1. Add the launcher's folder to your PATH as printed above, and open a new terminal: `scopesoup version` prints the version.",
    "  2. To put a project under Scope Soup, start Claude Code in the project's clone and run:",
    "       /plugin marketplace add mikaeltulldahl/scopesoup",
    "       /plugin install scopesoup@scopesoup",
    "       /scopesoup:scopesoup-onboard",
    "  3. For a project that is set up already, run `scopesoup open` in its clone (the board opens in the browser).",
    `Without the PATH change, use ${launcher} in place of \`scopesoup\`. Node is not needed on this machine: the launcher uses the one in ${win32.join(home, NODE_DIR)}.`,
  ];
}

const USAGE = [
  "usage: scopesoup-<version>-win-x64.exe [--home <folder>]",
  "Sets up Scope Soup's home (default %LOCALAPPDATA%\\ScopeSoup): the release, a Node runtime and the launcher.",
  "Needs no Node, no admin rights and no network; changes no setting of the machine.",
].join("\n");

async function ask(question: string): Promise<string> {
  const readline = process.getBuiltinModule("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function main(args: string[]): Promise<number> {
  const sea = process.getBuiltinModule("node:sea");
  const child = process.getBuiltinModule("node:child_process");
  const path = process.getBuiltinModule("node:path");
  const parsed = parseArgs(args);
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }
  let home = parsed.home;
  if (!home) {
    const proposed = defaultHome(process.env);
    home = process.stdin.isTTY ? (await ask(`Scope Soup's home folder [${proposed}]: `)) || proposed : proposed;
  }
  home = path.resolve(home);
  console.log(`Unpacking Scope Soup into ${home} ...`);
  const result = install(new Uint8Array(sea.getRawAsset(PAYLOAD_ASSET)), home);
  console.log(result.releaseWritten ? `Wrote ${path.join(home, result.folder)}` : `${result.folder} is there already and is the version that runs: left as it is.`);
  console.log(result.nodeWritten ? `Wrote Node ${result.node} to ${path.join(home, NODE_DIR)}` : `Node ${result.node} is there already.`);
  const { command, args: setupArgs } = setupHomeCommand(home, result.folder);
  const setup = child.spawnSync(command, setupArgs, { stdio: "inherit", windowsHide: true });
  if (setup.status !== 0) {
    console.error(`setup-home failed${setup.error ? `: ${setup.error.message}` : ` (exit code ${setup.status})`}.`);
    return 1;
  }
  for (const line of nextSteps(home)) console.log(line);
  return 0;
}

// Runs only as the .exe: importing this file (the build, the tests) does nothing.
if (process.getBuiltinModule("node:sea").isSea()) {
  // Started by a double click (no arguments, a console of its own): keep the window open to read what it said.
  const pause = process.argv.length <= 2 && process.stdin.isTTY;
  main(process.argv.slice(2)).then(
    (code) => code,
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    },
  ).then(async (code) => {
    if (pause) await ask("Press Enter to close.");
    process.exit(code);
  });
}
