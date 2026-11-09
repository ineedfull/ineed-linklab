import settingsSchema from '../../../runtime-contract/src/settingsSchema.json' with { type: 'json' };
import { normalizeAcceptanceDocument } from './acceptanceWorkspace.js';
import { safeStompProfiles } from './stompWorkbench.js';

const SETTING_RULES = settingsSchema.settings;
export const DEFAULT_SETTINGS = Object.freeze(Object.fromEntries(
  Object.entries(SETTING_RULES).map(([key, rule]) => [key, rule.default]),
));

export function parseHistoryLocation(search) {
  const params = new URLSearchParams(search);
  if (params.get('view') !== 'history') throw new TypeError('history view is required');
  const kind = params.get('kind');
  if (!['frames', 'logs'].includes(kind)) throw new TypeError('history kind must be frames or logs');
  const endpointId = params.get('endpointId');
  if (endpointId !== null && !isValidEndpointId(endpointId)) {
    throw new TypeError('endpoint ID is invalid');
  }
  return { kind, endpointId };
}

function isValidEndpointId(value) {
  return value.trim() !== ''
    && new TextEncoder().encode(value).length <= 128
    && !/[/\\\p{Cc}]/u.test(value);
}

export function createHistoryController(runtime, { kind, endpointId = null }) {
  if (!['frames', 'logs'].includes(kind)) throw new TypeError('history kind must be frames or logs');
  const emptyFilters = {
    endpointId, search: '', direction: '', level: '', source: '', from: null, to: null,
  };
  const state = {
    kind,
    draft: { ...emptyFilters },
    committed: { ...emptyFilters },
    rows: [],
    total: 0,
    page: 1,
    pageSize: 50,
    totalPages: 0,
    loading: false,
    error: '',
  };
  const listeners = new Set();
  let generation = 0;
  let disposed = false;
  let initialPromise = null;
  const publish = () => listeners.forEach((listener) => listener(state));

  function query(page, pageSize) {
    const requestGeneration = ++generation;
    state.loading = true;
    state.error = '';
    publish();
    return (async () => {
      try {
      const request = { ...state.committed, page, pageSize };
      const method = kind === 'frames' ? runtime.history.queryFrames : runtime.history.queryLogs;
      const result = await method(request);
      if (disposed || requestGeneration !== generation) return result;
      state.rows = result.rows;
      state.total = result.total;
      state.page = result.page;
      state.pageSize = result.pageSize;
      state.totalPages = result.total === 0 ? 0 : Math.ceil(result.total / result.pageSize);
      publish();
      return result;
    } catch (error) {
      if (disposed || requestGeneration !== generation) return undefined;
      state.error = error instanceof Error ? error.message : String(error);
      publish();
      throw error;
    } finally {
      if (!disposed && requestGeneration === generation) {
        state.loading = false;
        publish();
      }
    }
    })();
  }

  return {
    state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setDraft(patch) { Object.assign(state.draft, patch); publish(); },
    load() {
      if (!initialPromise) initialPromise = query(1, state.pageSize);
      return initialPromise;
    },
    search() {
      state.committed = { ...state.draft };
      return query(1, state.pageSize);
    },
    goToPage(page) { return query(page, state.pageSize); },
    setPageSize(pageSize) { return query(1, pageSize); },
    dispose() {
      disposed = true;
      generation += 1;
      state.loading = false;
      listeners.clear();
    },
  };
}

export function normalizeSettings(input = {}) {
  if (!isPlainObject(input)) throw new TypeError('settings must be an object');
  const result = structuredClone(DEFAULT_SETTINGS);
  for (const [key, value] of Object.entries(input)) {
    const rule = SETTING_RULES[key];
    if (!rule) throw new TypeError(`unknown setting: ${key}`);
    validateSettingValue(key, value, rule);
    result[key] = rule.type === 'stomp-profiles' ? safeStompProfiles(value) : value;
  }
  return result;
}

function validateSettingValue(key, value, rule) {
  if (rule.type === 'acceptance-document') normalizeAcceptanceDocument(value);
  if (rule.type === 'integer' && (
    !Number.isSafeInteger(value) || value < rule.minimum || value > rule.maximum
  )) throw new TypeError(`${key} must be an integer from ${rule.minimum} to ${rule.maximum}`);
  if (rule.type === 'boolean' && typeof value !== 'boolean') {
    throw new TypeError(`${key} must be boolean`);
  }
  if (rule.type === 'string' && typeof value !== 'string') {
    throw new TypeError(`${key} must be a string`);
  }
  if (rule.enum && !rule.enum.includes(value)) throw new TypeError(`${key} is invalid`);
}

export { formatTimestamp } from './dateTime.js';

export function formatByteSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  const units = [['GB', 1024 ** 3], ['MB', 1024 ** 2], ['KB', 1024]];
  const [unit, divisor] = units.find(([, size]) => bytes >= size) ?? units.at(-1);
  return `${Number((bytes / divisor).toFixed(1))} ${unit}`;
}

const canonicalBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true });

export function decodeBase64Bytes(value, maxBytes) {
  return decodeCanonicalBase64(value, maxBytes).bytes;
}

function decodeCanonicalBase64(value, maxBytes) {
  const byteLength = canonicalBase64ByteLength(value);
  const decodedLength = Number.isSafeInteger(maxBytes) && maxBytes > 0
    ? Math.min(maxBytes, byteLength)
    : byteLength;
  const encodedLength = decodedLength === byteLength
    ? value.length
    : Math.ceil(decodedLength / 3) * 4;
  const binary = atob(value.slice(0, encodedLength));
  return {
    bytes: Uint8Array.from(binary, (character) => character.charCodeAt(0)).subarray(0, decodedLength),
    byteLength,
  };
}

