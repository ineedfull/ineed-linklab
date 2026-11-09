import { safeOpcuaServerConfig } from './opcuaSimulatorConfig.js';
import { validateWebSocketConfig, safeWebSocketAddress } from './websocketConfig.js';
import {
  normalizeModbusDataPoints,
  validateModbusDataPoints,
} from './modbusDataPoints.js';
import {
  normalizeModbusMasterConfig,
  validateModbusMasterSettings,
} from './modbusMasterConfig.js';
import { DLT645_TRANSPORT, validateDlt645Config } from './dlt645Config.js';
import {
  DLT645_SLAVE_TRANSPORT,
  validateDlt645SimulatorConfig,
} from './dlt645SimulatorConfig.js';

const MIN_PORT = 1;
const MAX_PORT = 65535;
const MAX_ENDPOINT_NAME_LENGTH = 80;
const endpointNameSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export const MAX_RECEIVE_FRAME_LENGTH = 1024 * 1024;
export const MAX_RECEIVE_IDLE_MS = 60_000;
export const MAX_SERIAL_BAUD_RATE = 0xffff_ffff;
export const MIN_TCP_KEEP_ALIVE_DELAY_SECONDS = 1;
export const MAX_TCP_KEEP_ALIVE_DELAY_SECONDS = 3600;
export const DEFAULT_TCP_KEEP_ALIVE_DELAY_SECONDS = 30;
export const DEFAULT_MODBUS_PORT = 502;
export const DEFAULT_MODBUS_TIMEOUT_MS = 1000;
export const DEFAULT_MODBUS_AREA_COUNT = 100;
export const MAX_MODBUS_AREA_COUNT = 10_000;

export const MODBUS_TRANSPORTS = Object.freeze([
  'modbus-tcp-master', 'modbus-tcp-slave',
  'modbus-rtu-master', 'modbus-rtu-slave',
]);

export const MODBUS_AREA_KEYS = Object.freeze([
  'coils', 'discreteInputs', 'holdingRegisters', 'inputRegisters',
]);

export const SUPPORTED_BAUD_RATES = Object.freeze([
  300, 600, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400,
  460800, 921600,
]);

const supportedDataBits = new Set([5, 6, 7, 8]);
const supportedParity = new Set(['none', 'even', 'odd', 'mark', 'space']);
const supportedStopBits = new Set([1, 1.5, 2]);
const supportedFlowControl = new Set(['none', 'hardware', 'software']);
const supportedTransports = new Set([
  'serial', 'tcp-client', 'tcp-server', 'udp-client', 'udp-server', 'websocket-client', 'websocket-server',
  DLT645_TRANSPORT,
  DLT645_SLAVE_TRANSPORT,
  'opcua-client', 'opcua-server', 'stomp-client', 'stomp-server',
  ...MODBUS_TRANSPORTS,
]);

