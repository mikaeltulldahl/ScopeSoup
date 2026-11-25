// The store: one SQLite file. Objects are the source of truth; every change to one writes an
// event in the same transaction. Events are append-only and never read to compute state.

import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { ScopeSoupEvent, Ref, RefKind, UsageSample } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import { CURRENT_SCHEMA, NEWER_STORE } from "./schema.ts";
import type { Schema, Step } from "./schema.ts";

export interface NewEvent {
  kind: string;
  subject?: string;
  actor: string;
  data?: unknown;
}

interface EventRow {
  seq: number;
  at: string;
  kind: string;
  subject: string | null;
  actor: string;
  json: string;
}

const eventOf = (row: EventRow): ScopeSoupEvent => ({
  seq: Number(row.seq),
  at: row.at,
  kind: row.kind,
  subject: row.subject ?? undefined,
  actor: row.actor,
  data: JSON.parse(row.json) as unknown,
});

export interface PutResult {
  /** False when the stored object was already identical; no event was written. */
  changed: boolean;
  created: boolean;
}

export interface Store {
  /** The schema version, and whether the database is read only here. */
  readonly format: StoreFormat;

  /** Runs `fn` in one transaction. Nested calls join the outer one. */
  tx<T>(fn: () => T): T;

  /** Stores an object under its ref. Writes `<kind>.created` or `<kind>.updated` when it changed. */
  put<T extends { ref: Ref }>(object: T, actor: string, at: string): PutResult;
  get<T>(ref: Ref): T | null;
  list<T>(kind: RefKind, host?: string): T[];
  /** Removes an object and writes `<kind>.removed` (with `data`, such as the reason). Returns false when it was not there. */
  remove(ref: Ref, actor: string, at: string, data?: Record<string, unknown>): boolean;

  appendEvent(event: NewEvent, at: string): number;
  /** Events with seq greater than `afterSeq`, oldest first. */
  eventsAfter(afterSeq: number, limit: number): ScopeSoupEvent[];
  /** The newest `limit` events whose kind is one of `kinds`, newest first. */
  eventsOfKinds(kinds: readonly string[], limit: number): ScopeSoupEvent[];
  lastSeq(): number;
  /** Calls back after each committed event. Returns a function that stops it. */
  onEvent(listener: (event: ScopeSoupEvent) => void): () => void;

  /** Small values that are not objects: cursors, settings, the pause flag. No event is written. */
  getValue(key: string): string | null;
  setValue(key: string, value: string): void;

  addUsageSample(sample: UsageSample): void;
  latestUsageSample(): UsageSample | null;
  /** Readings taken at or after `since` (ISO), oldest first. */
  usageSamplesSince(since: string): UsageSample[];

  /** A whole copy of the database at `path` (VACUUM INTO), made before an upgrade switches the version. */
  backupTo(path: string): void;

  close(): void;
}

/** The database's schema version and how it was opened. */
export interface StoreFormat {
  /** The schema version the database is at: this Scope Soup's, or a newer one when read only. */
  version: number;
  /** True when the database is newer than this Scope Soup: reads work, every write is refused, nothing is changed on disk. */
  readOnly: boolean;
  /** The version it was migrated from at this open, or null when it was not migrated (new, current or newer). */
  migratedFrom: number | null;
  /** The copy kept before a migration step that changes the schema, or null when none was made. */
  copy: string | null;
}

/** Where the copy of a database at `version` is kept: `scopesoup.sqlite` at version 1 is kept as `scopesoup.v1.sqlite`. */
export function storeCopyPath(path: string, version: number): string {
  const ext = extname(path);
  return `${path.slice(0, path.length - ext.length)}.v${version}${ext}`;
}

