import { parseHex } from '@ineed-linklab/codecs/payloadCodec.js';
import {
  MODBUS_AREA_KEYS,
  MAX_MODBUS_AREA_COUNT,
  SUPPORTED_BAUD_RATES,
  normalizeModbusConfig,
  normalizeReceiveFraming,
  normalizeSerialConfig,
  normalizeTcpResilienceConfig,
} from './endpointDraft.js';
import { modbusPointLength } from './modbusDataPoints.js';
import { normalizeWebSocketConfig } from './websocketConfig.js';
import { DLT645_TRANSPORT, normalizeDlt645Config } from './dlt645Config.js';
import {
  DLT645_SLAVE_TRANSPORT,
  createDlt645SimulatorMeter,
  normalizeDlt645SimulatorConfig,
} from './dlt645SimulatorConfig.js';

/**
 * Convert a persisted endpoint into an independent editable form.
 * Temporary WebSocket headers are supplied separately and never read from storage.
 * This module does no I/O, validation, or Vue lifecycle management.
 */
export function createEndpointForm(endpoint = null, websocketHeaders = []) {
  if (!endpoint) return createEmptyEndpointForm();
  const dlt645 = endpoint?.transport === DLT645_SLAVE_TRANSPORT
    ? normalizeDlt645SimulatorConfig(endpoint?.config)
    : normalizeDlt645Config(endpoint?.config);
  const serial = endpoint?.transport?.startsWith('dlt645-')
    ? dlt645 : normalizeSerialConfig(endpoint?.config);
  const tcpResilience = normalizeTcpResilienceConfig(endpoint?.config, endpoint?.transport);
  const receiveFraming = normalizeReceiveFraming(endpoint?.config?.receiveFraming);
  const modbus = normalizeModbusConfig(endpoint?.config, endpoint?.transport);
  const websocket = normalizeWebSocketConfig(endpoint?.config, endpoint?.transport);
  const autoReconnect = endpoint.transport === 'websocket-client'
    ? websocket.autoReconnect
    : modbus.autoReconnect ?? tcpResilience.autoReconnect ?? false;
  const baudRate = Number(serial.baudRate);
  const hasPresetBaudRate = SUPPORTED_BAUD_RATES.includes(baudRate);
  return {
    ...createEmptyEndpointForm(),
    opcuaServerHost: endpoint.config.listenHost ?? '127.0.0.1',
    opcuaServerPort: endpoint.config.listenPort ?? 4840,
    opcuaServerPath: endpoint.config.path ?? '/LinkLab',
    opcuaNamespaceUri: endpoint.config.namespaceUri ?? 'urn:ineedfull:linklab:simulator',
    opcuaEndpointUrl: endpoint.config.endpointUrl ?? 'opc.tcp://127.0.0.1:4840',
    stompUrl: endpoint.config.url ?? 'ws://127.0.0.1:61614/stomp',
    stompListenHost: endpoint.config.listenHost ?? '127.0.0.1',
    stompListenPort: endpoint.config.listenPort ?? 61614,
    stompPath: endpoint.config.path ?? '/stomp',
    websocketUrl: websocket.url,
    websocketListenHost: websocket.listenHost ?? '127.0.0.1',
    websocketListenPort: websocket.listenPort ?? 9000,
    websocketPath: websocket.path ?? '/',
    websocketSubprotocols: websocket.subprotocols.join(', '),
    websocketMessageType: websocket.messageType,
    websocketHeartbeatEnabled: websocket.heartbeat.enabled,
    websocketHeartbeatIntervalMs: websocket.heartbeat.intervalMs,
    websocketHeartbeatTimeoutMs: websocket.heartbeat.timeoutMs,
    websocketHeaders: websocketHeaders.length
      ? websocketHeaders.map(header => ({ ...header }))
      : [{ name: '', value: '' }],
    id: endpoint.id,
    name: endpoint.name,
    transport: endpoint.transport,
    serialPortChoice: serial.path || '__custom__',
    customPath: serial.path,
    baudRateChoice: hasPresetBaudRate ? baudRate : '__custom__',
    customBaudRate: serial.baudRate,
    dataBits: serial.dataBits,
    parity: serial.parity,
    stopBits: serial.stopBits,
    flowControl: serial.flowControl,
    receiveFramingMode: receiveFraming.mode,
    receiveDelimiterHex: formatHexBytes(receiveFraming.delimiterBytes ?? [13, 10]),
    receiveFrameLength: receiveFraming.length ?? 64,
    receiveIdleMs: receiveFraming.idleMs ?? 50,
    keepAlive: tcpResilience.keepAlive.enabled,
    keepAliveInitialDelaySeconds: tcpResilience.keepAlive.initialDelaySeconds,
    autoReconnect,
    host: endpoint.config.host ?? '',
    port: endpoint.config.port ?? 9000,
    listenHost: endpoint.config.listenHost ?? '0.0.0.0',
    listenPort: endpoint.config.listenPort ?? 9000,
    bindHost: endpoint.config.bindHost ?? '0.0.0.0',
    bindPort: endpoint.config.bindPort ?? 9000,
    targetHost: endpoint.config.targetHost ?? '',
    targetPort: endpoint.config.targetPort ?? 9000,
    modbusHost: modbus.host ?? '127.0.0.1',
    modbusPort: modbus.port ?? 502,
    modbusListenHost: modbus.listenHost ?? '0.0.0.0',
    modbusListenPort: modbus.listenPort ?? 502,
    unitId: modbus.unitId,
    timeoutMs: modbus.timeoutMs,
    modbusDescription: modbus.description ?? '',
    modbusEnabled: modbus.enabled !== false,
    modbusRetryCount: modbus.retryCount ?? 0,
    modbusRetryIntervalMs: modbus.retryIntervalMs ?? 200,
    modbusSchedulerAutoStart: modbus.scheduler?.autoStart === true,
    modbusSchedulerMinGapMs: modbus.scheduler?.minGapMs ?? 50,
    addressNotation: modbus.addressNotation,
    byteOrder: modbus.byteOrder,
    wordOrder: modbus.wordOrder,
    modbusDataPoints: (modbus.dataPoints ?? []).map((point) => ({ ...point })),
    dlt645TimeoutMs: dlt645.timeoutMs,
    dlt645MinRequestGapMs: dlt645.minRequestGapMs,
    dlt645WakeUpBytes: dlt645.wakeUpBytes,
    dlt645AutoStart: dlt645.autoStart,
    dlt645ResponseDelayMs: dlt645.responseDelayMs ?? 50,
    dlt645ResponseWakeUpBytes: endpoint?.transport === DLT645_SLAVE_TRANSPORT
      ? dlt645.wakeUpBytes : 0,
    ...areaFormValues(modbus.dataAreas),
  };
}

