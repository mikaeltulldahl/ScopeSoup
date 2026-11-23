-- Version 1 of Scope Soup's database: version 0's schema with user_version set to 1. Nothing else differs. Synthetic
-- rows, one or more in every table. Kept as it is: store.test.ts checks that this Scope Soup reads it, and that a later
-- version's steps migrate it and keep every row.

PRAGMA user_version = 1;

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

INSERT INTO objects (key, host, kind, json, updated_at) VALUES
  ('fake:work:1', 'fake', 'work', '{"ref":{"host":"fake","kind":"work","id":"1"},"title":"Add a greeting","state":"todo","hostState":"open","labels":["size:small"],"blockedBy":[],"openChildren":0,"updatedAt":"2026-01-01T00:00:00Z"}', '2026-01-01T00:00:00Z'),
  ('fake:work:2', 'fake', 'work', '{"ref":{"host":"fake","kind":"work","id":"2"},"title":"Fix the farewell","state":"done","hostState":"closed","labels":[],"blockedBy":[],"openChildren":0,"updatedAt":"2026-01-02T00:00:00Z"}', '2026-01-02T00:00:00Z');

INSERT INTO events (at, kind, subject, actor, json) VALUES
  ('2026-01-01T00:00:00Z', 'work.created', 'fake:work:1', 'sync', '{"ref":{"host":"fake","kind":"work","id":"1"},"title":"Add a greeting"}'),
  ('2026-01-02T00:00:00Z', 'work.created', 'fake:work:2', 'sync', '{"ref":{"host":"fake","kind":"work","id":"2"},"title":"Fix the farewell"}'),
  ('2026-01-02T00:05:00Z', 'scopesoup.started', NULL, 'scopesoup', '{"pid":4242}');

INSERT INTO kv (key, value) VALUES
  ('person.answers', '{"fake:work:1":[{"n":1,"answer":"Yes, in English","by":"Ada","at":"2026-01-01T10:00:00Z"}]}'),
  ('orchestrator.jobs', '{"fake:work:1":{"step":"implement","branch":"scopesoup/1"}}'),
  ('sync.cursor.fake', 'abc123');

INSERT INTO usage_samples (at, json) VALUES
  ('2026-01-01T00:00:00Z', '{"at":"2026-01-01T00:00:00Z","windows":[{"kind":"five_hour","utilization":0.25,"resetsAt":"2026-01-01T05:00:00Z"}]}'),
  ('2026-01-01T01:00:00Z', '{"at":"2026-01-01T01:00:00Z","windows":[{"kind":"five_hour","utilization":0.5,"resetsAt":"2026-01-01T05:00:00Z"}]}');
