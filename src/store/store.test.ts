import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ScopeSoupEvent, WorkItem } from "../model/types.ts";
import { CURRENT_SCHEMA, SCHEMA_1, STORE_VERSION } from "./schema.ts";
import type { Schema } from "./schema.ts";
import { openStore, storeCopyPath } from "./store.ts";
import type { Store } from "./store.ts";

const T0 = "2026-01-01T00:00:00Z";

function item(id: string, title: string): WorkItem {
  return {
    ref: { host: "fake", kind: "work", id },
    title,
    state: "todo",
    hostState: "open",
    labels: [],
    blockedBy: [],
    openChildren: 0,
    updatedAt: T0,
  };
}

test("put writes an event only when the object changed", () => {
  const store = openStore(":memory:");
  assert.deepEqual(store.put(item("1", "a"), "sync", T0), { changed: true, created: true });
  assert.deepEqual(store.put(item("1", "a"), "sync", T0), { changed: false, created: false });
  assert.deepEqual(store.put(item("1", "b"), "sync", T0), { changed: true, created: false });
  const events = store.eventsAfter(0, 10);
  assert.deepEqual(events.map((e) => e.kind), ["work.created", "work.updated"]);
  assert.equal(store.get<WorkItem>({ host: "fake", kind: "work", id: "1" })?.title, "b");
  assert.equal(store.list<WorkItem>("work").length, 1);
  store.close();
});

test("the newest events of some kinds, newest first", () => {
  const store = openStore(":memory:");
  for (const kind of ["test.one", "test.two", "test.one", "test.three", "test.one"]) store.appendEvent({ kind, actor: "test", data: { kind } }, T0);
  assert.deepEqual(store.eventsOfKinds(["test.one", "test.three"], 3).map((event) => [event.seq, event.kind]), [[5, "test.one"], [4, "test.three"], [3, "test.one"]]);
  assert.deepEqual(store.eventsOfKinds([], 3), []);
  assert.deepEqual(store.eventsOfKinds(["test.two"], 10)[0]?.data, { kind: "test.two" });
  store.close();
});

test("events cannot be changed or deleted, even behind the interface", () => {
  const dir = mkdtempSync(join(tmpdir(), "scopesoup-"));
  const path = join(dir, "test.sqlite");
  const store = openStore(path);
  store.appendEvent({ kind: "test.one", actor: "test" }, T0);
  const raw = new DatabaseSync(path);
  assert.throws(() => raw.exec("UPDATE events SET kind = 'x'"), /append-only/);
  assert.throws(() => raw.exec("DELETE FROM events"), /append-only/);
  raw.close();
  assert.equal(store.eventsAfter(0, 10)[0]?.kind, "test.one");
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

test("a failed transaction leaves nothing behind and notifies nobody", () => {
  const store = openStore(":memory:");
  const seen: ScopeSoupEvent[] = [];
  store.onEvent((e) => seen.push(e));
  assert.throws(() =>
    store.tx(() => {
      store.put(item("1", "a"), "sync", T0);
      throw new Error("boom");
    }),
  );
  assert.equal(store.list("work").length, 0);
  assert.equal(store.lastSeq(), 0);
  assert.equal(seen.length, 0);
  store.put(item("2", "b"), "sync", T0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.seq, store.lastSeq());
  store.close();
});

test("remove, values and usage samples", () => {
  const store = openStore(":memory:");
  store.put(item("1", "a"), "sync", T0);
  assert.equal(store.remove({ host: "fake", kind: "work", id: "1" }, "sync", T0), true);
  assert.equal(store.remove({ host: "fake", kind: "work", id: "1" }, "sync", T0), false);
  assert.equal(store.getValue("cursor"), null);
  store.setValue("cursor", "abc");
  store.setValue("cursor", "def");
  assert.equal(store.getValue("cursor"), "def");
  assert.equal(store.latestUsageSample(), null);
  store.addUsageSample({ at: T0, windows: [{ kind: "five_hour", utilization: 0.1, resetsAt: T0 }] });
  assert.equal(store.latestUsageSample()?.windows[0]?.utilization, 0.1);
  store.close();
});

// --- the schema version ---

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const UPGRADE = /this project's data is from a newer Scope Soup; upgrade/;

/** A database file made from a fixture, as the Scope Soup of that version left it. */
function fromFixture(dir: string, version: number, name = "scopesoup.sqlite"): string {
  const path = join(dir, name);
  const raw = new DatabaseSync(path);
  raw.exec(readFileSync(join(FIXTURES, `version-${version}.sql`), "utf8"));
  raw.close();
  return path;
}

/** Every file in `dir` with a hash of its bytes. */
function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir).sort().map((name) => [name, createHash("sha256").update(readFileSync(join(dir, name))).digest("hex")]));
}

