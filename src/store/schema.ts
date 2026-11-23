// The database's schema version (decision 64). `PRAGMA user_version` holds it: a whole number raised only when the
// schema changes. A database without one (user_version 0) is version 0: everything Scope Soup made before the schema version. Version 1
// is version 0 with the number set; nothing else differs, so the step from 0 to 1 only makes sure every table is there.
//
// Each step below turns a database of one version into the next. The store (store.ts) runs them in one transaction at
// open, after a copy of the database when a step changes the schema.

import type { DatabaseSync } from "node:sqlite";

/** The schema version this Scope Soup reads and writes. Raise it, and add a step, when the schema changes. */
export const STORE_VERSION = 1;

/** Said when the database is newer than this Scope Soup; the meta branch says the same. */
export const NEWER_STORE = "this project's data is from a newer Scope Soup; upgrade";

/** The schema of version 1, which is also version 0's (`IF NOT EXISTS`, as every Scope Soup before the schema version ran it at open). */
export const SCHEMA_1 = `
CREATE TABLE IF NOT EXISTS objects (
  key TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  kind TEXT NOT NULL,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS objects_kind ON objects (kind, host);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT,
  actor TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  json TEXT NOT NULL
);
`;

/**
 * One step: a database of version n becomes version n + 1, inside the migration's transaction. `copyFirst`: the step
 * changes what an older Scope Soup reads, so a copy of the database is kept before it runs (the upgrade policy). A step that only adds what an older Scope Soup ignores or makes itself needs no copy.
 */
export interface Step {
  copyFirst: boolean;
  run(db: DatabaseSync): void;
}

/** A schema: its version, the SQL that makes a new database of it, and the steps that bring an older one to it. */
export interface Schema {
  version: number;
  create: string;
  /** steps[n] turns version n into version n + 1. */
  steps: readonly Step[];
}

/** STEPS[n] turns version n into version n + 1. */
const STEPS: readonly Step[] = [
  // 0 to 1: version 1 is version 0 with user_version set. A database from before usage_samples gets that table, as an
  // older Scope Soup's open would have made it; an older Scope Soup reads version 1 as it is, so no copy is kept.
  { copyFirst: false, run: (db) => db.exec(SCHEMA_1) },
];

if (STEPS.length !== STORE_VERSION) throw new Error(`The store version is ${STORE_VERSION} but there are ${STEPS.length} steps.`);

/** This Scope Soup's schema. */
export const CURRENT_SCHEMA: Schema = { version: STORE_VERSION, create: SCHEMA_1, steps: STEPS };
