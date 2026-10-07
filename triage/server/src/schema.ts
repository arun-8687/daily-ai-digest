// Single source of truth for the SQLite schema. Every statement is idempotent so the
// server can open an existing database on every start.
export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('viewer', 'responder', 'admin')),
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS incidents (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint     TEXT NOT NULL,
  source          TEXT NOT NULL,
  title           TEXT NOT NULL,
  severity        TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  status          TEXT NOT NULL CHECK (status IN ('open', 'acked', 'resolved')),
  assignee_id     TEXT REFERENCES users(id),
  version         INTEGER NOT NULL DEFAULT 1,
  alert_count     INTEGER NOT NULL DEFAULT 0,
  first_seen      INTEGER NOT NULL,
  last_seen       INTEGER NOT NULL,
  acked_at        INTEGER,
  acked_by        TEXT,
  resolved_at     INTEGER,
  resolved_by     TEXT,
  sla_started_at  INTEGER,
  sla_breached_at INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS incidents_by_fingerprint ON incidents (fingerprint, status);
CREATE INDEX IF NOT EXISTS incidents_by_status ON incidents (status, id);
CREATE INDEX IF NOT EXISTS incidents_by_assignee ON incidents (assignee_id, id);
CREATE INDEX IF NOT EXISTS incidents_sla_pending ON incidents (sla_started_at)
  WHERE sla_started_at IS NOT NULL AND sla_breached_at IS NULL;

CREATE TABLE IF NOT EXISTS alerts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id  INTEGER NOT NULL REFERENCES incidents(id),
  fingerprint  TEXT NOT NULL,
  source       TEXT NOT NULL,
  severity     TEXT NOT NULL,
  title        TEXT NOT NULL,
  payload      TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  received_at  INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  UNIQUE (fingerprint, content_hash)
);
CREATE INDEX IF NOT EXISTS alerts_by_incident ON alerts (incident_id, ts);

-- Append-only: triggers make UPDATE and DELETE fail at the database level, not just in code.
CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id  INTEGER,
  actor        TEXT NOT NULL,
  actor_name   TEXT NOT NULL,
  action       TEXT NOT NULL,
  before_state TEXT,
  after_state  TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_by_incident ON audit_log (incident_id, id);
CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

-- Live-stream log. seq is the SSE event id, so it must never be reused.
CREATE TABLE IF NOT EXISTS events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  data       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key          TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  status       INTEGER NOT NULL,
  response     TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
`;
