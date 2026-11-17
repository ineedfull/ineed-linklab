const WORKSPACE_SCHEMA_VERSION = 1;
const MAX_WORKSPACE_BYTES = 10 * 1024 * 1024;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const { createSafeExportWriter } = require('./safeExport.cjs');
const { constants: fileConstants, readFileSync } = require('node:fs');
const { contractAssetPath } = require('./contractAssets.cjs');
const SETTINGS_RULES = JSON.parse(readFileSync(contractAssetPath(
  'runtime-contract', 'src', 'settingsSchema.json',
), 'utf8')).settings;

function validateHistoryRequest(value) {
  if (!isPlainObject(value)) throw new TypeError('history request must be an object');
  const keys = Object.keys(value);
  if (keys.some((key) => !['kind', 'endpointId'].includes(key))) {
    throw new TypeError('history request contains an unknown property');
  }
  if (!['frames', 'logs'].includes(value.kind)) {
    throw new TypeError('history kind must be frames or logs');
  }
  const endpointId = value.endpointId ?? null;
  if (endpointId !== null && !isValidEndpointId(endpointId)) {
    throw new TypeError('endpoint ID is invalid');
  }
  return { kind: value.kind, endpointId };
}

function isValidEndpointId(value) {
  return typeof value === 'string'
    && value.trim() !== ''
    && Buffer.byteLength(value, 'utf8') <= 128
    && !/[/\\\p{Cc}]/u.test(value);
}

function buildHistoryLocation(rendererUrl, request) {
  const value = validateHistoryRequest(request);
  const url = new URL(rendererUrl);
  if (url.search || url.hash) throw new TypeError('renderer URL must not contain query or hash');
  url.searchParams.set('view', 'history');
  url.searchParams.set('kind', value.kind);
  if (value.endpointId) url.searchParams.set('endpointId', value.endpointId);
  return url.href;
}

function buildHistoryWindowTitle(request) {
  const { kind } = validateHistoryRequest(request);
  return kind === 'frames' ? '历史消息' : '历史日志';
}

