PRAGMA foreign_keys = OFF;
BEGIN;

CREATE TABLE endpoint_profiles_next (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN (
    'serial', 'tcp-client', 'tcp-server', 'udp-client', 'udp-server',
    'dlt645-master', 'dlt645-slave',
    'modbus-tcp-master', 'modbus-tcp-slave',
    'modbus-rtu-master', 'modbus-rtu-slave'
  )),
  config_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO endpoint_profiles_next
  (id, name, transport, config_json, created_at, updated_at)
SELECT id, name, transport, config_json, created_at, updated_at
FROM endpoint_profiles;

DROP TABLE endpoint_profiles;
ALTER TABLE endpoint_profiles_next RENAME TO endpoint_profiles;

INSERT INTO schema_migrations (version, name, applied_at)
VALUES (5, '005-dlt645-simulator-endpoints', CAST(unixepoch('subsec') * 1000 AS INTEGER));

COMMIT;
PRAGMA foreign_keys = ON;
