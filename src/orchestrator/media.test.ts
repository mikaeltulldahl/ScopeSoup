// Agents' images taken from a session's clone into the data folder, pushed to refs/scopesoup/media/<key> only with media.push,
// served back, deleted (here and on the remote) and expired; links never followed; failed remote updates tried again. In
// synthetic repositories under the temporary folder.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { MediaConfig } from "../config/types.ts";
import { MAX_MEDIA_BYTES, MEDIA_FOLDER, mediaKey, mediaRef } from "../core/media.ts";
import { work } from "../core/testing.ts";
import type { Ref } from "../model/types.ts";
import { refKey } from "../model/types.ts";
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
  const folderOf = (subject: Ref) => join(root, "data", "media", mediaKey(refKey(subject)));
  const save = (name: string, bytes: Buffer = PNG) => writeFileSync(join(session, MEDIA_FOLDER, name), bytes);
  const reason = (kind: string) => String((store.eventsOfKinds([kind], 1)[0]?.data as { reason?: string } | undefined)?.reason);
  return { root, remote, clone, session, store, config, configFile, media: handle, folderOf, save, reason, done: () => (store.close(), rmSync(root, { recursive: true, force: true })) };
}

const item = work(7);
const REF = mediaRef(refKey(item.ref));

/** A link where the OS lets this account make one (a file link on Windows may need developer mode); false when it does not. */
function link(target: string, path: string, type: "file" | "junction"): boolean {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch {
    return false;
  }
}