function createEmptyEndpointForm() {
  return {
    id: '',
    name: '',
    transport: 'serial',
    opcuaServerHost: '127.0.0.1',
    opcuaServerPort: 4840,
    opcuaServerPath: '/LinkLab',
    opcuaNamespaceUri: 'urn:ineedfull:linklab:simulator',
    opcuaEndpointUrl: 'opc.tcp://127.0.0.1:4840',
    stompUrl: 'ws://127.0.0.1:61614/stomp',
    stompListenHost: '127.0.0.1',
    stompListenPort: 61614,
    stompPath: '/stomp',
    websocketUrl: 'ws://127.0.0.1:9000/',
    websocketListenHost: '127.0.0.1',
    websocketListenPort: 9000,
    websocketPath: '/',
    websocketSubprotocols: '',
    websocketMessageType: 'text',
    websocketHeartbeatEnabled: false,
    websocketHeartbeatIntervalMs: 30000,
    websocketHeartbeatTimeoutMs: 10000,
    websocketHeaders: [{ name: '', value: '' }],
    serialPortChoice: '__custom__',
    customPath: '',
    baudRateChoice: 115200,
    customBaudRate: 115200,
    dataBits: 8,
    parity: 'none',
    stopBits: 1,
    flowControl: 'none',
    receiveFramingMode: 'raw',
    receiveDelimiterHex: '0D 0A',
    receiveFrameLength: 64,
    receiveIdleMs: 50,
    keepAlive: true,
    keepAliveInitialDelaySeconds: 30,
    autoReconnect: false,
    host: '127.0.0.1',
    port: 9000,
    listenHost: '0.0.0.0',
    listenPort: 9000,
    bindHost: '0.0.0.0',
    bindPort: 9000,
    targetHost: '',
    targetPort: 9000,
    modbusHost: '127.0.0.1',
    modbusPort: 502,
    modbusListenHost: '0.0.0.0',
    modbusListenPort: 502,
    unitId: 1,
    timeoutMs: 1000,
    modbusDescription: '',
    modbusEnabled: true,
    modbusRetryCount: 0,
    modbusRetryIntervalMs: 200,
    modbusSchedulerAutoStart: false,
    modbusSchedulerMinGapMs: 50,
    addressNotation: 'zero-based',
    byteOrder: 'big-endian',
    wordOrder: 'high-first',
    modbusDataPoints: [],
    dlt645TimeoutMs: 1500,
    dlt645MinRequestGapMs: 200,
    dlt645WakeUpBytes: 4,
    dlt645AutoStart: false,
    dlt645ResponseDelayMs: 50,
    dlt645ResponseWakeUpBytes: 0,
    ...areaFormValues(),
  };
}

