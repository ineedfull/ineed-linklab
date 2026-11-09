export const DLT645_TRANSPORT = 'dlt645-master';

export const DLT645_DATA_ITEMS = Object.freeze([
  item('00000000', '组合有功总电能', 'kWh', 2, 4),
  item('02010100', 'A 相电压', 'V', 1, 2),
  item('02010200', 'B 相电压', 'V', 1, 2),
  item('02010300', 'C 相电压', 'V', 1, 2),
  item('02020100', 'A 相电流', 'A', 3, 3),
  item('02020200', 'B 相电流', 'A', 3, 3),
  item('02020300', 'C 相电流', 'A', 3, 3),
  item('02030000', '瞬时总有功功率', 'kW', 4, 3, true),
  item('02030100', 'A 相有功功率', 'kW', 4, 3, true),
  item('02030200', 'B 相有功功率', 'kW', 4, 3, true),
  item('02030300', 'C 相有功功率', 'kW', 4, 3, true),
  item('02060000', '总功率因数', '', 3, 2, true),
]);

const CATALOG_BY_ID = new Map(DLT645_DATA_ITEMS.map((entry) => [entry.identifier, entry]));

export function normalizeDlt645Config(config = {}) {
  const source = isPlainObject(config) ? config : {};
  return {
    path: stringValue(source.path),
    baudRate: integerValue(source.baudRate, 2400),
    dataBits: integerValue(source.dataBits, 8),
    parity: stringValue(source.parity) || 'even',
    stopBits: numberValue(source.stopBits, 1),
    flowControl: stringValue(source.flowControl) || 'none',
    receiveFraming: { mode: 'raw' },
    timeoutMs: integerValue(source.timeoutMs, 1500),
    minRequestGapMs: integerValue(source.minRequestGapMs, 200),
    wakeUpBytes: integerValue(source.wakeUpBytes, 4),
    autoStart: source.autoStart === true,
    meters: Array.isArray(source.meters) ? source.meters.map(normalizeMeter) : [],
  };
}

export function createDlt645Meter(index = 1) {
  return {
    id: uniqueId('meter'),
    name: `电表 ${index}`,
    address: String(index).padStart(12, '0'),
    enabled: true,
    tasks: [createDlt645Task('00000000')],
  };
}

export function createDlt645Task(identifier = '00000000') {
  const normalized = String(identifier).toUpperCase();
  const catalog = CATALOG_BY_ID.get(normalized);
  return {
    id: uniqueId('task'),
    name: catalog?.name ?? '自定义数据项',
    identifier: normalized,
    unit: catalog?.unit ?? '',
    decimals: catalog?.decimals ?? 0,
    byteLength: catalog?.byteLength ?? 0,
    signed: catalog?.signed ?? false,
    pollIntervalMs: 5000,
    enabled: true,
  };
}

export function applyDlt645CatalogItem(task, identifier) {
  const catalog = CATALOG_BY_ID.get(String(identifier).toUpperCase());
  if (!catalog) return { ...task, identifier: String(identifier).toUpperCase() };
  return {
    ...task,
    identifier: catalog.identifier,
    name: catalog.name,
    unit: catalog.unit,
    decimals: catalog.decimals,
    byteLength: catalog.byteLength,
    signed: catalog.signed,
  };
}

