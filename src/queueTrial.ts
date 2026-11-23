// Seeds the stand-in (src/standin.ts) for a trial of merging through the merge queue, with
// no agent session at all: the items are created on the meta ref with the log lines a finished
// item has (a revision and a passing review), and their branches are committed here by hand in the
// pool's clones. Scope Soup, started on the stand-in, rebuilds each item's job from the log, finds
// the branch by its head, and hands the change to the queue. The level is 4 (Autopilot), so the queue
// runs, but the agent's program path names no program: the fix round of a change that is sent back fails to
// start, and no session is ever started. (Before levels, a dry run did this.)
//
//   pnpm queue-trial setup <empty folder>    builds the stand-in and seeds round 1: A-1, A-2, A-3 (bad), A-4
//   pnpm queue-trial flaky <folder>          seeds round 2: A-5 (its test fails once, then passes) and A-6
//
// Everything is synthetic.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createConfigLoader } from "./config/loader.ts";
import { createHosts, hostSettings } from "./hostSetup.ts";
import { SCOPESOUP } from "./orchestrator/hostActions.ts";
import { buildStandin, STANDIN } from "./standin.ts";
import { execFileSyncRetrying } from "./hosts/spawnRetry.ts";

export const TRIAL_PORT = 4340;
const SUBDIR = STANDIN.subdir;

function git(cwd: string, ...args: string[]): string {
  return execFileSyncRetrying("git", ["-c", `user.name=${STANDIN.author.name}`, "-c", `user.email=${STANDIN.author.email}`, "-c", "core.autocrlf=false", ...args], { cwd, stdio: "pipe", encoding: "utf8" }).trim();
}

interface Seed {
  id: string;
  title: string;
  /** Which clone of the pool holds the branch. */
  clone: 0 | 1;
  files: Record<string, string>;
}

const ESM_TEST = (name: string, module: string, body: string): string =>
  `import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport * as m from "../src/${module}.js";\n\ntest("${name}", () => {\n${body}\n});\n`;

const ROUND_1: Seed[] = [
  { id: "A-1", title: "Add an area helper", clone: 0, files: {
    "src/area.js": "/** Area of a square in square metres. */\nexport const square = (side) => side * side;\n",
    "test/area.test.js": ESM_TEST("square area", "area", "  assert.equal(m.square(3), 9);"),
  } },
  { id: "A-2", title: "Add a volume helper", clone: 0, files: {
    "src/volume.js": "/** Volume of a cube in cubic metres. */\nexport const cube = (side) => side ** 3;\n",
    "test/volume.test.js": ESM_TEST("cube volume", "volume", "  assert.equal(m.cube(2), 8);"),
  } },
  // The bad one: it changes the length of a kilometre and brings a test of its own that passes.
  { id: "A-3", title: "Make kilometres round", clone: 1, files: {
    "src/units.js": readUnits().replace("km: 1000", "km: 100"),
    "test/rounding.test.js": ESM_TEST("rounds", "area", "  assert.equal(m.square(1), 1);"),
  } },
  { id: "A-4", title: "Add a mass helper", clone: 1, files: {
    "src/mass.js": "/** Kilograms in a tonne. */\nexport const tonnes = (kg) => kg / 1000;\n",
    "test/mass.test.js": ESM_TEST("tonnes", "mass", "  assert.equal(m.tonnes(2000), 2);"),
  } },
];

function readUnits(): string {
  return [
    "// Lengths, in metres per unit.",
    "const METRES = { mm: 0.001, cm: 0.01, m: 1, km: 1000 };",
    "",
    "/** The units this library knows. */",
    "export function units() {",
    "  return Object.keys(METRES);",
    "}",
    "",
    "/** Converts `value` from one unit to another, for example convert(1500, \"m\", \"km\") is 1.5. */",
    "export function convert(value, from, to) {",
    "  if (!(from in METRES)) throw new Error(`unknown unit: ${from}`);",
    "  if (!(to in METRES)) throw new Error(`unknown unit: ${to}`);",
    "  return (value * METRES[from]) / METRES[to];",
    "}",
    "",
  ].join("\n");
}