/** Build a save candidate while preserving protocol settings edited in other panels. */
export function buildEndpointConfig(form, endpoint = null) {
  switch (form.transport) {
    case 'opcua-server':
      return {
        ...endpoint?.config,
        listenHost: form.opcuaServerHost,
        listenPort: Number(form.opcuaServerPort),
        path: form.opcuaServerPath.trim(),
        namespaceUri: form.opcuaNamespaceUri.trim(),
      };
    case 'opcua-client':
      return { ...endpoint?.config, endpointUrl: form.opcuaEndpointUrl.trim() };
    case 'stomp-client':
      return { ...endpoint?.config, url: form.stompUrl.trim() };
    case 'stomp-server':
      return {
        ...endpoint?.config,
        listenHost: form.stompListenHost.trim(),
        listenPort: Number(form.stompListenPort),
        path: form.stompPath.trim(),
      };
    case 'websocket-client':
    case 'websocket-server':
      return {
        ...buildWebSocketConnectionFields(form),
        subprotocols: form.websocketSubprotocols.split(',').map(value => value.trim()).filter(Boolean),
        messageType: form.websocketMessageType,
        heartbeat: {
          enabled: Boolean(form.websocketHeartbeatEnabled),
          intervalMs: Number(form.websocketHeartbeatIntervalMs),
          timeoutMs: Number(form.websocketHeartbeatTimeoutMs),
        },
      };
    case 'serial':
      return {
        ...buildSerialConnectionFields(form),
        receiveFraming: buildReceiveFramingConfig(form),
      };
    case DLT645_TRANSPORT: {
      const existing = normalizeDlt645Config(endpoint?.config);
      return {
        ...existing,
        ...buildSerialConnectionFields(form),
        receiveFraming: { mode: 'raw' },
        timeoutMs: Number(form.dlt645TimeoutMs),
        minRequestGapMs: Number(form.dlt645MinRequestGapMs),
        wakeUpBytes: Number(form.dlt645WakeUpBytes),
        autoStart: Boolean(form.dlt645AutoStart),
      };
    }
    case DLT645_SLAVE_TRANSPORT: {
      const existing = normalizeDlt645SimulatorConfig(endpoint?.config);
      return {
        ...existing,
        ...buildSerialConnectionFields(form),
        receiveFraming: { mode: 'raw' },
        responseDelayMs: Number(form.dlt645ResponseDelayMs),
        wakeUpBytes: Number(form.dlt645ResponseWakeUpBytes),
        meters: endpoint ? existing.meters : [createDlt645SimulatorMeter(1)],
      };
    }
    case 'tcp-client':
      return {
        host: form.host.trim(),
        port: Number(form.port),
        receiveFraming: buildReceiveFramingConfig(form),
        keepAlive: {
          enabled: Boolean(form.keepAlive),
          initialDelaySeconds: Number(form.keepAliveInitialDelaySeconds),
        },
        autoReconnect: Boolean(form.autoReconnect),
      };
    case 'tcp-server':
      return {
        listenHost: form.listenHost.trim(),
        listenPort: Number(form.listenPort),
        receiveFraming: buildReceiveFramingConfig(form),
        keepAlive: {
          enabled: Boolean(form.keepAlive),
          initialDelaySeconds: Number(form.keepAliveInitialDelaySeconds),
        },
      };
    case 'udp-client':
      return {
        bindHost: form.bindHost.trim(),
        bindPort: Number(form.bindPort),
        targetHost: form.targetHost.trim(),
        targetPort: Number(form.targetPort),
      };
    case 'udp-server': {
      const config = {
        bindHost: form.bindHost.trim(),
        bindPort: Number(form.bindPort),
      };
      if (form.targetHost.trim()) {
        config.targetHost = form.targetHost.trim();
        config.targetPort = Number(form.targetPort);
      }
      return config;
    }
    case 'modbus-tcp-master':
    case 'modbus-tcp-slave':
    case 'modbus-rtu-master':
    case 'modbus-rtu-slave':
      return buildModbusEndpointConfig(form, endpoint);
    default:
      return {};
  }
}

function buildWebSocketConnectionFields(form) {
  if (form.transport === 'websocket-client') {
    return { url: form.websocketUrl.trim(), autoReconnect: Boolean(form.autoReconnect) };
  }
  return {
    listenHost: form.websocketListenHost.trim(),
    listenPort: Number(form.websocketListenPort),
    path: form.websocketPath.trim(),
  };
}

