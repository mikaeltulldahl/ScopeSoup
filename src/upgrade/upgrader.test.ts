import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { readPointer, writePointer } from "./home.ts";
import { apiRelease, fakeFetch, fakeReleaseFolder, fakeReleaseZip } from "./testRelease.ts";
import type { UpgraderDeps } from "./upgrader.ts";
import { CHECK_EVERY_MS, createUpgrader } from "./upgrader.ts";

const API = "https://api.example";
const LATEST = `${API}/repos/owner/scopesoup/releases/latest`;

interface Rig {
  home: string;
  deps: UpgraderDeps;
  events: { kind: string; data: Record<string, unknown> }[];
  timers: { run: () => void; ms: number }[];
  busy: { why: string | null };
  restarts: number[];
  pauses: number[];
  clock: { now: Date };
  asked: { url: string }[];
}

function rig(work: string, options: { digest?: "right" | "wrong" | "none"; launcher?: boolean } = {}): Rig {
  const home = join(work, "home");
  const root = fakeReleaseFolder(home, "0.1.0");
  writePointer(home, "scopesoup-0.1.0");
  const { bytes, sha } = fakeReleaseZip(work, "0.2.0");
  const digest = options.digest === "wrong" ? "00".repeat(32) : options.digest === "none" ? undefined : sha;
  const asked: { url: string; headers: Record<string, string> }[] = [];
  const fetch = fakeFetch({
    [LATEST]: () => Response.json(apiRelease("0.2.0", `${API}/assets/7`, bytes.length, digest)),
    [`${API}/assets/7`]: () => new Response(bytes),
  }, asked);
  const events: Rig["events"] = [];
  const timers: Rig["timers"] = [];
  const busy = { why: null as string | null };
  const restarts: number[] = [];
  const pauses: number[] = [];
  const clock = { now: new Date("2026-11-20T10:00:00Z") };
  let saved: string | null = null;
  const deps: UpgraderDeps = {
    root, version: "0.1.0", home, checkout: false, now: () => clock.now,
    releases: { fetch, repo: "owner/scopesoup", api: API },
    busy: () => busy.why,
    pause: () => void pauses.push(1),
    backup: (dir) => {
      writeFileSync(join(dir, "scopesoup.sqlite"), "db");
      return [join(dir, "scopesoup.sqlite")];
    },
    restart: options.launcher === false ? null : () => void restarts.push(1),
    record: (kind, data) => void events.push({ kind, data }),
    loadCheck: () => saved,
    saveCheck: (value) => void (saved = value),
    setTimer: (run, ms) => timers.push({ run, ms }),
    clearTimer: () => undefined,
  };
  return { home, deps, events, timers, busy, restarts, pauses, clock, asked };
}