/** The user_version and the tables, indexes and triggers of a database file. */
function onDisk(path: string): { version: number; names: string[] } {
  const raw = new DatabaseSync(path, { readOnly: true });
  const version = Number((raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  const rows = raw.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  raw.close();
  return { version, names: rows.map((row) => row.name) };
}

/** What the fixtures hold, read through the store. */
function assertFixtureRows(store: Store): void {
  assert.deepEqual(store.list<WorkItem>("work").map((w) => w.title), ["Add a greeting", "Fix the farewell"]);
  assert.equal(store.get<WorkItem>({ host: "fake", kind: "work", id: "1" })?.labels[0], "size:small");
  assert.deepEqual(store.eventsAfter(0, 10).map((e) => [e.seq, e.kind]), [[1, "work.created"], [2, "work.created"], [3, "scopesoup.started"]]);
  assert.equal(store.lastSeq(), 3);
  assert.match(store.getValue("person.answers") ?? "", /Yes, in English/);
  assert.match(store.getValue("orchestrator.jobs") ?? "", /scopesoup\/1/);
  assert.equal(store.getValue("sync.cursor.fake"), "abc123");
  assert.deepEqual(store.usageSamplesSince("2026-01-01T00:00:00Z").map((s) => s.windows[0]?.utilization), [0.25, 0.5]);
  assert.equal(store.latestUsageSample()?.windows[0]?.utilization, 0.5);
}

/** A later version, as a release that changes the schema would add it: a new column and a table, with a copy first. */
const LATER: Schema = {
  version: STORE_VERSION + 1,
  create: `${SCHEMA_1}\nALTER TABLE objects ADD COLUMN note TEXT;\nCREATE TABLE later (id INTEGER PRIMARY KEY);\n`,
  steps: [...CURRENT_SCHEMA.steps, { copyFirst: true, run: (db) => db.exec("ALTER TABLE objects ADD COLUMN note TEXT; CREATE TABLE later (id INTEGER PRIMARY KEY);") }],
};

describe("the database's schema version", { concurrency: 4 }, () => {
  const dirs: string[] = [];
  const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "scopesoup-store-"));
    dirs.push(dir);
    return dir;
  };
  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  test("a new database starts at the current version", () => {
    const memory = openStore(":memory:");
    assert.deepEqual(memory.format, { version: STORE_VERSION, readOnly: false, migratedFrom: null, copy: null });
    memory.close();
    const path = join(tempDir(), "scopesoup.sqlite");
    const store = openStore(path);
    assert.deepEqual(store.format, { version: STORE_VERSION, readOnly: false, migratedFrom: null, copy: null });
    store.close();
    assert.equal(onDisk(path).version, STORE_VERSION);
  });

  test("an unversioned database (version 0) is migrated to version 1 and keeps its objects, events, values and usage samples", () => {
    const dir = tempDir();
    const path = fromFixture(dir, 0);
    const before = onDisk(path);
    assert.equal(before.version, 0);
    const store = openStore(path);
    assert.deepEqual(store.format, { version: 1, readOnly: false, migratedFrom: 0, copy: null });
    assertFixtureRows(store);
    // It goes on working: new events follow on.
    assert.equal(store.appendEvent({ kind: "test.after", actor: "test" }, T0), 4);
    store.close();
    const migrated = onDisk(path);
    assert.equal(migrated.version, 1);
    assert.deepEqual(migrated.names, before.names);
    // 0 to 1 only sets the number, which an older Scope Soup ignores: no copy is kept.
    assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".v")), []);
    const again = openStore(path);
    assert.equal(again.format.migratedFrom, null);
    again.close();
  });

  test("a version-0 database from before usage_samples gets the table", () => {
    const path = join(tempDir(), "scopesoup.sqlite");
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO kv VALUES ('person.answers', '{}');");
    raw.close();
    const store = openStore(path);
    assert.equal(store.getValue("person.answers"), "{}");
    store.addUsageSample({ at: T0, windows: [] });
    assert.equal(store.latestUsageSample()?.at, T0);
    store.close();
  });

  test("the current version's fixture reads as it is", () => {
    const path = fromFixture(tempDir(), 1);
    const store = openStore(path);
    assert.deepEqual(store.format, { version: 1, readOnly: false, migratedFrom: null, copy: null });
    assertFixtureRows(store);
    store.close();
  });

  test("a newer database opens read only: reads return its data, every write is refused, and nothing changes on disk", () => {
    const dir = tempDir();
    const path = fromFixture(dir, 1);
    // As a newer Scope Soup would leave it: WAL, closed cleanly, a higher user_version.
    const raw = new DatabaseSync(path);
    raw.exec(`PRAGMA journal_mode = WAL; PRAGMA user_version = ${STORE_VERSION + 1};`);
    raw.close();
    const files = snapshot(dir);
    assert.deepEqual(Object.keys(files), ["scopesoup.sqlite"]);

    const store = openStore(path);
    assert.deepEqual(store.format, { version: STORE_VERSION + 1, readOnly: true, migratedFrom: null, copy: null });
    assertFixtureRows(store);
    assert.equal(store.tx(() => store.lastSeq()), 3);
    assert.throws(() => store.put(item("9", "new"), "sync", T0), UPGRADE);
    assert.throws(() => store.remove({ host: "fake", kind: "work", id: "1" }, "sync", T0), UPGRADE);
    assert.throws(() => store.appendEvent({ kind: "test.x", actor: "test" }, T0), UPGRADE);
    assert.throws(() => store.setValue("sync.cursor.fake", "x"), UPGRADE);
    assert.throws(() => store.addUsageSample({ at: T0, windows: [] }), UPGRADE);
    assert.throws(() => store.tx(() => store.setValue("k", "v")), UPGRADE);
    assertFixtureRows(store);
    store.close();
    assert.deepEqual(snapshot(dir), files);
  });

  test("the current fixtures still read after the schema changes in a later version, with a copy kept first", () => {
    const dir = tempDir();
    const path = fromFixture(dir, 1);
    // An older copy is replaced: only the newest is kept.
    writeFileSync(join(dir, "scopesoup.v0.sqlite"), "an older copy");
    const store = openStore(path, LATER);
    assert.deepEqual(store.format, { version: STORE_VERSION + 1, readOnly: false, migratedFrom: 1, copy: storeCopyPath(path, 1) });
    assertFixtureRows(store);
    store.put(item("3", "after"), "sync", T0);
    store.close();
    assert.equal(onDisk(path).version, STORE_VERSION + 1);
    assert.ok(onDisk(path).names.includes("later"));
    assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".v")), ["scopesoup.v1.sqlite"]);
    // The copy is the database as it was: version 1, every row, readable by this Scope Soup.
    const copy = join(dir, "scopesoup.v1.sqlite");
    assert.equal(onDisk(copy).version, 1);
    const old = openStore(copy);
    assert.equal(old.format.migratedFrom, null);
    assertFixtureRows(old);
    old.close();

    // Version 0 goes through both steps.
    const zero = openStore(fromFixture(tempDir(), 0), LATER);
    assert.equal(zero.format.migratedFrom, 0);
    assert.ok(zero.format.copy?.endsWith("scopesoup.v0.sqlite"));
    assertFixtureRows(zero);
    zero.close();
    // A new database is made at the later version directly.
    const fresh = openStore(join(tempDir(), "scopesoup.sqlite"), LATER);
    assert.deepEqual(fresh.format, { version: STORE_VERSION + 1, readOnly: false, migratedFrom: null, copy: null });
    fresh.close();
  });

  test("a migration that fails leaves the database as it was", () => {
    const path = fromFixture(tempDir(), 0);
    const failing: Schema = {
      version: STORE_VERSION + 1,
      create: SCHEMA_1,
      steps: [
        ...CURRENT_SCHEMA.steps,
        {
          copyFirst: false,
          run: (db) => {
            db.exec("CREATE TABLE half (id INTEGER)");
            throw new Error("step failed");
          },
        },
      ],
    };
    assert.throws(() => openStore(path, failing), /step failed/);
    const disk = onDisk(path);
    assert.equal(disk.version, 0);
    assert.ok(!disk.names.includes("half"));
    const store = openStore(path);
    assertFixtureRows(store);
    store.close();
  });
});