function buildModbusEndpointConfig(form, endpoint) {
  const isMaster = form.transport.endsWith('-master');
  const config = {
    ...(isMaster ? (endpoint?.config ?? {}) : {}),
    unitId: Number(form.unitId),
    timeoutMs: Number(form.timeoutMs),
    addressNotation: form.addressNotation,
    byteOrder: form.byteOrder,
    wordOrder: form.wordOrder,
    ...buildModbusConnectionFields(form),
  };
  if (isMaster) {
    const normalizedMaster = normalizeModbusConfig(
      endpoint?.config,
      endpoint?.transport,
    );
    Object.assign(config, {
      configVersion: 3,
      description: form.modbusDescription.trim(),
      enabled: Boolean(form.modbusEnabled),
      retryCount: Number(form.modbusRetryCount),
      retryIntervalMs: Number(form.modbusRetryIntervalMs),
      autoReconnect: Boolean(form.autoReconnect),
      scheduler: {
        autoStart: Boolean(form.modbusSchedulerAutoStart),
        minGapMs: Number(form.modbusSchedulerMinGapMs),
      },
      requestGroups: normalizedMaster.requestGroups,
      writeCommands: normalizedMaster.writeCommands,
    });
  } else {
    config.dataAreas = buildModbusDataAreas(form, endpoint);
    config.dataPoints = form.modbusDataPoints.map((point) => ({
      ...point,
      address: Number(point.address),
      length: modbusPointLength(point.dataType, point.length),
      scale: Number(point.scale),
      offset: Number(point.offset),
    }));
  }
  return config;
}

function buildSerialConnectionFields(form) {
  const path = form.serialPortChoice === '__custom__' ? form.customPath : form.serialPortChoice;
  const baudRate = form.baudRateChoice === '__custom__' ? form.customBaudRate : form.baudRateChoice;
  return {
    path: path.trim(),
    baudRate: Number(baudRate),
    dataBits: Number(form.dataBits),
    parity: form.parity,
    stopBits: Number(form.stopBits),
    flowControl: form.flowControl,
  };
}

function buildModbusConnectionFields(form) {
  if (form.transport.startsWith('modbus-rtu-')) return buildSerialConnectionFields(form);
  if (form.transport.endsWith('-master')) {
    return { host: form.modbusHost.trim(), port: Number(form.modbusPort) };
  }
  return { listenHost: form.modbusListenHost.trim(), listenPort: Number(form.modbusListenPort) };
}

function areaFormValues(dataAreas = {}) {
  return Object.fromEntries(MODBUS_AREA_KEYS.flatMap((key) => {
    const area = dataAreas?.[key] ?? {};
    const prefix = `${key[0].toUpperCase()}${key.slice(1)}`;
    return [
      [`modbus${prefix}Start`, area.start ?? 0],
      [`modbus${prefix}Count`, area.count ?? 100],
    ];
  }));
}

function buildModbusDataAreas(form, endpoint) {
  const existing = normalizeModbusConfig(endpoint?.config, endpoint?.transport).dataAreas;
  return Object.fromEntries(MODBUS_AREA_KEYS.map((key) => {
    const prefix = `${key[0].toUpperCase()}${key.slice(1)}`;
    const start = Number(form[`modbus${prefix}Start`]);
    const count = Number(form[`modbus${prefix}Count`]);
    // Keep invalid counts for validation without allocating from untrusted input.
    const valueCount = Number.isInteger(count) && count >= 1 && count <= MAX_MODBUS_AREA_COUNT ? count : 0;
    const values = (existing?.[key]?.values ?? []).slice(0, valueCount);
    const fallback = key === 'coils' || key === 'discreteInputs' ? false : 0;
    while (values.length < valueCount) values.push(fallback);
    return [key, { start, count, values }];
  }));
}

function buildReceiveFramingConfig(form) {
  switch (form.receiveFramingMode) {
    case 'delimiter': {
      const bytes = parseHex(form.receiveDelimiterHex);
      if (bytes.length === 0) throw new TypeError('delimiter must not be empty');
      return { mode: 'delimiter',
    delimiterBytes: [...bytes] };
    }
    case 'fixed':
      return { mode: 'fixed',
    length: Number(form.receiveFrameLength) };
    case 'idle':
      return { mode: 'idle',
    idleMs: Number(form.receiveIdleMs) };
    default:
      return { mode: 'raw' };
  }
}

function formatHexBytes(bytes) {
  return Array.from(bytes, (byte) => Number(byte).toString(16).padStart(2, '0').toUpperCase()).join(' ');
}