export function validateDlt645Config(config) {
  const source = isPlainObject(config) ? config : {};
  const value = normalizeDlt645Config(config);
  // Defaults support older saved configs. Explicit form drafts must be checked
  // before normalization can replace an invalid number with a valid default.
  for (const field of ['baudRate', 'dataBits', 'stopBits', 'timeoutMs', 'minRequestGapMs', 'wakeUpBytes']) {
    value[field] = draftNumber(source[field], value[field]);
  }
  const errors = {};
  if (!value.path) errors.path = '请选择或输入串口。';
  if (!Number.isInteger(value.baudRate) || value.baudRate < 1 || value.baudRate > 0xffff_ffff) {
    errors.baudRate = '波特率必须为 1 到 4294967295 的整数。';
  }
  if (value.dataBits !== 8) errors.dataBits = 'DL/T 645-2007 数据位应为 8。';
  if (!['none', 'even', 'odd'].includes(value.parity)) errors.parity = '请选择有效的校验位。';
  if (![1, 2].includes(value.stopBits)) errors.stopBits = '停止位必须为 1 或 2。';
  if (!['none', 'hardware', 'software'].includes(value.flowControl)) errors.flowControl = '请选择有效的流控方式。';
  if (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 100 || value.timeoutMs > 60_000) {
    errors.timeoutMs = '请求超时必须为 100 到 60000 毫秒。';
  }
  if (!Number.isInteger(value.minRequestGapMs)
    || value.minRequestGapMs < 0 || value.minRequestGapMs > 60_000) {
    errors.minRequestGapMs = '最小请求间隔必须为 0 到 60000 毫秒。';
  }
  if (!Number.isInteger(value.wakeUpBytes) || value.wakeUpBytes < 0 || value.wakeUpBytes > 16) {
    errors.wakeUpBytes = '唤醒字节数量必须为 0 到 16。';
  }
  const addresses = new Set();
  value.meters.forEach((meter, meterIndex) => {
    const prefix = `meters.${meterIndex}`;
    if (!meter.name.trim()) errors[`${prefix}.name`] = '请输入电表名称。';
    if (!/^\d{12}$/.test(meter.address)) errors[`${prefix}.address`] = '电表地址必须是 12 位十进制数字。';
    else if (addresses.has(meter.address)) errors[`${prefix}.address`] = '电表地址不能重复。';
    addresses.add(meter.address);
    const identifiers = new Set();
    meter.tasks.forEach((task, taskIndex) => {
      const taskSource = source.meters?.[meterIndex]?.tasks?.[taskIndex] ?? {};
      for (const field of ['decimals', 'byteLength', 'pollIntervalMs']) {
        task[field] = draftNumber(taskSource[field], task[field]);
      }
      const taskPrefix = `${prefix}.tasks.${taskIndex}`;
      if (!task.name.trim()) errors[`${taskPrefix}.name`] = '请输入数据项名称。';
      if (!/^[0-9A-F]{8}$/.test(task.identifier)) {
        errors[`${taskPrefix}.identifier`] = '数据标识必须是 8 位 HEX。';
      } else if (identifiers.has(task.identifier)) {
        errors[`${taskPrefix}.identifier`] = '同一电表的数据标识不能重复。';
      }
      identifiers.add(task.identifier);
      if (!Number.isInteger(task.decimals) || task.decimals < 0 || task.decimals > 12) {
        errors[`${taskPrefix}.decimals`] = '小数位必须为 0 到 12。';
      }
      if (!Number.isInteger(task.byteLength) || task.byteLength < 0 || task.byteLength > 64) {
        errors[`${taskPrefix}.byteLength`] = '数据长度必须为 0 到 64 字节。';
      }
      if (typeof task.signed !== 'boolean') {
        errors[`${taskPrefix}.signed`] = '有符号标记必须为布尔值。';
      }
      if (!Number.isInteger(task.pollIntervalMs)
        || task.pollIntervalMs < 500 || task.pollIntervalMs > 3_600_000) {
        errors[`${taskPrefix}.pollIntervalMs`] = '轮询周期必须为 500 到 3600000 毫秒。';
      }
    });
  });
  return errors;
}

function normalizeMeter(meter, index) {
  const source = isPlainObject(meter) ? meter : {};
  return {
    id: stringValue(source.id) || `meter-${index + 1}`,
    name: stringValue(source.name) || `电表 ${index + 1}`,
    address: stringValue(source.address),
    enabled: source.enabled !== false,
    tasks: Array.isArray(source.tasks) ? source.tasks.map(normalizeTask) : [],
  };
}

function normalizeTask(task, index) {
  const source = isPlainObject(task) ? task : {};
  const identifier = stringValue(source.identifier).toUpperCase();
  const catalog = CATALOG_BY_ID.get(identifier);
  return {
    id: stringValue(source.id) || `task-${index + 1}`,
    name: stringValue(source.name) || catalog?.name || `数据项 ${index + 1}`,
    identifier,
    unit: stringValue(source.unit) || catalog?.unit || '',
    decimals: integerValue(source.decimals, catalog?.decimals ?? 0),
    byteLength: integerValue(source.byteLength, catalog?.byteLength ?? 0),
    signed: source.signed ?? catalog?.signed ?? false,
    pollIntervalMs: integerValue(source.pollIntervalMs, 5000),
    enabled: source.enabled !== false,
  };
}

function item(identifier, name, unit, decimals, byteLength, signed = false) {
  return Object.freeze({ identifier, name, unit, decimals, byteLength, signed });
}

function uniqueId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function stringValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function integerValue(value, fallback) {
  return Number.isInteger(Number(value)) ? Number(value) : fallback;
}

function numberValue(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function draftNumber(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) return Number(value);
  return NaN;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object'
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