const userVersion = (db: DatabaseSync): number => Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
const tableCount = (db: DatabaseSync): number => Number((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n);
const newer = (path: string, found: number, known: number): string =>
  `${path}: the database is version ${found} and this Scope Soup knows versions 0 to ${known}: ${NEWER_STORE}.`;

/**
 * Opens a database file read only without changing anything on disk. A WAL database opened read only leaves a `-wal`
 * and `-shm` file behind; when there is no `-wal` (no other connection, nothing unsaved) it is opened as immutable,
 * which makes none. With a `-wal`, another connection has it open or left changes in it, and a read-only open reads them.
 */
function openUntouched(path: string): DatabaseSync {
  if (existsSync(`${path}-wal`)) return new DatabaseSync(path, { readOnly: true });
  const url = pathToFileURL(path);
  url.searchParams.set("immutable", "1");
  return new DatabaseSync(url);
}

/** Keeps a copy of the database at `version` beside it. Older copies are removed first, so only the newest is kept. */
function keepCopy(db: DatabaseSync, path: string, version: number): string {
  const copy = storeCopyPath(path, version);
  const ext = extname(path);
  const stem = basename(path, ext);
  const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escape(stem)}\\.v[0-9]+${escape(ext)}(-wal|-shm|-journal)?$`);
  for (const name of readdirSync(dirname(path))) if (pattern.test(name)) unlinkSync(join(dirname(path), name));
  db.prepare("VACUUM INTO ?").run(copy);
  return copy;
}

/**
 * Brings a writable database to `schema`'s version: a new one gets the schema as it is, an older one the steps from its
 * version, in one transaction, after a copy when a step changes the schema.
 */
function migrate(db: DatabaseSync, path: string, schema: Schema): { from: number | null; copy: string | null } {
  const found = userVersion(db);
  if (found === schema.version) return { from: null, copy: null };
  if (found > schema.version) throw new Error(newer(path, found, schema.version));
  const isNew = tableCount(db) === 0;
  const copy = !isNew && path !== ":memory:" && schema.steps.slice(found).some((step) => step.copyFirst) ? keepCopy(db, path, found) : null;
  db.exec("BEGIN IMMEDIATE");
  try {
    // Another process may have migrated it meanwhile.
    const from = userVersion(db);
    if (from > schema.version) throw new Error(newer(path, from, schema.version));
    const empty = tableCount(db) === 0;
    if (empty) db.exec(schema.create);
    else for (let version = from; version < schema.version; version++) (schema.steps[version] as Step).run(db);
    db.exec(`PRAGMA user_version = ${schema.version}`);
    db.exec("COMMIT");
    return { from: empty || from === schema.version ? null : from, copy };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Opens (and creates) the store. Pass ":memory:" in tests. An older database is migrated to this Scope Soup's schema
 * version; a newer one is opened read only and left unchanged. `schema` is for tests that play a later version.
 */
export function openStore(path: string, schema: Schema = CURRENT_SCHEMA): Store {
  if (path !== ":memory:" && existsSync(path) && statSync(path).size > 0) {
    const probe = openUntouched(path);
    const found = userVersion(probe);
    if (found > schema.version) {
      probe.exec("PRAGMA busy_timeout = 5000;");
      try {
        return storeOn(probe, { version: found, readOnly: true, migratedFrom: null, copy: null }, schema.version);
      } catch (error) {
        // A newer schema may have changed a table this Scope Soup reads.
        probe.close();
        throw new Error(`${newer(path, found, schema.version)} This Scope Soup cannot read its tables (${error instanceof Error ? error.message : String(error)}).`);
      }
    }
    probe.close();
  }
  const db = new DatabaseSync(path);
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  let done: { from: number | null; copy: string | null };
  try {
    done = migrate(db, path, schema);
  } catch (error) {
    db.close();
    throw error;
  }
  return storeOn(db, { version: schema.version, readOnly: false, migratedFrom: done.from, copy: done.copy }, schema.version);
}

/** The store on an open database. `known`: the newest version this Scope Soup knows, for the refusal. */
function storeOn(db: DatabaseSync, format: StoreFormat, known: number): Store {
  const listeners = new Set<(event: ScopeSoupEvent) => void>();
  let depth = 0;
  let pending: ScopeSoupEvent[] = [];

  // A read-only database prepares no writes: a newer schema may have changed what they write to.
  const writable = (sql: string) => (format.readOnly ? null : db.prepare(sql));
  const refuse = (): void => {
    if (format.readOnly) throw new Error(`The database is version ${format.version} and this Scope Soup knows versions 0 to ${known}: ${NEWER_STORE}. It is read only here; nothing was written.`);
  };

  const selectObject = db.prepare("SELECT json FROM objects WHERE key = ?");
  const upsertObject = writable(
    "INSERT INTO objects (key, host, kind, json, updated_at) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT (key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
  );
  const deleteObject = writable("DELETE FROM objects WHERE key = ?");
  const listByKind = db.prepare("SELECT json FROM objects WHERE kind = ? ORDER BY key");
  const listByKindHost = db.prepare("SELECT json FROM objects WHERE kind = ? AND host = ? ORDER BY key");
  const insertEvent = writable("INSERT INTO events (at, kind, subject, actor, json) VALUES (?, ?, ?, ?, ?)");
  const selectEvents = db.prepare("SELECT seq, at, kind, subject, actor, json FROM events WHERE seq > ? ORDER BY seq LIMIT ?");
  const selectLastSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events");
  const selectValue = db.prepare("SELECT value FROM kv WHERE key = ?");
  const upsertValue = writable("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  const insertUsage = writable("INSERT INTO usage_samples (at, json) VALUES (?, ?)");
  const selectUsageSince = db.prepare("SELECT json FROM usage_samples WHERE at >= ? ORDER BY id");
  const selectUsage = db.prepare("SELECT json FROM usage_samples ORDER BY id DESC LIMIT 1");

  function tx<T>(fn: () => T): T {
    if (depth > 0 || format.readOnly) return fn();
    depth = 1;
    db.exec("BEGIN IMMEDIATE");
    let result: T;
    try {
      result = fn();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      pending = [];
      throw error;
    } finally {
      depth = 0;
    }
    const committed = pending;
    pending = [];
    for (const event of committed) {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // A broken listener must not break the writer.
        }
      }
    }
    return result;
  }

  function appendEvent(event: NewEvent, at: string): number {
    refuse();
    return tx(() => {
      const data = event.data === undefined ? null : event.data;
      const info = insertEvent!.run(at, event.kind, event.subject ?? null, event.actor, JSON.stringify(data));
      const seq = Number(info.lastInsertRowid);
      pending.push({ seq, at, kind: event.kind, subject: event.subject, actor: event.actor, data });
      return seq;
    });
  }

  return {
    format,
    tx,

    put(object, actor, at) {
      refuse();
      return tx(() => {
        const key = refKey(object.ref);
        const json = JSON.stringify(object);
        const existing = selectObject.get(key) as { json: string } | undefined;
        if (existing && existing.json === json) return { changed: false, created: false };
        upsertObject!.run(key, object.ref.host, object.ref.kind, json, at);
        const created = !existing;
        appendEvent({ kind: `${object.ref.kind}.${created ? "created" : "updated"}`, subject: key, actor, data: object }, at);
        return { changed: true, created };
      });
    },

    get<T>(ref: Ref): T | null {
      const row = selectObject.get(refKey(ref)) as { json: string } | undefined;
      return row ? (JSON.parse(row.json) as T) : null;
    },

    list<T>(kind: RefKind, host?: string): T[] {
      const rows = (host === undefined ? listByKind.all(kind) : listByKindHost.all(kind, host)) as { json: string }[];
      return rows.map((row) => JSON.parse(row.json) as T);
    },

    remove(ref, actor, at, data) {
      refuse();
      return tx(() => {
        const key = refKey(ref);
        const info = deleteObject!.run(key);
        if (Number(info.changes) === 0) return false;
        appendEvent({ kind: `${ref.kind}.removed`, subject: key, actor, ...(data ? { data } : {}) }, at);
        return true;
      });
    },

    appendEvent,

    eventsAfter(afterSeq, limit) {
      const rows = selectEvents.all(afterSeq, limit) as unknown as EventRow[];
      return rows.map(eventOf);
    },

    eventsOfKinds(kinds, limit) {
      if (kinds.length === 0 || limit <= 0) return [];
      const rows = db.prepare(`SELECT seq, at, kind, subject, actor, json FROM events WHERE kind IN (${kinds.map(() => "?").join(", ")}) ORDER BY seq DESC LIMIT ?`).all(...kinds, limit) as unknown as EventRow[];
      return rows.map(eventOf);
    },

    lastSeq() {
      return Number((selectLastSeq.get() as { seq: number }).seq);
    },

    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getValue(key) {
      const row = selectValue.get(key) as { value: string } | undefined;
      return row ? row.value : null;
    },

    setValue(key, value) {
      refuse();
      upsertValue!.run(key, value);
    },

    addUsageSample(sample) {
      refuse();
      insertUsage!.run(sample.at, JSON.stringify(sample));
    },

    latestUsageSample() {
      const row = selectUsage.get() as { json: string } | undefined;
      return row ? (JSON.parse(row.json) as UsageSample) : null;
    },

    usageSamplesSince(since) {
      return (selectUsageSince.all(since) as { json: string }[]).map((row) => JSON.parse(row.json) as UsageSample);
    },

    backupTo(path) {
      db.prepare("VACUUM INTO ?").run(path);
    },

    close() {
      db.close();
    },
  };
}
