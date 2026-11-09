import { readFile } from 'node:fs/promises';

export const SCHEMA_VERSION = 6;

const migrationHrefs = new Map([
  [1, new URL('../migrations/001-initial.sql', import.meta.url).href],
  [2, new URL('../migrations/002-modbus-endpoints.sql', import.meta.url).href],
  [3, new URL('../migrations/003-modbus-point-history.sql', import.meta.url).href],
  [4, new URL('../migrations/004-dlt645-endpoints.sql', import.meta.url).href],
  [6, new URL('../migrations/006-websocket-endpoints.sql', import.meta.url).href],
  [5, new URL('../migrations/005-dlt645-simulator-endpoints.sql', import.meta.url).href],
]);

export function migrationUrl(version) {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new TypeError(`Invalid migration version: ${String(version)}`);
  }

  const href = migrationHrefs.get(version);
  if (href === undefined) {
    throw new RangeError(`Unsupported migration version: ${version}`);
  }
  return new URL(href);
}

export async function readMigration(version) {
  return readFile(migrationUrl(version), 'utf8');
}