function canonicalBase64ByteLength(value) {
  if (typeof value !== 'string' || !canonicalBase64.test(value)) {
    throw new TypeError('Base64 must be canonical');
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const finalValue = padding === 0 ? 0 : padding === 2
    ? base64Value(value.at(-3))
    : base64Value(value.at(-2));
  if ((padding === 2 && (finalValue & 0b1111) !== 0)
    || (padding === 1 && (finalValue & 0b11) !== 0)) {
    throw new TypeError('Base64 must be canonical');
  }
  return (value.length / 4) * 3 - padding;
}

function base64Value(character) {
  const code = character.charCodeAt(0);
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  return character === '+' ? 62 : 63;
}

export function formatHistoryPayload({ format, payloadBase64 }, { byteLimit } = {}) {
  if (!payloadBase64) return '';
  let bytes;
  let byteLength;
  try {
    const decodedLength = Number.isSafeInteger(byteLimit) && byteLimit > 0 ? byteLimit : undefined;
    ({ bytes, byteLength } = decodeCanonicalBase64(payloadBase64, decodedLength));
  } catch {
    return payloadBase64;
  }
  const truncated = bytes.length < byteLength;
  if (format === 'hex') return `${formatHexBytes(bytes)}${truncated ? ' ...（已截断）' : ''}`;
  let text;
  try {
    text = decodeUtf8Preview(bytes, truncated);
  } catch {
    return payloadBase64;
  }
  if (format !== 'json' || truncated) return `${text}${truncated ? ' ...（已截断）' : ''}`;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function decodeUtf8Preview(bytes, truncated) {
  const minimumLength = truncated ? Math.max(0, bytes.length - 3) : bytes.length;
  for (let length = bytes.length; length >= minimumLength; length -= 1) {
    try {
      return fatalUtf8Decoder.decode(bytes.subarray(0, length));
    } catch {
      // A preview may end inside a multibyte sequence; retry without that sequence.
    }
  }
  throw new TypeError('UTF-8 bytes are invalid');
}

function formatHexBytes(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

export function createHistoryPayloadCache(formatPayload = formatHistoryPayload) {
  let rows = null;
  let previewByteLimit = null;
  let hasPreviews = false;
  let previews = [];
  let details = new Map();
  function reset(nextRows) {
    if (rows === nextRows) return;
    rows = nextRows;
    previewByteLimit = null;
    hasPreviews = false;
    previews = [];
    details = new Map();
  }
  return {
    previews(nextRows, byteLimit) {
      reset(nextRows);
      if (hasPreviews && previewByteLimit === byteLimit) return previews;
      previewByteLimit = byteLimit;
      hasPreviews = true;
      previews = nextRows.map((row) => formatPayload(row, { byteLimit }));
      return previews;
    },
    detail(nextRows, row) {
      reset(nextRows);
      if (!details.has(row)) details.set(row, formatPayload(row, {}));
      return details.get(row);
    },
  };
}

export function formatFramingLabel(value) {
  return {
    raw: '原始数据',
    delimiter: '分隔符',
    fixed: '固定长度',
    idle: '空闲超时',
    none: '无',
    line: '按行',
    'length-prefix': '长度前缀',
  }[value] ?? value;
}

export function validateWorkspaceDocument(document, expectedVersion, mutate = () => {}) {
  if (!isPlainObject(document) || document.schemaVersion !== expectedVersion) {
    throw new TypeError(`Workspace schema version must be ${expectedVersion}`);
  }
  mutate(document);
  return document;
}

export function createStorageController(runtime) {
  const state = { stats: null, loading: false, error: '', clearResult: null };
  const listeners = new Set();
  let generation = 0;
  let disposed = false;
  let active = null;
  const publish = () => listeners.forEach((listener) => listener(state));
  function run(operation, applyResult) {
    if (active) return active;
    const requestGeneration = ++generation;
    state.loading = true;
    state.error = '';
    publish();
    active = (async () => {
      try {
        const isCurrent = () => !disposed && requestGeneration === generation;
        const value = await operation(isCurrent);
        if (isCurrent()) {
          applyResult?.(value);
          publish();
        }
        return value;
      } catch (error) {
        if (!disposed && requestGeneration === generation) {
          state.error = error instanceof Error ? error.message : String(error);
          publish();
        }
        if (!disposed && requestGeneration === generation) throw error;
        return undefined;
      } finally {
        if (!disposed && requestGeneration === generation) {
          state.loading = false;
          active = null;
          publish();
        }
      }
    })();
    return active;
  }
  function refresh() {
    return run(
      () => runtime.storage.stats(),
      (stats) => { state.stats = stats; },
    );
  }
  return {
    state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    refresh,
    clearHistory() {
      return run(async (isCurrent) => {
        await runtime.persistence?.flush?.();
        const clearResult = await runtime.storage.clearHistory();
        if (!isCurrent()) return { clearResult, stats: null };
        const stats = await runtime.storage.stats();
        return { clearResult, stats };
      }, ({ clearResult, stats }) => {
        state.clearResult = clearResult;
        state.stats = stats;
      });
    },
    dispose() {
      disposed = true;
      generation += 1;
      active = null;
      state.loading = false;
      listeners.clear();
    },
  };
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
