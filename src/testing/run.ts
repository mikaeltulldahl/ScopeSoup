// Runs the tests: `node src/testing/run.ts fast|slow|all [--long]`.
//
// - fast: every `*.test.ts` except the slow ones (`pnpm test`, for use while working).
// - slow: the `*.slow.test.ts` files, the integration tests that start many git processes (`pnpm test:slow`).
// - all: both, in one run (what `pnpm check` runs, so nothing is left out).
// - --long: the full counts of the random-input tests (they run fewer, with the same seeds, by default).
//
// The files are listed here and handed to `node --test`, so the same list works in every shell. The
// number of test files that run at once is `SCOPESOUP_TEST_JOBS` (a positive integer) or, without it,
// a quarter of the logical processors, at least 1. One per processor was the fastest (the time is
// spent in git processes, and on Windows starting a process costs processor time), but it pinned
// the whole machine. The number used is printed on the first line, so a slow run can be explained.

import { readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { spawnSyncRetrying } from "../hosts/spawnRetry.ts";

const kind = process.argv[2] ?? "fast";
if (!["fast", "slow", "all"].includes(kind)) {
  console.error("usage: node src/testing/run.ts fast|slow|all [--long]");
  process.exit(2);
}

function testFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...testFiles(path));
    else if (entry.name.endsWith(".test.ts")) found.push(path);
  }
  return found;
}

function testJobs(): number {
  const raw = process.env.SCOPESOUP_TEST_JOBS;
  if (raw === undefined || raw === "") return Math.max(1, Math.floor(availableParallelism() / 4));
  if (!/^[1-9][0-9]*$/.test(raw.trim())) {
    console.error(`SCOPESOUP_TEST_JOBS must be a positive integer (how many test files run at once), not "${raw}"`);
    process.exit(2);
  }
  return Number(raw.trim());
}
const jobs = testJobs();

const slow = (file: string): boolean => file.endsWith(".slow.test.ts");
const files = testFiles("src")
  .filter((file) => (kind === "all" ? true : kind === "slow" ? slow(file) : !slow(file)))
  .sort();

const why = process.env.SCOPESOUP_TEST_JOBS ? "from SCOPESOUP_TEST_JOBS" : `a quarter of ${availableParallelism()} logical processors; SCOPESOUP_TEST_JOBS sets it`;
console.log(`${files.length} test files, ${jobs} at once (${why})`);
const result = spawnSyncRetrying(
  process.execPath,
  ["--disable-warning=ExperimentalWarning", "--test", `--test-concurrency=${jobs}`, "--test-reporter=./src/testing/reporter.ts", ...files],
  { stdio: "inherit", env: { ...process.env, ...(process.argv.includes("--long") ? { SCOPESOUP_LONG: "1" } : {}) } },
);
process.exit(result.status ?? 1);
