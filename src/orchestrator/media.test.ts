// Agents' images taken from a session's clone into the data folder, pushed to refs/scopesoup/media/<id> only with media.push,
// served back, deleted (here and on the remote) and expired. In synthetic repositories under the temporary folder.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { MediaConfig } from "../config/types.ts";
import { MEDIA_FOLDER } from "../core/media.ts";
import { work } from "../core/testing.ts";
import { openStore } from "../store/store.ts";
import { createMedia } from "./media.ts";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a3d5b0b70000000049454e44ae426082", "hex");
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();

function setUp(media: MediaConfig) {
  const root = mkdtempSync(join(tmpdir(), "soup-media-"));
  const remote = join(root, "remote.git");
  const clone = join(root, "clone");
  const session = join(root, "session");
  mkdirSync(remote);
  git(remote, "init", "-q", "--bare");
  mkdirSync(clone);
  git(clone, "init", "-q");
  git(clone, "remote", "add", "origin", remote);
  mkdirSync(session);
  git(session, "init", "-q");
  const store = openStore(":memory:");
  const config = { repoPath: clone, remote: "origin", media };
  const configFile = join(root, "scopesoup.config.json");
  writeFileSync(configFile, "{}");
  const handle = createMedia({ dataDir: join(root, "data"), store, config: () => config, configFile, now: () => "2026-11-25T10:00:00.000Z" });
  return { root, remote, clone, session, store, config, configFile, media: handle, done: () => (store.close(), rmSync(root, { recursive: true, force: true })) };
}

const item = work(7);

describe("media on disk and in git", { concurrency: 2 }, () => {
  it("keeps the session's images here only while media.push is off; git ignores the folder", async () => {
    const t = setUp({ push: false, keepDaysAfterClose: null });
    try {
      t.media.prepare(t.session);
      const folder = join(t.session, MEDIA_FOLDER);
      writeFileSync(join(folder, "shot.png"), PNG);
      writeFileSync(join(folder, "page.png"), "<html><script>alert(1)</script>");
      assert.equal(git(t.session, "status", "--porcelain", "--untracked-files=all"), "");
      const plan = t.media.collect(item.ref, t.session);
      assert.deepEqual(plan?.keep.map((each) => each.name), ["shot.png"]);
      assert.deepEqual(plan?.refused.map((each) => each.name), ["page.png"]);
      // The clone's folder is empty again (but for its .gitignore) for the next session.
      assert.deepEqual(readdirSync(folder), [".gitignore"]);
      await t.media.idle();
      assert.deepEqual(await t.media.list(item.ref), ["shot.png"]);
      const read = await t.media.read(item.ref, "shot.png");
      assert.equal(read?.type, "image/png");
      assert.ok(read?.bytes.equals(PNG));
      assert.equal(await t.media.read(item.ref, "../shot.png"), null);
      assert.equal(git(t.remote, "for-each-ref", "refs/scopesoup"), "");
      assert.equal(git(t.clone, "for-each-ref", "refs/scopesoup"), "");
      const collected = t.store.eventsOfKinds(["media.collected"], 5)[0];
      assert.equal(collected?.subject, "demo:work:7");
      assert.match(String((collected?.data as { reason?: string }).reason), /refused: page\.png/);
    } finally {
      t.done();
    }
  });

  it("with media.push on: commits to the media ref, pushes it, records it, and a delete takes it off the remote", async () => {
    const t = setUp({ push: true, keepDaysAfterClose: null });
    try {
      t.media.prepare(t.session);
      writeFileSync(join(t.session, MEDIA_FOLDER, "before.png"), PNG);
      writeFileSync(join(t.session, MEDIA_FOLDER, "after.png"), PNG);
      t.media.collect(item.ref, t.session);
      await t.media.idle();
      const ref = "refs/scopesoup/media/7";
      assert.match(git(t.remote, "ls-tree", "--name-only", ref), /after\.png\nbefore\.png/);
      assert.match(readFileSync(join(t.root, "scopesoup.manifest.jsonl"), "utf8"), /"ref":"refs\/scopesoup\/media\/7"/);
      // Read from the ref when the data folder lost it (another machine's board has only the ref).
      rmSync(join(t.root, "data", "media", "7", "after.png"));
      assert.ok((await t.media.read(item.ref, "after.png"))?.bytes.equals(PNG));
      const one = await t.media.remove(item.ref, "after.png", "mira");
      assert.equal(one.ref, "updated");
      assert.equal(git(t.remote, "ls-tree", "--name-only", ref), "before.png");
      assert.match(String((t.store.eventsOfKinds(["media.deleted"], 1)[0]?.data as { reason?: string }).reason), /mira deleted the image after\.png, also from refs\/scopesoup\/media\/7/);
      const last = await t.media.remove(item.ref, "before.png", "mira");
      assert.equal(last.removed, true);
      assert.equal(git(t.remote, "for-each-ref", "refs/scopesoup"), "");
      assert.deepEqual(await t.media.list(item.ref), []);
    } finally {
      t.done();
    }
  });

  it("deletes a closed Item's images media.keepDaysAfterClose days after it closed, not before", async () => {
    const t = setUp({ push: true, keepDaysAfterClose: 30 });
    try {
      t.media.prepare(t.session);
      writeFileSync(join(t.session, MEDIA_FOLDER, "shot.png"), PNG);
      t.media.collect(item.ref, t.session);
      await t.media.idle();
      await t.media.expire([{ ...item, state: "done", updatedAt: "2026-11-20T00:00:00.000Z" }]);
      assert.deepEqual(await t.media.list(item.ref), ["shot.png"]);
      t.store.setValue("media.closed:demo:work:7", "2026-10-01T00:00:00.000Z");
      await t.media.expire([{ ...item, state: "done", updatedAt: "2026-11-20T00:00:00.000Z" }]);
      assert.deepEqual(await t.media.list(item.ref), []);
      assert.equal(existsSync(join(t.root, "data", "media", "7")), false);
      assert.equal(git(t.remote, "for-each-ref", "refs/scopesoup"), "");
    } finally {
      t.done();
    }
  });
});
