// SQLite schema. Every statement is idempotent so it can run on every start.

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('viewer', 'responder', 'admin')),
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS incidents (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint     TEXT NOT NULL,
  source          TEXT NOT NULL,
  title           TEXT NOT NULL,
  severity        TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  status          TEXT NOT NULL CHECK (status IN ('open', 'acked', 'resolved')),
  assignee_id     TEXT REFERENCES users(id),
  version         INTEGER NOT NULL,
  rev             INTEGER NOT NULL,
  alert_count     INTEGER NOT NULL,
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
CREATE INDEX IF NOT EXISTS incidents_fingerprint ON incidents(fingerprint, status);
CREATE INDEX IF NOT EXISTS incidents_resolved ON incidents(fingerprint, resolved_at);
CREATE INDEX IF NOT EXISTS incidents_sla ON incidents(status, sla_breached_at, sla_started_at);

CREATE TABLE IF NOT EXISTS alerts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id  INTEGER NOT NULL REFERENCES incidents(id),
  source       TEXT NOT NULL,
  fingerprint  TEXT NOT NULL,
  severity     TEXT NOT NULL,
  title        TEXT NOT NULL,
  payload      TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  received_at  INTEGER NOT NULL,
  UNIQUE (fingerprint, content_hash)
);
CREATE INDEX IF NOT EXISTS alerts_incident ON alerts(incident_id, ts, id);

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
CREATE INDEX IF NOT EXISTS audit_incident ON audit_log(incident_id, id);

CREATE TRIGGER IF NOT EXISTS audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TABLE IF NOT EXISTS events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  data       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key          TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  status       INTEGER NOT NULL,
  body         TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
`;
