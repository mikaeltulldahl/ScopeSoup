// Builds the Windows .exe from a release folder (`pnpm release --exe`): a Node single executable application (SEA) whose
// program is src/exe/setup.ts and whose one asset is a pack of the release folder and a plain node.exe. The SEA is made
// with Node's own `--build-sea` (Node 25.5 or newer), so the build needs nothing but the Node that runs it; that Node is
// both the .exe's base and the runtime packed into it, never a download. Windows x64 only.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NODE_DIR, PAYLOAD_ASSET, packFiles, type PackEntry } from "./setup.ts";

const SETUP_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "setup.ts");

/** Whether `version` (`v22.18.0`) can run Scope Soup: type stripping without a flag needs 22.18 or newer. */
export function runsScopeSoup(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\./.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  return major > 22 || (major === 22 && Number(match[2]) >= 18);
}

/** The .exe's name next to the zip. */
export const exeName = (version: string): string => `scopesoup-${version}-win-x64.exe`;

/** setup.ts as the .exe's CommonJS program: types stripped, `export` keywords dropped (it imports nothing). */
export function exeProgram(source: string): string {
  if (/^\s*import\s/m.test(source)) throw new Error("src/exe/setup.ts must import nothing: the .exe runs it as one script.");
  return stripTypeScriptTypes(source, { mode: "strip" }).replace(/^export (?=const |function |async function |interface |type )/gm, "");
}

/** The release folder's files as pack entries under `<folder>/`, and `node/node.exe`. */
export function packEntries(releaseFolder: string, nodeExe: string): PackEntry[] {
  const folder = resolve(releaseFolder);
  const name = folder.slice(dirname(folder).length + 1);
  const entries: PackEntry[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else entries.push({ path: `${name}/${relative(folder, path).split(/[\\/]/).join("/")}`, bytes: readFileSync(path) });
    }
  };
  walk(folder);
  entries.push({ path: `${NODE_DIR}/node.exe`, bytes: readFileSync(nodeExe) });
  return entries;
}

export interface ExeOptions {
  /** The release folder (`release/scopesoup-<version>`). */
  releaseFolder: string;
  /** The .exe to write; default `<release folder>-win-x64.exe` beside it. */
  out?: string;
  /** The Node that is the .exe's base and the packed runtime; default the one running this. */
  node?: string;
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  arch?: string;
}

/** Why the .exe cannot be built here, or null. */
export function exeRefusal(options: Pick<ExeOptions, "nodeVersion" | "platform" | "arch">): string | null {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const version = options.nodeVersion ?? process.version;
  if (platform !== "win32" || arch !== "x64") return `The .exe is built on Windows x64 from its own Node (this is ${platform} ${arch}).`;
  if (!runsScopeSoup(version)) return `This Node is ${version}: the Node packed into the .exe must be 22.18 or newer, and is the one that runs the build.`;
  return null;
}

/** Builds the .exe. Returns its path and size. Throws with the reason. */
export function buildExe(options: ExeOptions): { exe: string; bytes: number } {
  const refusal = exeRefusal(options);
  if (refusal) throw new Error(refusal);
  const node = options.node ?? process.execPath;
  const folder = resolve(options.releaseFolder);
  const name = folder.slice(dirname(folder).length + 1);
  const version = /^scopesoup-(\d+\.\d+\.\d+)$/.exec(name)?.[1];
  if (!version) throw new Error(`${folder} is not a release folder named scopesoup-<version>.`);
  const exe = resolve(options.out ?? join(dirname(folder), exeName(version)));
  const work = join(dirname(exe), `.exe-build-${process.pid}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    writeFileSync(join(work, "setup.cjs"), exeProgram(readFileSync(SETUP_SOURCE, "utf8")));
    writeFileSync(join(work, "payload.bin"), packFiles({ version, folder: name, node: options.nodeVersion ?? process.version }, packEntries(folder, node)));
    rmSync(exe, { force: true });
    const config = { main: "setup.cjs", output: exe, executable: node, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, assets: { [PAYLOAD_ASSET]: "payload.bin" } };
    writeFileSync(join(work, "sea-config.json"), JSON.stringify(config, null, 2));
    const built = spawnSync(node, ["--build-sea", "sea-config.json"], { cwd: work, encoding: "utf8", windowsHide: true });
    if (built.status !== 0) {
      const said = `${built.stderr ?? ""}${built.stdout ?? ""}`.trim() || built.error?.message || `exit code ${built.status}`;
      throw new Error(`node --build-sea failed (it needs Node 25.5 or newer): ${said}`);
    }
    return { exe, bytes: statSync(exe).size };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