function createWorkspaceFileHandlers({ BrowserWindow, dialog, files, database, protectedDirectories }) {
  const writeExport = createSafeExportWriter({ files, protectedDirectories });
  function senderWindow(event) {
    if (!event?.sender || typeof BrowserWindow?.fromWebContents !== 'function') return null;
    try {
      return BrowserWindow.fromWebContents(event.sender) ?? null;
    } catch {
      return null;
    }
  }

  function showDialog(method, event, options) {
    const parent = senderWindow(event);
    return parent ? dialog[method](parent, options) : dialog[method](options);
  }

  async function readBoundedImport(selectedPath) {
    let handle;
    try {
      const noFollow = fileConstants.O_NOFOLLOW ?? 0;
      handle = await files.open(selectedPath, fileConstants.O_RDONLY | noFollow);
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new TypeError('Workspace path must be a regular file');
      if (metadata.size > MAX_WORKSPACE_BYTES) throw new RangeError('Workspace import exceeds 10 MiB');
      const buffer = Buffer.allocUnsafe(MAX_WORKSPACE_BYTES + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      if (total > MAX_WORKSPACE_BYTES) throw new RangeError('Workspace import exceeds 10 MiB');
      return buffer.subarray(0, total).toString('utf8');
    } catch (error) {
      if (error?.code === 'ELOOP') {
        throw new TypeError('Workspace path must not be a symbolic link', { cause: error });
      }
      throw error;
    } finally {
      await handle?.close();
    }
  }

  return {
    async exportWorkspace(event) {
      const selected = await showDialog('showSaveDialog', event, {
        title: '导出工作区',
        buttonLabel: '导出',
        defaultPath: 'ineed-workspace.json',
        filters: [{ name: '工作区 JSON', extensions: ['json'] }],
      });
      if (selected.canceled || !selected.filePath) return { canceled: true };
      const exported = database.exportWorkspace();
      const document = { ...exported, schemaVersion: exported.version };
      delete document.version;
      const contents = `${JSON.stringify(document, null, 2)}\n`;
      if (Buffer.byteLength(contents, 'utf8') > MAX_WORKSPACE_BYTES) {
        throw new RangeError('Workspace export exceeds 10 MiB');
      }
      await writeExport(selected.filePath, contents);
      return { canceled: false, path: selected.filePath };
    },
    async importWorkspace(event, beforeImport = async () => {}) {
      const selected = await showDialog('showOpenDialog', event, {
        title: '导入工作区',
        buttonLabel: '导入',
        properties: ['openFile'],
        filters: [{ name: '工作区 JSON', extensions: ['json'] }],
      });
      const selectedPath = selected.filePaths?.[0];
      if (selected.canceled || !selectedPath) return { canceled: true };
      const source = await readBoundedImport(selectedPath);
      const document = parseWorkspaceDocument(source);
      if (!isPlainObject(document) || document.schemaVersion !== WORKSPACE_SCHEMA_VERSION) {
        throw new TypeError(`Workspace schema version must be ${WORKSPACE_SCHEMA_VERSION}`);
      }
      const workspace = { ...document, version: document.schemaVersion };
      delete workspace.schemaVersion;
      // Reject invalid contents before disturbing live connections. Retain a
      // validated snapshot while the transport persistence barrier runs.
      const prepared = database.prepareWorkspaceImport(workspace);
      await beforeImport();
      database.importWorkspace(prepared);
      return { canceled: false, path: selectedPath };
    },
  };
}

function parseWorkspaceDocument(source) {
  const numberSources = new WeakMap();
  const document = JSON.parse(source, function captureNumberSource(key, value, context) {
    if (typeof value === 'number' && typeof context?.source === 'string') {
      let fields = numberSources.get(this);
      if (!fields) {
        fields = new Map();
        numberSources.set(this, fields);
      }
      fields.set(key, context.source);
    }
    return value;
  });
  if (!isPlainObject(document)) return document;
  if (isPlainObject(document.settings)) {
    for (const [key, rule] of Object.entries(SETTINGS_RULES)) {
      if (rule.type !== 'integer' || !Object.hasOwn(document.settings, key)) continue;
      document.settings[key] = parseIntegralJsonLexeme(
        numberSources.get(document.settings)?.get(key),
        key,
        rule.maximum,
      );
      if (document.settings[key] < rule.minimum) {
        throw new RangeError(`${key} is outside the allowed range`);
      }
    }
  }
  for (const collection of [document.endpointProfiles, document.sendTemplates]) {
    if (!Array.isArray(collection)) continue;
    for (const record of collection) {
      if (!isPlainObject(record)) continue;
      for (const key of ['createdAt', 'updatedAt']) {
        if (!Object.hasOwn(record, key)) continue;
        record[key] = parseIntegralJsonLexeme(
          numberSources.get(record)?.get(key),
          key,
          MAX_SAFE_INTEGER,
        );
      }
    }
  }
  return document;
}

function parseIntegralJsonLexeme(raw, name, maximum) {
  if (typeof raw !== 'string') throw new TypeError(`${name} must be an integer`);
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(raw);
  if (!match || match[1] === '-') {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  const fraction = match[3] ?? '';
  const digits = `${match[2]}${fraction}`;
  if (/^0+$/.test(digits)) return 0;
  const exponent = BigInt(match[4] ?? '0');
  const scale = exponent - BigInt(fraction.length);
  const significant = digits.replace(/^0+/, '');
  let integerText;
  if (scale >= 0n) {
    const maximumDigits = String(maximum).length;
    if (scale > BigInt(maximumDigits)
      || significant.length + Number(scale) > maximumDigits) {
      throw new RangeError(`${name} is outside the allowed range`);
    }
    integerText = `${significant}${'0'.repeat(Number(scale))}`;
  } else {
    const removed = -scale;
    if (removed > BigInt(digits.length)) throw new TypeError(`${name} must be an integer`);
    const count = Number(removed);
    if (!/^0+$/.test(digits.slice(digits.length - count))) {
      throw new TypeError(`${name} must be an integer`);
    }
    integerText = digits.slice(0, digits.length - count).replace(/^0+/, '') || '0';
  }
  const integer = BigInt(integerText);
  if (integer > BigInt(maximum)) throw new RangeError(`${name} is outside the allowed range`);
  return Number(integer);
}

function normalizeSerialPortRecords(records) {
  const seen = new Set();
  const normalized = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record !== 'object') continue;
    const portPath = typeof record.path === 'string' ? record.path.trim() : '';
    if (!portPath || seen.has(portPath)) continue;
    seen.add(portPath);
    const manufacturer = typeof record.manufacturer === 'string' ? record.manufacturer.trim() : '';
    const name = [record.friendlyName, record.name, record.label, portPath]
      .find((value) => typeof value === 'string' && value.trim())
      .trim();
    const explicitLabel = typeof record.label === 'string' ? record.label.trim() : '';
    normalized.push({
      path: portPath,
      name,
      label: explicitLabel || (manufacturer && name === portPath ? `${name} - ${manufacturer}` : name),
      manufacturer,
    });
  }
  return normalized;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

module.exports = {
  MAX_WORKSPACE_BYTES,
  WORKSPACE_SCHEMA_VERSION,
  buildHistoryLocation,
  buildHistoryWindowTitle,
  createWorkspaceFileHandlers,
  normalizeSerialPortRecords,
  validateHistoryRequest,
};