describe("media on disk and in git", { concurrency: 2 }, () => {
  it("keeps the session's images here only while media.push is off; git ignores the folder", async () => {
    const t = setUp({ push: false, keepDaysAfterClose: null });
    try {
      t.media.prepare(t.session);
      const folder = join(t.session, MEDIA_FOLDER);
      t.save("shot.png");
      t.save("page.png", Buffer.from("<html><script>alert(1)</script>"));
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
      assert.match(t.reason("media.collected"), /refused: page\.png/);
    } finally {
      t.done();
    }
  });

  it("Item 7 on two hosts keeps two folders and two refs", async () => {
    const t = setUp({ push: true, keepDaysAfterClose: null });
    try {
      const other: Ref = { host: "other", kind: "work", id: "7" };
      t.media.prepare(t.session);
      t.save("a.png");
      t.media.collect(item.ref, t.session);
      t.media.prepare(t.session);
      t.save("b.png");
      t.media.collect(other, t.session);
      await t.media.idle();
      assert.deepEqual(await t.media.list(item.ref), ["a.png"]);
      assert.deepEqual(await t.media.list(other), ["b.png"]);
      assert.notEqual(t.folderOf(item.ref), t.folderOf(other));
      assert.equal(git(t.remote, "ls-tree", "--name-only", REF), "a.png");
      assert.equal(git(t.remote, "ls-tree", "--name-only", mediaRef(refKey(other))), "b.png");
    } finally {
      t.done();
    }
  });

  it("never follows a link: a linked entry is refused and its target kept; a linked media folder is left alone", async () => {
    const t = setUp({ push: false, keepDaysAfterClose: null });
    try {
      const elsewhere = join(t.root, "elsewhere");
      mkdirSync(elsewhere);
      writeFileSync(join(elsewhere, "private.png"), PNG);
      // The media folder itself a junction to a folder elsewhere (no admin rights needed on Windows).
      mkdirSync(join(t.session, ".scopesoup"));
      assert.ok(link(elsewhere, join(t.session, MEDIA_FOLDER), "junction"));
      t.media.prepare(t.session);
      assert.equal(t.media.collect(item.ref, t.session), null);
      assert.deepEqual(readdirSync(elsewhere), ["private.png"]);
      assert.match(t.reason("media.collect_refused"), /is a link/);
      assert.deepEqual(await t.media.list(item.ref), []);

      // A link inside a real media folder: refused, the link goes, the file it points at stays.
      rmSync(join(t.session, MEDIA_FOLDER), { recursive: false, force: true });
      t.media.prepare(t.session);
      const folder = join(t.session, MEDIA_FOLDER);
      const made = [link(elsewhere, join(folder, "dir.png"), "junction"), link(join(elsewhere, "private.png"), join(folder, "file.png"), "file")];
      t.save("real.png");
      const plan = t.media.collect(item.ref, t.session);
      assert.deepEqual(plan?.keep.map((each) => each.name), ["real.png"]);
      assert.deepEqual(plan?.refused.map((each) => each.name), ["dir.png", ...(made[1] ? ["file.png"] : [])]);
      assert.deepEqual(readdirSync(folder), [".gitignore"]);
      assert.deepEqual(readdirSync(elsewhere), ["private.png"]);

      // A link put into the data folder is not served.
      if (link(join(elsewhere, "private.png"), join(t.folderOf(item.ref), "linked.png"), "file")) assert.equal(await t.media.read(item.ref, "linked.png"), null);
      assert.ok((await t.media.read(item.ref, "real.png"))?.bytes.equals(PNG));
    } finally {
      t.done();
    }
  });

  it("prepare empties what a killed session left", () => {
    const t = setUp({ push: false, keepDaysAfterClose: null });
    try {
      t.media.prepare(t.session);
      t.save("left.png");
      mkdirSync(join(t.session, MEDIA_FOLDER, "sub"));
      t.media.prepare(t.session);
      assert.deepEqual(readdirSync(join(t.session, MEDIA_FOLDER)), [".gitignore"]);
    } finally {
      t.done();
    }
  });

  it("with media.push on: commits to the media ref, pushes it, records it, and a delete takes it off the remote", async () => {
    const t = setUp({ push: true, keepDaysAfterClose: null });
    try {
      t.media.prepare(t.session);
      t.save("before.png");
      t.save("after.png");
      t.media.collect(item.ref, t.session);
      await t.media.idle();
      assert.match(git(t.remote, "ls-tree", "--name-only", REF), /after\.png\nbefore\.png/);
      assert.match(readFileSync(join(t.root, "scopesoup.manifest.jsonl"), "utf8"), new RegExp(`"ref":"${REF}"`));
      // Read from the ref when the data folder lost it (another machine's board has only the ref).
      rmSync(join(t.folderOf(item.ref), "after.png"));
      assert.ok((await t.media.read(item.ref, "after.png"))?.bytes.equals(PNG));
      const one = await t.media.remove(item.ref, "after.png", "mira");
      assert.equal(one.ref, "updated");
      assert.equal(git(t.remote, "ls-tree", "--name-only", REF), "before.png");
      assert.match(t.reason("media.deleted"), /mira deleted the image after\.png, also from refs\/scopesoup\/media\//);
      const last = await t.media.remove(item.ref, "before.png", "mira");
      assert.equal(last.removed, true);
      assert.equal(git(t.remote, "for-each-ref", "refs/scopesoup"), "");
      assert.deepEqual(await t.media.list(item.ref), []);
    } finally {
      t.done();
    }
  });

  it("a push that failed goes once the remote can be reached; a delete that failed says so and goes later", async () => {
    const t = setUp({ push: true, keepDaysAfterClose: null });
    try {
      git(t.clone, "remote", "set-url", "origin", join(t.root, "missing.git"));
      t.media.prepare(t.session);
      t.save("a.png");
      t.save("b.png");
      t.media.collect(item.ref, t.session);
      await t.media.idle();
      assert.match(t.reason("media.push_failed"), /could not be pushed/);
      git(t.clone, "remote", "set-url", "origin", t.remote);
      await t.media.retry();
      assert.match(git(t.remote, "ls-tree", "--name-only", REF), /a\.png\nb\.png/);

      git(t.clone, "remote", "set-url", "origin", join(t.root, "missing.git"));
      const failed = await t.media.remove(item.ref, "a.png", "mira");
      assert.equal(failed.ref, "failed");
      assert.deepEqual(await t.media.list(item.ref), ["b.png"]);
      git(t.clone, "remote", "set-url", "origin", t.remote);
      await t.media.retry();
      assert.equal(git(t.remote, "ls-tree", "--name-only", REF), "b.png");
    } finally {
      t.done();
    }
  });

  it("with sharing switched off since: nothing new is pushed, and a delete still shrinks the remote's ref", async () => {
    const t = setUp({ push: true, keepDaysAfterClose: null });
    try {
      t.media.prepare(t.session);
      t.save("a.png");
      t.save("b.png");
      t.media.collect(item.ref, t.session);
      await t.media.idle();
      t.config.media = { push: false, keepDaysAfterClose: null };
      t.media.prepare(t.session);
      t.save("c.png");
      t.media.collect(item.ref, t.session);
      await t.media.idle();
      await t.media.remove(item.ref, "a.png", "mira");
      assert.equal(git(t.remote, "ls-tree", "--name-only", REF), "b.png");
      assert.deepEqual(await t.media.list(item.ref), ["b.png", "c.png"]);
    } finally {
      t.done();
    }
  });

  it("the setting is read when the push runs, not when the session ended", async () => {
    const t = setUp({ push: true, keepDaysAfterClose: null });
    try {
      t.media.prepare(t.session);
      t.save("a.png");
      t.media.collect(item.ref, t.session);
      t.config.media = { push: false, keepDaysAfterClose: null };
      await t.media.idle();
      assert.equal(git(t.clone, "for-each-ref", "refs/scopesoup"), "");
      assert.equal(git(t.remote, "for-each-ref", "refs/scopesoup"), "");
    } finally {
      t.done();
    }
  });

  it("a blob on the ref larger than an image may be is not read", async () => {
    const t = setUp({ push: false, keepDaysAfterClose: null });
    try {
      const big = join(t.root, "big.png");
      writeFileSync(big, Buffer.concat([PNG, Buffer.alloc(MAX_MEDIA_BYTES)]));
      const blob = git(t.clone, "hash-object", "-w", big);
      const tree = execFileSync("git", ["mktree"], { cwd: t.clone, input: `100644 blob ${blob}\tbig.png\n`, encoding: "utf8" }).trim();
      const commit = execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit-tree", tree, "-m", "x"], { cwd: t.clone, encoding: "utf8" }).trim();
      git(t.clone, "update-ref", REF, commit);
      assert.deepEqual(await t.media.list(item.ref), ["big.png"]);
      assert.equal(await t.media.read(item.ref, "big.png"), null);
    } finally {
      t.done();
    }
  });

  it("deletes a closed Item's images media.keepDaysAfterClose days after it closed, not before", async () => {
    const t = setUp({ push: true, keepDaysAfterClose: 30 });
    try {
      t.media.prepare(t.session);
      t.save("shot.png");
      t.media.collect(item.ref, t.session);
      await t.media.idle();
      await t.media.expire([{ ...item, state: "done", updatedAt: "2026-11-20T00:00:00.000Z" }]);
      assert.deepEqual(await t.media.list(item.ref), ["shot.png"]);
      t.store.setValue("media.closed:demo:work:7", "2026-10-01T00:00:00.000Z");
      await t.media.expire([{ ...item, state: "done", updatedAt: "2026-11-20T00:00:00.000Z" }]);
      assert.deepEqual(await t.media.list(item.ref), []);
      assert.equal(existsSync(t.folderOf(item.ref)), false);
      assert.equal(git(t.remote, "for-each-ref", "refs/scopesoup"), "");
    } finally {
      t.done();
    }
  });
});
