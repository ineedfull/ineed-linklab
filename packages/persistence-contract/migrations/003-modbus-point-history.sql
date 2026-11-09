BEGIN;

CREATE TABLE modbus_point_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id TEXT NOT NULL,
  request_group_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  point_id TEXT NOT NULL,
  point_key TEXT NOT NULL,
  point_name TEXT NOT NULL,
  data_type TEXT NOT NULL,
  unit TEXT,
  raw_json TEXT NOT NULL,
  value_json TEXT NOT NULL,
  numeric_value REAL,
  display_value TEXT NOT NULL,
  quality TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (endpoint_id) REFERENCES endpoint_profiles(id) ON DELETE CASCADE
);

CREATE INDEX modbus_point_history_by_point
  ON modbus_point_history(
    endpoint_id, request_group_id, request_id, point_id, created_at DESC, id DESC
  );
CREATE INDEX modbus_point_history_by_request
  ON modbus_point_history(
    endpoint_id, request_group_id, request_id, created_at DESC, id DESC
  );
CREATE INDEX modbus_point_history_by_retention
  ON modbus_point_history(created_at, endpoint_id);

INSERT INTO schema_migrations (version, name, applied_at)
VALUES (3, '003-modbus-point-history', CAST(unixepoch('subsec') * 1000 AS INTEGER));

COMMIT;