function withWork(run: (work: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const work = mkdtempSync(join(tmpdir(), "scopesoup-upgrader-"));
    try {
      await run(work);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  };
}

/** Runs the timers that are due (the wait for idle), as the clock would. */
function tickTimers(r: Rig): void {
  const due = r.timers.splice(0);
  for (const timer of due) timer.run();
}

describe("Get latest and Go back", { concurrency: 2 }, () => {
  test("the check shows the newer release; nothing happens until Get latest", withWork(async (work) => {
    const r = rig(work);
    const upgrader = createUpgrader(r.deps);
    assert.equal(upgrader.view().available, false);
    const view = await upgrader.check();
    assert.equal(view.available, true);
    assert.equal(view.latest?.version, "0.2.0");
    assert.equal(view.getLatest.can, true);
    assert.equal(readPointer(r.home), "scopesoup-0.1.0");
    assert.ok(r.events.some((e) => e.kind === "scopesoup.update_checked" && e.data.available === "0.2.0"));
  }));

  test("downloads, checks, unpacks, waits for idle, backs up, switches and restarts; then Go back", withWork(async (work) => {
    const r = rig(work);
    const upgrader = createUpgrader(r.deps);
    await upgrader.check();
    r.busy.why = "1 session still running";
    assert.equal(upgrader.getLatest().task?.state, "downloading");
    // Unpacked, paused, and waiting while a session runs: the pointer has not moved.
    for (let at = 0; at < 50 && upgrader.view().task?.state !== "waiting"; at++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(upgrader.view().task?.state, "waiting");
    assert.match(upgrader.view().task?.text ?? "", /1 session still running/);
    assert.equal(r.pauses.length, 1);
    assert.ok(existsSync(join(r.home, "scopesoup-0.2.0", "src", "main.ts")));
    assert.equal(readPointer(r.home), "scopesoup-0.1.0");
    tickTimers(r);
    assert.equal(readPointer(r.home), "scopesoup-0.1.0", "still busy");
    r.busy.why = null;
    tickTimers(r);
    await upgrader.settled();
    assert.equal(readPointer(r.home), "scopesoup-0.2.0");
    assert.equal(r.restarts.length, 1);
    assert.equal(upgrader.view().task?.state, "restarting");
    assert.equal(readFileSync(join(r.home, "backups", "before-scopesoup-0.2.0", "scopesoup.sqlite"), "utf8"), "db");
    assert.ok(r.events.some((e) => e.kind === "scopesoup.upgraded" && e.data.to === "scopesoup-0.2.0"));
    assert.ok(!existsSync(join(r.home, "downloads", "scopesoup-0.2.0.zip")), "the download is not kept");

    // The new version (as the launcher would start it) offers Go back to 0.1.0.
    const next = createUpgrader({ ...r.deps, root: join(r.home, "scopesoup-0.2.0"), version: "0.2.0" });
    next.start();
    const back = next.view().back;
    assert.deepEqual(back, { version: "0.1.0", newer: false, can: true });
    next.goBack();
    await next.settled();
    assert.equal(readPointer(r.home), "scopesoup-0.1.0");
    assert.equal(r.restarts.length, 2);
    assert.ok(r.events.some((e) => e.kind === "scopesoup.went_back"));
    next.stop();
  }));

  test("a zip whose hash is not the release's is not unpacked and nothing switches", withWork(async (work) => {
    const r = rig(work, { digest: "wrong" });
    const upgrader = createUpgrader(r.deps);
    await upgrader.check();
    upgrader.getLatest();
    await upgrader.settled();
    assert.equal(upgrader.view().task?.state, "failed");
    assert.match(upgrader.view().task?.text ?? "", /SHA-256/);
    assert.ok(!existsSync(join(r.home, "scopesoup-0.2.0")));
    assert.equal(readPointer(r.home), "scopesoup-0.1.0");
    assert.equal(r.pauses.length, 0, "nothing paused for a bad download");
  }));

  test("without the launcher the pointer is switched and the person restarts", withWork(async (work) => {
    const r = rig(work, { launcher: false, digest: "none" });
    const upgrader = createUpgrader(r.deps);
    await upgrader.check();
    upgrader.getLatest();
    await upgrader.settled();
    assert.equal(readPointer(r.home), "scopesoup-0.2.0");
    assert.equal(upgrader.view().task?.state, "done");
    assert.match(upgrader.view().task?.text ?? "", /scopesoup start/);
  }));

  test("Cancel stops the wait; the pointer stays", withWork(async (work) => {
    const r = rig(work);
    const upgrader = createUpgrader(r.deps);
    await upgrader.check();
    r.busy.why = "1 queue batch still running";
    upgrader.getLatest();
    for (let at = 0; at < 50 && upgrader.view().task?.state !== "waiting"; at++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(upgrader.cancel().task?.state, "failed");
    r.busy.why = null;
    tickTimers(r);
    await upgrader.settled();
    assert.equal(readPointer(r.home), "scopesoup-0.1.0");
    assert.equal(r.restarts.length, 0);
  }));

  test("a checkout has no Get latest, and the check runs once a day", withWork(async (work) => {
    const r = rig(work);
    const upgrader = createUpgrader({ ...r.deps, checkout: true });
    upgrader.start();
    await upgrader.settled();
    assert.equal(r.asked.length, 1, "checked at start");
    const view = upgrader.view();
    assert.equal(view.available, true);
    assert.equal(view.getLatest.can, false);
    assert.match(view.getLatest.why ?? "", /development checkout/);
    // The hourly look does not ask again within the day, and does after it.
    r.timers.at(-1)!.run();
    await upgrader.settled();
    assert.equal(r.asked.length, 1);
    r.clock.now = new Date(r.clock.now.getTime() + CHECK_EVERY_MS);
    r.timers.at(-1)!.run();
    await upgrader.settled();
    assert.equal(r.asked.length, 2);
    upgrader.stop();
  }));
});
