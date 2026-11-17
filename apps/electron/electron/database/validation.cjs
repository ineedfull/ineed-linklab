// Side-effect-free snapshots, JSON safety, and timestamp/identifier checks.
const { types: { isProxy } } = require('node:util');

const SENSITIVE_KEY = /password|passwd|passphrase|secret|credential|api[_-]?key|token/i;

const MIN_RUNTIME_HISTORY_TIMESTAMP = 1_000_000_000_000;

function plainRow(row) {
  return Object.fromEntries(Object.entries(row));
}

function cloneSerializable(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertJsonValue(value, ancestors = new Set(), pathName = 'setting value') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidJsonValue(pathName, 'numbers must be finite');
    if (Object.is(value, -0)) throw invalidJsonValue(pathName, 'negative zero cannot round-trip exactly');
    return;
  }
  if (typeof value !== 'object') {
    throw invalidJsonValue(pathName, `${typeof value} is unsupported`);
  }
  if (isProxy(value)) throw invalidJsonValue(pathName, 'proxies are unsupported');
  if (ancestors.has(value)) throw invalidJsonValue(pathName, 'cycles are unsupported');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw invalidJsonValue(pathName, 'arrays must use the standard prototype');
      }
      const keys = Reflect.ownKeys(value).filter((key) => key !== 'length');
      if (keys.length !== value.length
        || keys.some((key, index) => key !== String(index))) {
        throw invalidJsonValue(pathName, 'arrays must be dense and contain no extra properties');
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
          throw invalidJsonValue(`${pathName}[${index}]`, 'array entries must be data values');
        }
        assertJsonValue(descriptor.value, ancestors, `${pathName}[${index}]`);
      }
      return;
    }

    if (!isPlainObject(value)) {
      throw invalidJsonValue(pathName, 'objects must use a plain prototype');
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        throw invalidJsonValue(pathName, 'symbol properties are unsupported');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw invalidJsonValue(`${pathName}.${key}`, 'properties must be enumerable data values');
      }
      assertJsonValue(descriptor.value, ancestors, `${pathName}.${key}`);
    }
  } finally {
    ancestors.delete(value);
  }
}

function assertJsonSafeIntegers(value, label) {
  if (typeof value === 'number') {
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new TypeError(`${label} contains an unsafe integer`);
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const child of value) assertJsonSafeIntegers(child, label);
    return;
  }
  for (const child of Object.values(value)) assertJsonSafeIntegers(child, label);
}

function snapshotJsonValue(value, label) {
  try {
    assertJsonValue(value, new Set(), label);
    assertJsonSafeIntegers(value, label);
    return JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`${label} must be lossless JSON data: ${error.message}`, { cause: error });
  }
}

function assertJsonObject(value, pathName) {
  try {
    assertJsonValue(value, new Set(), pathName);
  } catch (error) {
    throw new TypeError(`${pathName} must be a valid JSON object: ${error.message}`, { cause: error });
  }
  if (!isPlainObject(value)) {
    throw new TypeError(`${pathName} must be a valid JSON object: must be a plain object`);
  }
}

function assertJsonObjectOrNull(value, pathName) {
  if (value === null) return;
  try {
    assertJsonObject(value, pathName);
  } catch (error) {
    throw new TypeError(`${pathName} must be a valid JSON object or null: ${error.message}`, {
      cause: error,
    });
  }
}

function snapshotRecord(value, { label, requiredKeys, optionalKeys = [] }) {
  if (value === null || typeof value !== 'object') {
    throw new TypeError(`${label} must be a plain object`);
  }
  if (isProxy(value)) throw new TypeError(`${label} must not be a proxy`);
  if (Array.isArray(value)) throw new TypeError(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }

  const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
  const snapshot = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new TypeError(`${label} must not contain symbol properties`);
    if (!allowedKeys.has(key)) throw new TypeError(`${label} contains unknown property: ${key}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`);
    }
    snapshot[key] = descriptor.value;
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(snapshot, key)) throw new TypeError(`${label}.${key} is required`);
  }
  return snapshot;
}

function invalidJsonValue(pathName, reason) {
  return new TypeError(`${pathName} must be a valid JSON value: ${reason}`);
}

function assertNoSensitiveKeys(value) {
  if (Array.isArray(value)) {
    for (const child of value) assertNoSensitiveKeys(child);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) throw new TypeError(`password-like field is not allowed: ${key}`);
    assertNoSensitiveKeys(child);
  }
}

function integerTimestamp(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError(`${name} must be a timestamp`);
  }
  return value;
}

function runtimeHistoryTimestamp(value, name) {
  const timestamp = integerTimestamp(value, undefined, name);
  if (timestamp === undefined || timestamp < MIN_RUNTIME_HISTORY_TIMESTAMP) {
    throw new TypeError(`${name} must be an epoch-millisecond timestamp`);
  }
  return timestamp;
}

function requireWorkspaceTimestamps(value, label) {
  for (const key of ['createdAt', 'updatedAt']) {
    if (!Object.hasOwn(value, key)) {
      throw new TypeError(`${label}.${key} must be a required workspace timestamp`);
    }
  }
}

function validateOptionalTimestamps(value, label) {
  for (const key of ['createdAt', 'updatedAt']) {
    if (Object.hasOwn(value, key)) integerTimestamp(value[key], undefined, `${label}.${key}`);
  }
}

function requireNonblankString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a nonblank string`);
  }
}

function requireBoundedId(value, name) {
  requireNonblankString(value, name);
  if (Buffer.byteLength(value, 'utf8') > 128) {
    throw new TypeError(`${name} must be at most 128 bytes`);
  }
}

function requireNullableString(value, name) {
  if (value !== null && typeof value !== 'string') {
    throw new TypeError(`${name} must be a string or null`);
  }
}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function requireNullableNonblankString(value, name) {
  if (value === null) return;
  requireNonblankString(value, name);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

module.exports = {
  plainRow,
  cloneSerializable,
  assertJsonValue,
  assertJsonSafeIntegers,
  snapshotJsonValue,
  assertJsonObject,
  assertJsonObjectOrNull,
  snapshotRecord,
  assertNoSensitiveKeys,
  integerTimestamp,
  runtimeHistoryTimestamp,
  requireWorkspaceTimestamps,
  validateOptionalTimestamps,
  requireNonblankString,
  requireBoundedId,
  requireNullableString,
  requirePositiveInteger,
  requireNullableNonblankString,
  isPlainObject,
};
