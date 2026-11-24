import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { readPointer, writePointer } from "./home.ts";
import { apiRelease, fakeFetch, fakeReleaseFolder, fakeReleaseZip } from "./testRelease.ts";
import type { Resume, UpgraderDeps } from "./upgrader.ts";
import { CHECK_EVERY_MS, NOTE_FOR_MS, createUpgrader } from "./upgrader.ts";

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
  /** What was running when the upgrader paused (set before Get latest). */
  was: Resume;
  /** What the upgrader started again, one entry per call. */
  resumed: Resume[];
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
  let resume: string | null = null;
  let note: string | null = null;
  const was: Resume = { agents: false, mergeQueue: false };
  const resumed: Resume[] = [];
  const deps: UpgraderDeps = {
    root, version: "0.1.0", home, checkout: false, now: () => clock.now,
    releases: { fetch, repo: "owner/scopesoup", api: API },
    busy: () => busy.why,
    pause: () => {
      pauses.push(1);
      return { ...was };
    },
    resume: (what) => void resumed.push({ ...what }),
    backup: (dir) => {
      writeFileSync(join(dir, "scopesoup.sqlite"), "db");
      return [join(dir, "scopesoup.sqlite")];
    },
    restart: options.launcher === false ? null : () => void restarts.push(1),
    record: (kind, data) => void events.push({ kind, data }),
    loadCheck: () => saved,
    saveCheck: (value) => void (saved = value),
    loadResume: () => resume,
    saveResume: (value) => void (resume = value),
    loadNote: () => note,
    saveNote: (value) => void (note = value),
    setTimer: (run, ms) => timers.push({ run, ms }),
    clearTimer: () => undefined,
  };
  return { home, deps, events, timers, busy, restarts, pauses, clock, asked, was, resumed };
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

/** Get latest to 0.2.0 on 0.1.0, and the new version coming up (as the launcher would start it). */
async function upgradeAndRestart(r: Rig) {
  const upgrader = createUpgrader(r.deps);
  await upgrader.check();
  upgrader.getLatest();
  await upgrader.settled();
  assert.equal(readPointer(r.home), "scopesoup-0.2.0");
  assert.equal(r.resumed.length, 0, "nothing starts before the new version is up");
  return createUpgrader({ ...r.deps, root: join(r.home, "scopesoup-0.2.0"), version: "0.2.0" });
}

describe("agents and the merge queue after a switch", { concurrency: 2 }, () => {
  test("running before Get latest: running after the restart, and the board says so", withWork(async (work) => {
    const r = rig(work);
    r.was.agents = true;
    r.was.mergeQueue = true;
    const next = await upgradeAndRestart(r);
    assert.equal(next.view().note, null);
    next.restore();
    assert.deepEqual(r.resumed, [{ agents: true, mergeQueue: true }]);
    assert.equal(next.view().note?.text, "Upgraded to 0.2.0; agents and the merge queue started again as before");
    assert.ok(r.events.some((e) => e.kind === "scopesoup.resumed" && e.data.agents === true && e.data.mergeQueue === true));
    // Once only: a later start does not start them again.
    next.restore();
    assert.equal(r.resumed.length, 1);
    // The note goes after a while, or when dismissed.
    r.clock.now = new Date(r.clock.now.getTime() + NOTE_FOR_MS);
    assert.equal(next.view().note, null);
    r.clock.now = new Date(r.clock.now.getTime() - NOTE_FOR_MS);
    assert.ok(next.view().note);
    assert.equal(next.dismissNote().note, null);
  }));

  test("paused before Get latest: paused after", withWork(async (work) => {
    const r = rig(work);
    const next = await upgradeAndRestart(r);
    next.restore();
    assert.equal(r.resumed.length, 0);
    assert.equal(next.view().note?.text, "Upgraded to 0.2.0; agents and the merge queue were paused before and stay paused");
  }));

  test("each of the two comes back as it was", withWork(async (work) => {
    const agentsOnly = rig(join(work, "a"));
    agentsOnly.was.agents = true;
    const a = await upgradeAndRestart(agentsOnly);
    a.restore();
    assert.deepEqual(agentsOnly.resumed, [{ agents: true, mergeQueue: false }]);
    assert.match(a.view().note?.text ?? "", /; agents started again as before$/);
    const queueOnly = rig(join(work, "q"));
    queueOnly.was.mergeQueue = true;
    const q = await upgradeAndRestart(queueOnly);
    q.restore();
    assert.deepEqual(queueOnly.resumed, [{ agents: false, mergeQueue: true }]);
    assert.match(q.view().note?.text ?? "", /; the merge queue started again as before$/);
  }));

  test("Go back restores them too", withWork(async (work) => {
    const r = rig(work);
    const next = await upgradeAndRestart(r);
    next.restore();
    r.was.agents = true;
    next.goBack();
    await next.settled();
    assert.equal(readPointer(r.home), "scopesoup-0.1.0");
    const old = createUpgrader({ ...r.deps, root: join(r.home, "scopesoup-0.1.0"), version: "0.1.0" });
    old.restore();
    assert.deepEqual(r.resumed, [{ agents: true, mergeQueue: false }]);
    assert.equal(old.view().note?.text, "Went back to 0.1.0; agents started again as before");
  }));

  test("a failed switch starts them again at once; a version that did not start is named", withWork(async (work) => {
    const r = rig(work);
    r.was.agents = true;
    r.was.mergeQueue = true;
    const failing = createUpgrader({ ...r.deps, backup: () => { throw new Error("disk full"); } });
    await failing.check();
    failing.getLatest();
    await failing.settled();
    assert.equal(failing.view().task?.state, "failed");
    assert.equal(readPointer(r.home), "scopesoup-0.1.0");
    assert.deepEqual(r.resumed, [{ agents: true, mergeQueue: true }]);
    // Nothing is left for a later start.
    createUpgrader(r.deps).restore();
    assert.equal(r.resumed.length, 1);

    // The switch went through but 0.2.0 could not start and the pointer went back: 0.1.0 starts them again.
    const r2 = rig(join(work, "again"));
    r2.was.agents = true;
    await upgradeAndRestart(r2);
    const old = createUpgrader(r2.deps);
    old.restore();
    assert.deepEqual(r2.resumed, [{ agents: true, mergeQueue: false }]);
    assert.equal(old.view().note?.text, "Version 0.2.0 did not start; back on 0.1.0; agents started again as before");
  }));

  test("a remembered state from long ago is not used, and Cancel forgets it", withWork(async (work) => {
    const r = rig(work);
    r.was.agents = true;
    const next = await upgradeAndRestart(r);
    r.clock.now = new Date(r.clock.now.getTime() + 2 * 60 * 60 * 1000);
    next.restore();
    assert.equal(r.resumed.length, 0);
    assert.equal(next.view().note, null);

    const c = rig(join(work, "cancel"));
    c.was.agents = true;
    const upgrader = createUpgrader(c.deps);
    await upgrader.check();
    c.busy.why = "1 session still running";
    upgrader.getLatest();
    for (let at = 0; at < 50 && upgrader.view().task?.state !== "waiting"; at++) await new Promise((resolve) => setTimeout(resolve, 20));
    upgrader.cancel();
    c.busy.why = null;
    tickTimers(c);
    await upgrader.settled();
    upgrader.restore();
    assert.equal(c.resumed.length, 0, "Cancelled: stays paused, as the panel says");
  }));
});

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
