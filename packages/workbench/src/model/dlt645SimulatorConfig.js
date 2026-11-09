import { encodeDlt645Bcd } from '@ineed-linklab/codecs/dlt645.js';

import { DLT645_DATA_ITEMS } from './dlt645Config.js';

export const DLT645_SLAVE_TRANSPORT = 'dlt645-slave';

const CATALOG_BY_ID = new Map(DLT645_DATA_ITEMS.map((item) => [item.identifier, item]));
const DEFAULT_VALUES = Object.freeze({
  '00000000': 12345.67,
  '02010100': 230.1,
  '02010200': 229.8,
  '02010300': 230.4,
  '02020100': 5.125,
  '02020200': 4.986,
  '02020300': 5.042,
  '02030000': 3.4821,
  '02060000': 0.968,
});

export function normalizeDlt645SimulatorConfig(config = {}) {
  const source = isPlainObject(config) ? config : {};
  return {
    path: stringValue(source.path),
    baudRate: integerValue(source.baudRate, 2400),
    dataBits: integerValue(source.dataBits, 8),
    parity: stringValue(source.parity) || 'even',
    stopBits: numberValue(source.stopBits, 1),
    flowControl: stringValue(source.flowControl) || 'none',
    receiveFraming: { mode: 'raw' },
    responseDelayMs: integerValue(source.responseDelayMs, 50),
    wakeUpBytes: integerValue(source.wakeUpBytes, 0),
    meters: Array.isArray(source.meters)
      ? source.meters.map(normalizeSimulatorMeter)
      : [],
  };
}

export function createDlt645SimulatorMeter(index = 1) {
  return {
    id: uniqueId('sim-meter'),
    name: `模拟电表 ${index}`,
    address: String(index).padStart(12, '0'),
    enabled: true,
    tasks: [
      createDlt645SimulatorItem('00000000'),
      createDlt645SimulatorItem('02010100'),
      createDlt645SimulatorItem('02020100'),
      createDlt645SimulatorItem('02030000'),
      createDlt645SimulatorItem('02060000'),
    ],
  };
}

export function createDlt645SimulatorItem(identifier = '02010100') {
  const normalized = String(identifier).toUpperCase();
  const catalog = CATALOG_BY_ID.get(normalized);
  return {
    id: uniqueId('sim-item'),
    name: catalog?.name ?? '自定义数据项',
    identifier: normalized,
    unit: catalog?.unit ?? '',
    decimals: catalog?.decimals ?? 0,
    byteLength: catalog?.byteLength ?? 1,
    signed: catalog?.signed ?? false,
    value: DEFAULT_VALUES[normalized] ?? 0,
    enabled: true,
  };
}

export function applyDlt645SimulatorCatalogItem(item, identifier) {
  const catalog = CATALOG_BY_ID.get(String(identifier).toUpperCase());
  if (!catalog) return { ...item, identifier: String(identifier).toUpperCase() };
  return {
    ...item,
    identifier: catalog.identifier,
    name: catalog.name,
    unit: catalog.unit,
    decimals: catalog.decimals,
    byteLength: catalog.byteLength,
    signed: catalog.signed,
    value: DEFAULT_VALUES[catalog.identifier] ?? 0,
  };
}

export function validateDlt645SimulatorConfig(config) {
  const source = isPlainObject(config) ? config : {};
  const value = normalizeDlt645SimulatorConfig(config);
  for (const field of ['baudRate', 'dataBits', 'stopBits', 'responseDelayMs', 'wakeUpBytes']) {
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
  if (!Number.isInteger(value.responseDelayMs)
    || value.responseDelayMs < 0 || value.responseDelayMs > 10_000) {
    errors.responseDelayMs = '响应延迟必须为 0 到 10000 毫秒。';
  }
  if (!Number.isInteger(value.wakeUpBytes) || value.wakeUpBytes < 0 || value.wakeUpBytes > 16) {
    errors.wakeUpBytes = '响应唤醒字节数量必须为 0 到 16。';
  }
  const addresses = new Set();
  value.meters.forEach((meter, meterIndex) => {
    const prefix = `meters.${meterIndex}`;
    if (!meter.name.trim()) errors[`${prefix}.name`] = '请输入电表名称。';
    if (!/^\d{12}$/.test(meter.address)) errors[`${prefix}.address`] = '电表地址必须是 12 位十进制数字。';
    else if (addresses.has(meter.address)) errors[`${prefix}.address`] = '电表地址不能重复。';
    addresses.add(meter.address);
    const identifiers = new Set();
    meter.tasks.forEach((item, itemIndex) => {
      const itemSource = source.meters?.[meterIndex]?.tasks?.[itemIndex] ?? {};
      for (const field of ['value', 'decimals', 'byteLength']) {
        item[field] = draftNumber(itemSource[field], item[field]);
      }
      const itemPrefix = `${prefix}.tasks.${itemIndex}`;
      if (!item.name.trim()) errors[`${itemPrefix}.name`] = '请输入数据项名称。';
      if (!/^[0-9A-F]{8}$/.test(item.identifier)) {
        errors[`${itemPrefix}.identifier`] = '数据标识必须是 8 位 HEX。';
      } else if (identifiers.has(item.identifier)) {
        errors[`${itemPrefix}.identifier`] = '同一电表的数据标识不能重复。';
      }
      identifiers.add(item.identifier);
      if (!Number.isInteger(item.decimals) || item.decimals < 0 || item.decimals > 12) {
        errors[`${itemPrefix}.decimals`] = '小数位必须为 0 到 12。';
      }
      if (!Number.isInteger(item.byteLength) || item.byteLength < 1 || item.byteLength > 64) {
        errors[`${itemPrefix}.byteLength`] = '数据长度必须为 1 到 64 字节。';
      }
      if (!Number.isFinite(item.value)) {
        errors[`${itemPrefix}.value`] = '模拟值必须是有效数字。';
      } else {
        try {
          encodeDlt645Bcd(item.value, item.decimals, item.byteLength, { signed: item.signed });
        } catch (error) {
          errors[`${itemPrefix}.value`] = error instanceof RangeError
            ? '模拟值超出当前长度或符号范围。'
            : '模拟值配置无效。';
        }
      }
    });
  });
  return errors;
}

function normalizeSimulatorMeter(meter, index) {
  const source = isPlainObject(meter) ? meter : {};
  return {
    id: stringValue(source.id) || `sim-meter-${index + 1}`,
    name: stringValue(source.name) || `模拟电表 ${index + 1}`,
    address: stringValue(source.address),
    enabled: source.enabled !== false,
    tasks: Array.isArray(source.tasks) ? source.tasks.map(normalizeSimulatorItem) : [],
  };
}

function normalizeSimulatorItem(item, index) {
  const source = isPlainObject(item) ? item : {};
  const identifier = stringValue(source.identifier).toUpperCase();
  const catalog = CATALOG_BY_ID.get(identifier);
  return {
    id: stringValue(source.id) || `sim-item-${index + 1}`,
    name: stringValue(source.name) || catalog?.name || `数据项 ${index + 1}`,
    identifier,
    unit: stringValue(source.unit) || catalog?.unit || '',
    decimals: integerValue(source.decimals, catalog?.decimals ?? 0),
    byteLength: integerValue(source.byteLength, catalog?.byteLength ?? 1),
    signed: source.signed ?? catalog?.signed ?? false,
    value: numberValue(source.value, DEFAULT_VALUES[identifier] ?? 0),
    enabled: source.enabled !== false,
  };
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