function round2(marker: string): Seed[] {
  const flaky = `import assert from "node:assert/strict";\nimport { existsSync, writeFileSync } from "node:fs";\nimport { test } from "node:test";\n\n// Fails the first time it runs anywhere, then passes: the marker lives outside the repository.\ntest("flaky once", () => {\n  const marker = ${JSON.stringify(marker)};\n  const first = !existsSync(marker);\n  if (first) writeFileSync(marker, "1");\n  assert.ok(!first, "first run fails");\n});\n`;
  return [
    { id: "A-5", title: "Add a speed helper", clone: 0, files: {
      "src/speed.js": "/** Kilometres per hour from metres per second. */\nexport const kmh = (ms) => ms * 3.6;\n",
      "test/speed.test.js": ESM_TEST("kmh", "speed", "  assert.equal(m.kmh(10), 36);"),
      "test/flaky.test.js": flaky,
    } },
    { id: "A-6", title: "Add a time helper", clone: 1, files: {
      "src/time.js": "/** Seconds in a number of minutes. */\nexport const seconds = (min) => min * 60;\n",
      "test/time.test.js": ESM_TEST("seconds", "time", "  assert.equal(m.seconds(2), 120);"),
    } },
  ];
}

async function seed(folder: string, items: Seed[]): Promise<void> {
  const configFile = join(folder, "scopesoup.config.json");
  const loaded = createConfigLoader(configFile).load();
  if (!loaded.config) throw new Error(loaded.error ?? "no configuration");
  const config = loaded.config;
  if (config.workspaces.kind !== "pool") throw new Error("the stand-in has a pool");
  const [host] = createHosts(hostSettings(config, {}, (path) => resolve(path)), {}, () => {});
  if (!host?.write?.createWork || !host.write.appendLog) throw new Error("the meta host cannot be written");
  const pool = config.workspaces.paths;
  try {
    for (const each of items) {
      const created = await host.write.createWork({ title: each.title, body: `${each.title} (synthetic trial item).`, state: "doing" });
      const ref = created.work;
      const branch = `scopesoup/${ref.id}`;
      const repo = join(pool[each.clone]!, SUBDIR);
      git(repo, "fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main");
      git(repo, "checkout", "-q", "-B", branch, "origin/main");
      for (const [name, text] of Object.entries(each.files)) {
        mkdirSync(dirname(join(repo, name)), { recursive: true });
        writeFileSync(join(repo, name), text);
      }
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", each.title);
      const sha = git(repo, "rev-parse", "HEAD");
      git(repo, "checkout", "-q", "--detach");
      // What a finished item's log says: a revision, and a passing review of that very revision.
      await host.write.appendLog(ref, { kind: "revision", by: SCOPESOUP, fields: { sha, branch } });
      await host.write.appendLog(ref, { kind: "review", by: SCOPESOUP, fields: { sha, verdict: "pass", findings: [] } });
      console.log(`${ref.id}: ${each.title} on ${branch} at ${sha.slice(0, 7)} in clone ${each.clone + 1} (item ${created.work.id}, ${created.shared})`);
    }
  } finally {
    await host.stop?.();
  }
}

function queueOnly(folder: string): void {
  const file = join(folder, "scopesoup.config.json");
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  raw.claude = { path: "no-claude-in-the-queue-trial" };
  // The queue's check: the project's own tests.
  writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
}

async function main(): Promise<void> {
  const [mode, given] = process.argv.slice(2);
  if (!mode || !given) {
    console.error("Usage: pnpm queue-trial setup <empty folder> | pnpm queue-trial flaky <folder>");
    process.exitCode = 2;
    return;
  }
  const folder = resolve(process.env.INIT_CWD ?? process.cwd(), given);
  if (mode === "setup") {
    await buildStandin(folder);
    queueOnly(folder);
    await seed(folder, ROUND_1);
  } else if (mode === "flaky") {
    await seed(folder, round2(join(tmpdir(), `scopesoup-queue-trial-flaky-${Date.now()}.marker`)));
  } else {
    console.error(`Unknown mode ${mode}.`);
    process.exitCode = 2;
    return;
  }
  const data = join(folder, "data");
  console.log("");
  console.log(`Start Scope Soup (Git Bash): SCOPESOUP_CONFIG="${join(folder, "scopesoup.config.json")}" SCOPESOUP_DATA="${data}" SCOPESOUP_PORT=${TRIAL_PORT} pnpm start`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
