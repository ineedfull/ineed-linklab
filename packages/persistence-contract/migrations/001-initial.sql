BEGIN;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE TABLE endpoint_profiles (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('serial', 'tcp-client', 'tcp-server', 'udp-client', 'udp-server')),
  config_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE transfer_frames (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  peer_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  format TEXT NOT NULL,
  framing TEXT NOT NULL,
  payload BLOB NOT NULL,
  byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (endpoint_id) REFERENCES endpoint_profiles(id) ON DELETE CASCADE
);

CREATE TABLE runtime_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id TEXT NOT NULL,
  session_id TEXT,
  peer_id TEXT,
  level TEXT NOT NULL,
  source TEXT NOT NULL,
  code TEXT,
  message TEXT NOT NULL,
  details_json TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (endpoint_id) REFERENCES endpoint_profiles(id) ON DELETE CASCADE
);

CREATE TABLE send_templates (
  id TEXT PRIMARY KEY NOT NULL,
  endpoint_id TEXT NOT NULL,
  name TEXT NOT NULL,
  format TEXT NOT NULL,
  framing TEXT NOT NULL,
  target_json TEXT,
  payload BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (endpoint_id) REFERENCES endpoint_profiles(id) ON DELETE CASCADE
);

CREATE TABLE send_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id TEXT NOT NULL,
  session_id TEXT,
  peer_id TEXT,
  target_json TEXT,
  format TEXT NOT NULL,
  framing TEXT NOT NULL,
  payload BLOB NOT NULL,
  byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (endpoint_id) REFERENCES endpoint_profiles(id) ON DELETE CASCADE
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX transfer_frames_by_endpoint_history
  ON transfer_frames(endpoint_id, created_at DESC, id DESC);
CREATE INDEX transfer_frames_by_session_history
  ON transfer_frames(session_id, created_at DESC, id DESC);
CREATE INDEX transfer_frames_by_peer_history
  ON transfer_frames(peer_id, created_at DESC, id DESC);
CREATE INDEX runtime_logs_by_endpoint_history
  ON runtime_logs(endpoint_id, created_at DESC, id DESC);

INSERT INTO schema_migrations (version, name, applied_at)
VALUES (1, '001-initial', CAST(unixepoch('subsec') * 1000 AS INTEGER));

COMMIT;