export function validateEndpointDraft(draft) {
  if (!supportedTransports.has(draft?.transport)) {
    return { transport: '请选择支持的传输类型。' };
  }

  const config = isPlainObject(draft.config) ? draft.config : {};
  switch (draft.transport) {
    case 'opcua-server': {
      try { safeOpcuaServerConfig(config); return {}; }
      catch (error) {
        const field = /监听地址/.test(error.message) ? 'listenHost' : /端口/.test(error.message) ? 'listenPort' : /路径/.test(error.message) ? 'path' : 'namespaceUri';
        return { [field]: error.message };
      }
    }
    case 'opcua-client': {
      let url; try { url = new URL(config.endpointUrl); } catch { return { endpointUrl: '请输入有效的 opc.tcp 地址。' }; }
      return url.protocol === 'opc.tcp:' && url.hostname && !url.username && !url.password && !url.search && !url.hash
        ? {} : { endpointUrl: '连接地址必须为不含凭据的 opc.tcp 地址。' };
    }
    case 'stomp-client': {
      let url; try { url = new URL(config.url); } catch { return { url: '请输入有效的 ws/wss 地址。' }; }
      return ['ws:', 'wss:'].includes(url.protocol) && url.hostname && !url.username && !url.password && !url.search && !url.hash
        ? {} : { url: '连接地址不能包含凭据、查询或片段。' };
    }
    case 'stomp-server':
      return { ...validateHostAndPort(config, 'listenHost', 'listenPort', '监听地址', '监听端口'),
        ...(typeof config.path === 'string' && config.path.startsWith('/') && !/[\0\r\n?#]/.test(config.path) ? {} : { path: '请输入以 / 开头的监听路径。' }) };
    case 'websocket-client':
    case 'websocket-server':
      return validateWebSocketConfig(config, draft.transport);
    case 'serial':
      return validateSerial(normalizeSerialConfig(config), config);
    case DLT645_TRANSPORT:
      return validateDlt645Config(config);
    case DLT645_SLAVE_TRANSPORT:
      return validateDlt645SimulatorConfig(config);
    case 'tcp-client':
      return {
        ...validateHostAndPort(config, 'host', 'port', '服务器地址', '服务器端口'),
        ...validateReceiveFraming(config),
        ...validateTcpResilience(config, true),
      };
    case 'tcp-server':
      return {
        ...validateHostAndPort(
          config,
          'listenHost',
          'listenPort',
          '监听地址',
          '监听端口',
        ),
        ...validateReceiveFraming(config),
        ...validateTcpResilience(config, false),
      };
    case 'udp-client':
      return validateUdp(config, true);
    case 'udp-server':
      return validateUdp(config, hasDefaultTarget(config));
    case 'modbus-tcp-master':
    case 'modbus-tcp-slave':
    case 'modbus-rtu-master':
    case 'modbus-rtu-slave':
      return validateModbus(config, draft.transport);
    default:
      return {};
  }
}

function validateSerial(config, source) {
  const errors = {};
  if (!isNonblankString(config.path)) errors.path = '请选择或输入串口。';
  if (!isBoundedPositiveInteger(config.baudRate, MAX_SERIAL_BAUD_RATE)) {
    errors.baudRate = '波特率必须为 1 到 4294967295 的整数。';
  }
  if (!supportedDataBits.has(config.dataBits)) {
    errors.dataBits = '数据位必须为 5、6、7 或 8。';
  }
  if (!supportedParity.has(config.parity)) errors.parity = '请选择有效的校验位。';
  if (!supportedStopBits.has(config.stopBits)) {
    errors.stopBits = '停止位必须为 1、1.5 或 2。';
  }
  if (!supportedFlowControl.has(config.flowControl)) {
    errors.flowControl = '请选择有效的流控方式。';
  }
  Object.assign(errors, validateReceiveFraming(source));
  return errors;
}

function validateReceiveFraming(config) {
  if (!Object.hasOwn(config, 'receiveFraming')) return {};
  const receiveFraming = config.receiveFraming;
  if (!isPlainObject(receiveFraming)) {
    return { receiveFraming: '接收分帧配置格式无效。' };
  }
  switch (receiveFraming?.mode) {
    case 'raw':
      return validateFramingKeys(receiveFraming, ['mode']);
    case 'delimiter':
      if (hasUnexpectedKeys(receiveFraming, ['mode', 'delimiterBytes'])) {
        return { receiveFraming: '接收分帧配置格式无效。' };
      }
      return isByteArray(receiveFraming.delimiterBytes)
        ? {}
        : { delimiterBytes: '分隔符必须是非空的 HEX 字节序列。' };
    case 'fixed':
      if (hasUnexpectedKeys(receiveFraming, ['mode', 'length'])) {
        return { receiveFraming: '接收分帧配置格式无效。' };
      }
      return isBoundedPositiveInteger(receiveFraming.length, MAX_RECEIVE_FRAME_LENGTH)
        ? {}
        : { receiveFrameLength: `固定长度必须为 1 到 ${MAX_RECEIVE_FRAME_LENGTH} 的整数。` };
    case 'idle':
      if (hasUnexpectedKeys(receiveFraming, ['mode', 'idleMs'])) {
        return { receiveFraming: '接收分帧配置格式无效。' };
      }
      return isBoundedPositiveInteger(receiveFraming.idleMs, MAX_RECEIVE_IDLE_MS)
        ? {}
        : { receiveIdleMs: `空闲毫秒必须为 1 到 ${MAX_RECEIVE_IDLE_MS} 的整数。` };
    default:
      return { receiveFraming: '请选择有效的接收分帧方式。' };
  }
}

function validateFramingKeys(receiveFraming, keys) {
  return hasUnexpectedKeys(receiveFraming, keys)
    ? { receiveFraming: '接收分帧配置格式无效。' }
    : {};
}

function validateTcpResilience(config, allowAutoReconnect) {
  const errors = {};
  if (Object.hasOwn(config, 'keepAlive')) {
    const value = config.keepAlive;
    if (!isPlainObject(value)
      || hasUnexpectedKeys(value, ['enabled', 'initialDelaySeconds'])
      || typeof value.enabled !== 'boolean') {
      errors.keepAlive = 'TCP Keepalive 配置格式无效。';
    } else if (!isBoundedPositiveInteger(
      value.initialDelaySeconds,
      MAX_TCP_KEEP_ALIVE_DELAY_SECONDS,
    )) {
      errors.keepAliveInitialDelaySeconds =
        '首次探测延迟必须为 1 到 3600 的整数秒。';
    }
  }
  if (Object.hasOwn(config, 'autoReconnect')) {
    if (!allowAutoReconnect) errors.autoReconnect = 'TCP 服务端不支持自动重连。';
    else if (typeof config.autoReconnect !== 'boolean') {
      errors.autoReconnect = '自动重连必须为布尔值。';
    }
  }
  return errors;
}

function hasUnexpectedKeys(value, expectedKeys) {
  const expected = new Set(expectedKeys);
  return Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !expected.has(key));
}

export function normalizeSerialConfig(config = {}) {
  const source = isPlainObject(config) ? config : {};
  return {
    path: source.path ?? source.portName ?? '',
    baudRate: source.baudRate ?? 115200,
    dataBits: source.dataBits ?? 8,
    parity: source.parity ?? 'none',
    stopBits: source.stopBits ?? 1,
    flowControl: source.flowControl ?? 'none',
    receiveFraming: normalizeReceiveFraming(source.receiveFraming),
  };
}

export function normalizeReceiveFraming(receiveFraming) {
  if (!isPlainObject(receiveFraming)) return { mode: 'raw' };
  switch (receiveFraming.mode) {
    case 'raw':
      return { mode: 'raw' };
    case 'delimiter':
      return {
        mode: 'delimiter',
        delimiterBytes: Array.isArray(receiveFraming.delimiterBytes)
          ? [...receiveFraming.delimiterBytes]
          : receiveFraming.delimiterBytes,
      };
    case 'fixed':
      return { mode: 'fixed', length: receiveFraming.length };
    case 'idle':
      return { mode: 'idle', idleMs: receiveFraming.idleMs };
    default:
      return { mode: receiveFraming.mode };
  }
}

export function normalizeTcpResilienceConfig(config = {}, transport = 'tcp-client') {
  const source = isPlainObject(config) ? config : {};
  const keepAlive = isPlainObject(source.keepAlive) ? source.keepAlive : {};
  return {
    keepAlive: {
      enabled: keepAlive.enabled ?? true,
      initialDelaySeconds:
        keepAlive.initialDelaySeconds ?? DEFAULT_TCP_KEEP_ALIVE_DELAY_SECONDS,
    },
    ...(['tcp-client', 'modbus-tcp-master', 'websocket-client'].includes(transport)
      ? { autoReconnect: source.autoReconnect ?? false }
      : {}),
  };
}

export function isModbusTransport(transport) {
  return MODBUS_TRANSPORTS.includes(transport);
}

export function isModbusMasterTransport(transport) {
  return transport === 'modbus-tcp-master' || transport === 'modbus-rtu-master';
}

export function normalizeModbusConfig(config = {}, transport = 'modbus-tcp-master') {
  const source = isPlainObject(config) ? config : {};
  const serial = normalizeSerialConfig(source);
  const normalized = {
    unitId: source.unitId ?? 1,
    timeoutMs: source.timeoutMs ?? DEFAULT_MODBUS_TIMEOUT_MS,
    addressNotation: source.addressNotation ?? 'zero-based',
    byteOrder: source.byteOrder ?? 'big-endian',
    wordOrder: source.wordOrder ?? 'high-first',
  };
  if (transport.startsWith('modbus-tcp-')) {
    Object.assign(normalized, transport.endsWith('-master') ? {
      host: source.host ?? '127.0.0.1',
      port: source.port ?? DEFAULT_MODBUS_PORT,
    } : {
      listenHost: source.listenHost ?? '0.0.0.0',
      listenPort: source.listenPort ?? DEFAULT_MODBUS_PORT,
    });
  } else {
    Object.assign(normalized, {
      path: serial.path,
      baudRate: source.baudRate ?? 9600,
      dataBits: serial.dataBits,
      parity: serial.parity,
      stopBits: serial.stopBits,
      flowControl: serial.flowControl,
    });
  }
  if (transport.endsWith('-master')) {
    return { ...normalizeModbusMasterConfig(source), ...normalized };
  }
  if (transport.endsWith('-slave')) {
    normalized.dataAreas = normalizeModbusDataAreas(source.dataAreas);
    normalized.dataPoints = normalizeModbusDataPoints(source.dataPoints);
  }
  return normalized;
}

export function normalizeModbusDataAreas(dataAreas = {}) {
  const source = isPlainObject(dataAreas) ? dataAreas : {};
  return Object.fromEntries(MODBUS_AREA_KEYS.map((key) => {
    const area = isPlainObject(source[key]) ? source[key] : {};
    const start = Number.isInteger(area.start) ? area.start : 0;
    const count = Number.isInteger(area.count) ? area.count : DEFAULT_MODBUS_AREA_COUNT;
    const bitArea = key === 'coils' || key === 'discreteInputs';
    // Normalization runs before validation, including on imported workspace data.
    // Preserve an oversized count for the validator, but never allocate from it.
    const valueCount = count >= 1 && count <= MAX_MODBUS_AREA_COUNT ? count : 0;
    const values = Array.isArray(area.values)
      ? area.values.slice(0, valueCount).map((value) => (
        bitArea ? Boolean(value) : clampModbusWord(value)
      ))
      : [];
    while (values.length < valueCount) values.push(bitArea ? false : 0);
    return [key, { start, count, values }];
  }));
}

function validateModbus(config, transport) {
  const normalized = normalizeModbusConfig(config, transport);
  const errors = {};
  if (!Number.isInteger(normalized.unitId) || normalized.unitId < 1 || normalized.unitId > 247) {
    errors.unitId = '站号必须为 1 到 247 的整数。';
  }
  if (!Number.isInteger(normalized.timeoutMs)
    || normalized.timeoutMs < 50 || normalized.timeoutMs > 60_000) {
    errors.timeoutMs = '超时时间必须为 50 到 60000 毫秒的整数。';
  }
  if (!['zero-based', 'reference'].includes(normalized.addressNotation)) {
    errors.addressNotation = '请选择有效的地址显示方式。';
  }
  if (!['big-endian', 'little-endian'].includes(normalized.byteOrder)) {
    errors.byteOrder = '请选择有效的字节序。';
  }
  if (!['high-first', 'low-first'].includes(normalized.wordOrder)) {
    errors.wordOrder = '请选择有效的字序。';
  }
  if (transport.startsWith('modbus-tcp-')) {
    Object.assign(errors, transport.endsWith('-master')
      ? validateHostAndPort(normalized, 'host', 'port', '从站地址', '从站端口')
      : validateHostAndPort(normalized, 'listenHost', 'listenPort', '监听地址', '监听端口'));
  } else {
    Object.assign(errors, validateSerial(normalized, normalized));
    delete errors.receiveFraming;
    if (!['none', 'even', 'odd'].includes(normalized.parity)) {
      errors.parity = 'Modbus RTU 校验位仅支持 None、Even 或 Odd。';
    }
    if (![1, 2].includes(normalized.stopBits)) {
      errors.stopBits = 'Modbus RTU 停止位仅支持 1 或 2。';
    }
  }
  if (transport.endsWith('-slave')) {
    const sourceAreas = isPlainObject(config.dataAreas) ? config.dataAreas : {};
    if (Object.hasOwn(config, 'dataAreas') && !isPlainObject(config.dataAreas)) {
      errors.dataAreas = '从站数据区配置格式无效。';
    }
    for (const key of MODBUS_AREA_KEYS) {
      const area = normalized.dataAreas[key];
      const sourceArea = sourceAreas[key];
      if ((sourceArea?.start !== undefined && !Number.isInteger(sourceArea.start))
        || !Number.isInteger(area.start) || area.start < 0 || area.start > 65_535) {
        errors[`${key}Start`] = '起始地址必须为 0 到 65535 的整数。';
      }
      if ((sourceArea?.count !== undefined && !Number.isInteger(sourceArea.count))
        || !Number.isInteger(area.count) || area.count < 1 || area.count > MAX_MODBUS_AREA_COUNT
        || area.start + area.count > 65_536) {
        errors[`${key}Count`] = `数量必须为 1 到 ${MAX_MODBUS_AREA_COUNT}，且地址不能超过 65535。`;
      }
      if (sourceArea !== undefined && !isPlainObject(sourceArea)) {
        errors[`${key}Values`] = '数据区配置格式无效。';
      } else if (Array.isArray(sourceArea?.values)) {
        const bitArea = key === 'coils' || key === 'discreteInputs';
        const invalid = sourceArea.values.some((value) => (bitArea
          ? !(typeof value === 'boolean' || value === 0 || value === 1)
          : !Number.isInteger(value) || value < 0 || value > 65_535));
        if (invalid || sourceArea.values.length > area.count) {
          errors[`${key}Values`] = bitArea
            ? '位数据只能为 true、false、0 或 1，且不能超过配置数量。'
            : '寄存器数据必须为 0 到 65535 的整数，且不能超过配置数量。';
        }
      }
    }
    Object.assign(errors, validateModbusDataPoints(config.dataPoints, normalized.dataAreas));
  } else {
    Object.assign(errors, validateModbusMasterSettings(config));
  }
  return errors;
}

function clampModbusWord(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 65_535 ? number : 0;
}

export function normalizeSerialPorts(ports) {
  const seen = new Set();
  const result = [];
  for (const candidate of Array.isArray(ports) ? ports : []) {
    const path = typeof candidate === 'string'
      ? candidate
      : candidate?.path ?? candidate?.name;
    if (!isNonblankString(path) || seen.has(path)) continue;
    seen.add(path);
    const preferredLabel = typeof candidate === 'object'
      ? candidate.label ?? (candidate.manufacturer ? `${path} - ${candidate.manufacturer}` : path)
      : path;
    result.push({ path, label: isNonblankString(preferredLabel) ? preferredLabel : path });
  }
  return result;
}

export function generateEndpointName(draft, existingNames = []) {
  const config = isPlainObject(draft?.config) ? draft.config : {};
  let rawName;

  switch (draft?.transport) {
    case 'opcua-server': rawName = `OPCUA_SERVER_${namePart(config.listenPort)}`; break;
    case 'opcua-client': rawName = 'OPCUA_CLIENT'; break;
    case 'stomp-client': rawName = 'STOMP_CLIENT'; break;
    case 'stomp-server': rawName = `STOMP_SERVER_${namePart(config.listenPort)}`; break;
    case 'websocket-client': {
      let address;
      try { address = new URL(safeWebSocketAddress(config.url)); } catch { rawName = 'WS_CLIENT'; break; }
      rawName = `WS_CLIENT_${address.hostname}_${address.port || (address.protocol === 'wss:' ? 443 : 80)}`;
      break;
    }
    case 'websocket-server':
      rawName = `WS_SERVER_${namePart(config.listenPort)}`;
      break;
    case 'serial':
      rawName = `SERIAL_${finalPathSegment(config.path ?? config.portName ?? '')}`;
      break;
    case 'tcp-client':
      rawName = `TCP_CLIENT_${namePart(config.host)}_${namePart(config.port)}`;
      break;
    case 'tcp-server':
      rawName = `TCP_SERVER_${namePart(config.listenPort)}`;
      break;
    case 'udp-client':
      rawName = `UDP_CLIENT_${namePart(config.targetHost)}_${namePart(config.targetPort)}`;
      break;
    case 'udp-server':
      rawName = `UDP_SERVER_${namePart(config.bindPort)}`;
      break;
    case DLT645_TRANSPORT:
      rawName = `DLT645_${finalPathSegment(config.path ?? '')}`;
      break;
    case DLT645_SLAVE_TRANSPORT:
      rawName = `DLT645_SIMULATOR_${finalPathSegment(config.path ?? '')}`;
      break;
    case 'modbus-tcp-master':
      rawName = `MODBUS_TCP_MASTER_${namePart(config.host)}_${namePart(config.port)}`;
      break;
    case 'modbus-tcp-slave':
      rawName = `MODBUS_TCP_SLAVE_${namePart(config.listenPort)}`;
      break;
    case 'modbus-rtu-master':
      rawName = `MODBUS_RTU_MASTER_${finalPathSegment(config.path ?? '')}`;
      break;
    case 'modbus-rtu-slave':
      rawName = `MODBUS_RTU_SLAVE_${finalPathSegment(config.path ?? '')}`;
      break;
    default:
      rawName = 'ENDPOINT';
  }

  const baseName = normalizeEndpointName(rawName) || 'ENDPOINT';
  const usedNames = new Set(
    (Array.isArray(existingNames) ? existingNames : [])
      .filter((name) => typeof name === 'string')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  if (!usedNames.has(baseName.toLowerCase())) return baseName;

  for (let index = 2; ; index += 1) {
    const suffix = `_${index}`;
    const root = truncateEndpointName(baseName, MAX_ENDPOINT_NAME_LENGTH - suffix.length)
      .replace(/[_-]+$/g, '');
    const candidate = `${root}${suffix}`;
    if (!usedNames.has(candidate.toLowerCase())) return candidate;
  }
}

function finalPathSegment(path) {
  return namePart(path).replace(/[\\/]+$/g, '').split(/[\\/]/).pop();
}

function namePart(value) {
  return value === undefined || value === null ? '' : String(value);
}

function normalizeEndpointName(name) {
  const normalized = name
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N}_.-]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');
  return truncateEndpointName(normalized, MAX_ENDPOINT_NAME_LENGTH)
    .replace(/[_-]+$/g, '');
}

function truncateEndpointName(name, maximumLength) {
  let result = '';
  let length = 0;
  for (const { segment } of endpointNameSegmenter.segment(name)) {
    if (length >= maximumLength) break;
    result += segment;
    length += 1;
  }
  return result;
}

function validateHostAndPort(config, hostField, portField, hostLabel = '地址', portLabel = '端口') {
  const errors = {};
  if (!isNonblankString(config[hostField])) errors[hostField] = `请输入${hostLabel}。`;
  if (!isPort(config[portField])) {
    errors[portField] = `${portLabel}必须为 ${MIN_PORT} 到 ${MAX_PORT} 的整数。`;
  }
  return errors;
}

function validateUdp(config, requireTarget) {
  return {
    ...validateHostAndPort(config, 'bindHost', 'bindPort', '本地绑定地址', '本地绑定端口'),
    ...(requireTarget
      ? validateHostAndPort(
        config,
        'targetHost',
        'targetPort',
        '默认目标地址',
        '默认目标端口',
      )
      : {}),
  };
}

function hasDefaultTarget(config) {
  return config.targetHost !== undefined || config.targetPort !== undefined;
}

function isNonblankString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isPort(value) {
  return Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT;
}

function isByteArray(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255);
}

function isBoundedPositiveInteger(value, maximum) {
  return Number.isInteger(value) && value >= 1 && value <= maximum;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
