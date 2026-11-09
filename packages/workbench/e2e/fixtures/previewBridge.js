(() => {
  const runtimeByOrigin = {
    'http://127.0.0.1:4173': 'electron',
    'http://127.0.0.1:4174': 'tauri',
  };
  const previewRuntime = runtimeByOrigin[globalThis.location.origin];
  if (!previewRuntime) return;

  const acceptanceExports = [];
  globalThis.__INEED_PREVIEW_ACCEPTANCE_EXPORTS__ = acceptanceExports;
  let opcuaProfiles = [];
  let opcuaServerProfiles = [];
  const opcuaExecute = async request => {
    if (request.action === 'serverProfiles') return { profiles: structuredClone(opcuaServerProfiles) };
    if (request.action === 'saveServerProfiles') { opcuaServerProfiles = structuredClone(request.profiles); return {}; }
    if (request.action === 'profiles') return { profiles: structuredClone(opcuaProfiles) };
    if (request.action === 'saveProfiles') { opcuaProfiles = structuredClone(request.profiles); return {}; }
    if (request.action === 'export') {
      if (request.fileName.startsWith('linklab-acceptance-') || request.fileName === 'linklab-device-template.json') acceptanceExports.push(structuredClone(request));
      return { saved: true };
    }
    return {};
  };

  const FIXED_TIME = Date.parse('2026-07-13T04:00:00.000Z');
  const endpoints = [
    {
      id: 'serial-sensor', name: '串口传感器', transport: 'serial',
      config: {
        path: '/dev/tty.usbserial-DEV', baudRate: 115200, dataBits: 8,
        parity: 'none', stopBits: 1, flowControl: 'none',
        receiveFraming: { mode: 'raw' },
      },
    },
    {
      id: 'tcp-client-cloud', name: '云端TCP客户端', transport: 'tcp-client',
      config: {
        host: '192.0.2.20', port: 9100,
        keepAlive: { enabled: true, initialDelaySeconds: 30 },
        autoReconnect: true,
      },
    },
    {
      id: 'tcp-server-local', name: '本地调试服务', transport: 'tcp-server',
      config: { listenHost: '127.0.0.1', listenPort: 9000 },
    },
    {
      id: 'udp-client-telemetry', name: 'UDP遥测发送', transport: 'udp-client',
      config: {
        bindHost: '0.0.0.0', bindPort: 9201,
        targetHost: '198.51.100.8', targetPort: 9200,
      },
    },
    {
      id: 'udp-server-events', name: 'UDP事件监听', transport: 'udp-server',
      config: { bindHost: '0.0.0.0', bindPort: 9300 },
    },
    {
      id: 'dlt645-meter-bus', name: '厂区电表', transport: 'dlt645-master',
      config: {
        path: '/dev/tty.usbserial-DEV', baudRate: 2400, dataBits: 8,
        parity: 'even', stopBits: 1, flowControl: 'none', receiveFraming: { mode: 'raw' },
        timeoutMs: 1500, minRequestGapMs: 200, wakeUpBytes: 4, autoStart: false,
        meters: [{
          id: 'incoming-meter', name: '进线总表', address: '123456789012', enabled: true,
          tasks: [{
            id: 'voltage-a', name: 'A 相电压', identifier: '02010100',
            unit: 'V', decimals: 1, byteLength: 2, pollIntervalMs: 5000, enabled: true,
          }],
        }],
      },
    },
    {
      id: 'dlt645-meter-simulator', name: 'DL/T 645 模拟电表', transport: 'dlt645-slave',
      config: {
        path: '/dev/tty.usbserial-SIM', baudRate: 2400, dataBits: 8,
        parity: 'even', stopBits: 1, flowControl: 'none', receiveFraming: { mode: 'raw' },
        responseDelayMs: 0, wakeUpBytes: 0,
        meters: [{
          id: 'simulated-meter', name: '三相智能电表', address: '123456789012', enabled: true,
          tasks: [{
            id: 'simulated-energy', name: '组合有功总电能', identifier: '00000000',
            unit: 'kWh', decimals: 2, byteLength: 4, signed: false, value: 12345.67, enabled: true,
          }, {
            id: 'simulated-voltage-a', name: 'A 相电压', identifier: '02010100',
            unit: 'V', decimals: 1, byteLength: 2, signed: false, value: 230.1, enabled: true,
          }, {
            id: 'simulated-current-a', name: 'A 相电流', identifier: '02020100',
            unit: 'A', decimals: 3, byteLength: 3, signed: false, value: 5.125, enabled: true,
          }, {
            id: 'simulated-power', name: '瞬时总有功功率', identifier: '02030000',
            unit: 'kW', decimals: 4, byteLength: 3, signed: true, value: 3.4821, enabled: true,
          }, {
            id: 'simulated-factor', name: '总功率因数', identifier: '02060000',
            unit: '', decimals: 3, byteLength: 2, signed: true, value: 0.968, enabled: true,
          }],
        }],
      },
    },
    {
      id: 'modbus-master', name: '锅炉主站', transport: 'modbus-tcp-master',
      config: {
        configVersion: 3,
        host: '127.0.0.1', port: 1502, unitId: 1, timeoutMs: 1000,
        addressNotation: 'zero-based', byteOrder: 'big-endian', wordOrder: 'high-first',
        description: '锅炉房多区域采集', enabled: true,
        retryCount: 0, retryIntervalMs: 0, autoReconnect: true,
        scheduler: { autoStart: false, minGapMs: 20 },
        writeCommands: [{
          id: 'pump-start', name: '启动水泵', description: '手动启动运行线圈',
          enabled: true, order: 0, unitId: 1, functionCode: 5, address: 5, values: [true],
        }, {
          id: 'set-target', name: '设定目标', description: '温控目标与输出上限',
          enabled: true, order: 1, unitId: 7, functionCode: 16, address: 20, values: [100, 200],
        }],
        requestGroups: [{
          id: 'boiler-collection', name: '锅炉采集', description: '温度、运行状态与诊断',
          enabled: true, order: 0, unitId: 1,
          requests: [{
            id: 'holding-read', name: '保持寄存器', enabled: true, order: 0,
            functionCode: 3, startAddress: 10, quantity: 4,
            intervalMs: 1000, timeoutMs: null, retryCount: null, retryIntervalMs: null,
            dataPoints: [{
              id: 'temperature', key: 'temperature', name: '出水温度', enabled: true,
              offset: 0, dataType: 'uint16', length: 1, byteOrder: 'big-endian',
              wordOrder: 'high-first', bitIndex: null, scale: 0.1, valueOffset: 0,
              unit: '℃', decimals: 1, minimum: 0, maximum: 100,
              invalidPolicy: 'mark-bad', saveHistory: false,
            }],
          }, {
            id: 'coil-read', name: '运行线圈', enabled: true, order: 1,
            functionCode: 1, startAddress: 5, quantity: 2,
            intervalMs: 700, timeoutMs: null, retryCount: null, retryIntervalMs: null,
            dataPoints: [{
              id: 'running', key: 'running', name: '运行状态', enabled: true,
              offset: 0, dataType: 'boolean', length: 1, byteOrder: 'big-endian',
              wordOrder: 'high-first', bitIndex: null, scale: 1, valueOffset: 0,
              unit: '', decimals: null, minimum: null, maximum: null,
              invalidPolicy: 'mark-bad', saveHistory: false,
            }],
          }, {
            id: 'diagnostic-failure', name: '诊断输入', enabled: true, order: 2,
            functionCode: 4, startAddress: 0, quantity: 2,
            intervalMs: 1500, timeoutMs: 300, retryCount: 0, retryIntervalMs: null,
            dataPoints: [{
              id: 'device-state', key: 'device_state', name: '设备状态', enabled: true,
              offset: 0, dataType: 'uint16', length: 1, byteOrder: 'big-endian',
              wordOrder: 'high-first', bitIndex: null, scale: 1, valueOffset: 0,
              unit: '', decimals: 0, minimum: null, maximum: null,
              invalidPolicy: 'mark-bad', saveHistory: false,
            }],
          }],
        }],
      },
    },
    {
      id: 'modbus-slave', name: '锅炉模拟器', transport: 'modbus-tcp-slave',
      config: {
        listenHost: '127.0.0.1', listenPort: 1502, unitId: 1, timeoutMs: 1000,
        addressNotation: 'zero-based', byteOrder: 'big-endian', wordOrder: 'high-first',
        dataAreas: {
          coils: { start: 0, count: 100, values: Array.from({ length: 100 }, (_, index) => index === 5) },
          discreteInputs: { start: 0, count: 100, values: Array.from({ length: 100 }, () => false) },
          holdingRegisters: { start: 0, count: 100, values: Array.from({ length: 100 }, (_, index) => index === 10 ? 256 : 0) },
          inputRegisters: { start: 0, count: 100, values: Array.from({ length: 100 }, () => 0) },
        },
        dataPoints: [{
          id: 'outlet-temperature', group: '温控', name: '出水温度',
          area: 'holdingRegisters', address: 10, dataType: 'int16', length: 1,
          byteOrder: 'big-endian', wordOrder: 'high-first', scale: 0.1, offset: 0,
          unit: '℃', access: 'read-write',
        }],
      },
    },
  ];
  let settings = {
    logLevel: 'info', realtimeFrameLimit: 2000, realtimeLogLimit: 1000,
    previewByteLimit: 4096, defaultFraming: 'line',
    autoScroll: true, theme: 'light', largeFont: false,
    modbusPointHistoryRetention: '30-days',
  };
  const electronListeners = {
    frames: new Set(), status: new Set(), peers: new Set(), modbus: new Set(), lifecycle: new Set(),
  };
  const tauriCallbacks = new Map();
  const tauriListeners = new Map();
  let callbackId = 0;
  let listenerId = 0;
  const previewSends = [];
  const previewModbusRequests = [];
  const previewTcpOpenAttempts = [];
  const activeOperations = new Map();
  const sendTemplates = [];
  const sendHistoryRows = [];
  const modbusHistoryRows = [];
  const modbusHistoryExports = [];
  let sendHistoryId = 0;
  let modbusHistoryId = 0;
  const historyWindows = [];
  globalThis.__INEED_PREVIEW_SENDS__ = previewSends;
  globalThis.__INEED_PREVIEW_MODBUS_REQUESTS__ = previewModbusRequests;
  globalThis.__INEED_PREVIEW_TCP_OPEN_ATTEMPTS__ = previewTcpOpenAttempts;
  globalThis.__INEED_PREVIEW_HISTORY_WINDOWS__ = historyWindows;
  globalThis.__INEED_PREVIEW_MODBUS_HISTORY_ROWS__ = modbusHistoryRows;
  globalThis.__INEED_PREVIEW_MODBUS_HISTORY_EXPORTS__ = modbusHistoryExports;

  const clone = (value) => globalThis.structuredClone(value);
  let modbusAreas = clone(endpoints.find(({ id }) => id === 'modbus-slave').config.dataAreas);
  globalThis.__INEED_PREVIEW_SET_MODBUS_REGISTER__ = (address, value) => {
    const area = modbusAreas.holdingRegisters;
    area.values[address - area.start] = value;
  };
  const success = (value = null) => ({ ok: true, value: clone(value) });
  const failure = (method, error) => ({
    ok: false,
    error: {
      name: error.name,
      message: error.message,
      code: error.code,
      method,
      runtimeName: previewRuntime,
    },
  });
  const bytes = (text) => new globalThis.TextEncoder().encode(text);

  function frameRows(endpointId, sessionId) {
    return Array.from({ length: 36 }, (_, index) => {
      const direction = index % 3 === 0 ? 'out' : 'in';
      const format = index % 7 === 0 ? 'json' : index % 5 === 0 ? 'hex' : 'text';
      const content = format === 'json'
        ? JSON.stringify({ sequence: index + 1, status: 'ok', source: 'preview' })
        : `固定帧 ${String(index + 1).padStart(2, '0')} / ${direction === 'in' ? '接收' : '发送'} / 温度=23.5`;
      return {
        id: `preview-frame-${index + 1}`,
        endpointId,
        sessionId,
        peerId: index % 2 === 0 ? 'peer-console' : 'peer-monitor',
        remoteAddress: index % 2 === 0 ? '127.0.0.1:53101' : '127.0.0.1:53102',
        direction,
        format,
        framing: 'line',
        bytes: bytes(content),
        createdAt: FIXED_TIME + index * 1000,
      };
    });
  }

  function logRows(endpointId, sessionId) {
    return Array.from({ length: 48 }, (_, index) => ({
      id: `preview-log-${index + 1}`,
      endpointId,
      sessionId,
      operationId: 'history-operation',
      level: index % 11 === 0 ? 'error' : index % 5 === 0 ? 'warning' : 'info',
      source: index % 2 === 0 ? 'tcp-server' : 'protocol-decoder',
      message: `固定日志 ${String(index + 1).padStart(2, '0')}：连接状态与分帧结果已更新`,
      createdAt: FIXED_TIME + index * 1250,
    }));
  }

  const historyFrames = frameRows('tcp-server-local', 'session-preview').map((frame) => ({
    id: frame.id,
    endpointId: frame.endpointId,
    sessionId: frame.sessionId,
    peerId: frame.peerId,
    direction: frame.direction,
    format: frame.format,
    framing: frame.framing,
    payloadBase64: globalThis.btoa(String.fromCharCode(...frame.bytes)),
    byteCount: frame.bytes.length,
    createdAt: frame.createdAt,
  }));
  const historyLogs = logRows('tcp-server-local', 'session-preview').map((log) => ({
    ...log,
    details: { fixture: true, repeatable: true },
  }));

  function emitElectron(kind, payload) {
    for (const listener of electronListeners[kind]) listener(clone(payload));
  }

  function emitTauri(eventName, payload) {
    for (const entry of tauriListeners.values()) {
      if (entry.event !== eventName) continue;
      tauriCallbacks.get(entry.callbackId)?.({
        event: eventName, id: entry.id, payload: clone(payload),
      });
    }
  }

  function emit(kind, payload) {
    if (previewRuntime === 'electron') emitElectron(kind, payload);
    else emitTauri(`transport:${kind}`, payload);
  }

  globalThis.__INEED_PREVIEW_EMIT_FRAME__ = (endpointId, bytes) => {
    const active = activeOperations.get(endpointId);
    emit('frames', {
      endpointId, sessionId: active?.sessionId, operationId: active?.operationId,
      frames: [{ direction: 'in', bytes, createdAt: Date.now() }],
    });
  };

  globalThis.__INEED_PREVIEW_EMIT_DLT645_REQUEST__ = (dataIdentifier = '02010100') => {
    const active = activeOperations.get('dlt645-meter-simulator');
    const identifiers = String(dataIdentifier).match(/../g).reverse().map((pair) => (
      Number.parseInt(pair, 16) + 0x33
    ) & 0xff);
    const body = [
      0x68, 0x12, 0x90, 0x78, 0x56, 0x34, 0x12, 0x68,
      0x11, 0x04, ...identifiers,
    ];
    const checksum = body.reduce((sum, byte) => (sum + byte) & 0xff, 0);
    emit('frames', {
      endpointId: 'dlt645-meter-simulator',
      sessionId: active?.sessionId ?? 'session-preview',
      operationId: active?.operationId ?? 'open-preview',
      frames: [{ direction: 'in', bytes: [...body, checksum, 0x16], createdAt: Date.now() }],
    });
  };

  function emitModbus(payload) {
    if (previewRuntime === 'electron') emitElectron('modbus', payload);
    else emitTauri('modbus:transaction', payload);
  }

  function publishActiveState(endpointId, sessionId, operationId) {
    const endpoint = endpoints.find(({ id }) => id === endpointId);
    const isModbus = endpoint?.transport.startsWith('modbus-');
    const isTcpEndpoint = endpoint?.transport === 'tcp-client' || endpoint?.transport === 'tcp-server';
    const isWebSocket = endpoint?.transport.startsWith('websocket-');
    const status = endpoint?.transport.endsWith('-slave') || ['tcp-server', 'websocket-server'].includes(endpoint?.transport) ? 'listening' : 'open';
    const source = isWebSocket ? 'websocket' : isModbus ? 'modbus' : isTcpEndpoint ? 'tcp' : 'serial';
    const peers = [
      {
        id: 'peer-console', endpointId, sessionId,
        remoteAddress: '127.0.0.1:53101', connectedAt: FIXED_TIME,
      },
      {
        id: 'peer-monitor', endpointId, sessionId,
        remoteAddress: '127.0.0.1:53102', connectedAt: FIXED_TIME + 1000,
      },
    ];
    if (!isModbus) {
      emit('peers', { endpointId, sessionId, operationId, peers });
      const frames = frameRows(endpointId, sessionId).map(({ direction, bytes: payload, createdAt }) => ({
        direction, bytes: payload, createdAt, ...(isWebSocket ? { messageType: 'text' } : {}),
      }));
      emit('frames', { endpointId, sessionId, operationId, frames });
    }
    emit('status', {
      endpointId,
      sessionId,
      operationId,
      status,
      error: null,
      log: {
        level: 'info',
        source,
        code: null,
        message: status === 'listening'
          ? '固定实时日志：TCP 服务端已开始监听'
          : '固定实时日志：连接状态已打开',
        details: null,
        createdAt: FIXED_TIME,
      },
      createdAt: FIXED_TIME,
    });
    if (endpointId === 'modbus-slave') {
      emitModbus({
        endpointId,
        sessionId,
        origin: 'slave',
        transport: 'modbus-tcp-slave',
        unitId: 1,
        functionCode: 3,
        address: 10,
        quantity: 1,
        requestValues: [],
        values: [modbusAreas.holdingRegisters.values[10]],
        success: true,
        exceptionCode: null,
        message: null,
        requestFrame: [
          0x12, 0x34, 0x00, 0x00, 0x00, 0x06,
          0x01, 0x03, 0x00, 0x0a, 0x00, 0x01,
        ],
        responseFrame: [
          0x12, 0x34, 0x00, 0x00, 0x00, 0x05,
          0x01, 0x03, 0x02, 0x01, 0x00,
        ],
        createdAt: FIXED_TIME,
        durationMs: 1,
      });
    }
  }

  function pageOf(rows, request = {}) {
    const page = Number(request.page ?? 1);
    const pageSize = Number(request.pageSize ?? 50);
    const scoped = request.endpointId
      ? rows.filter((row) => row.endpointId === request.endpointId)
      : rows;
    return {
      rows: scoped.slice((page - 1) * pageSize, page * pageSize),
      total: scoped.length,
      page,
      pageSize,
    };
  }

  function matchesModbusHistory(row, query) {
    if (row.endpointId !== query.endpointId) return false;
    if (row.createdAt < (query.from ?? 0) || row.createdAt > (query.to ?? Number.MAX_SAFE_INTEGER)) {
      return false;
    }
    if (!query.points?.length) return true;
    return query.points.some((point) => point.requestGroupId === row.requestGroupId
      && point.requestId === row.requestId && point.pointId === row.pointId);
  }

  function queryModbusHistoryRows(query) {
    const page = Number(query.page ?? 1);
    const pageSize = Number(query.pageSize ?? 50);
    const rows = modbusHistoryRows.filter((row) => matchesModbusHistory(row, query))
      .sort((left, right) => right.createdAt - left.createdAt || right.id - left.id);
    return {
      rows: clone(rows.slice((page - 1) * pageSize, page * pageSize)),
      total: rows.length,
      page,
      pageSize,
    };
  }

  function queryModbusPointSeries(query) {
    const series = [];
    for (const point of query.points ?? []) {
      const rows = modbusHistoryRows.filter((row) => matchesModbusHistory(row, {
        ...query, points: [point],
      })).sort((left, right) => left.createdAt - right.createdAt || left.id - right.id);
      if (rows.length === 0) continue;
      const first = rows[0];
      const kind = first.dataType === 'boolean'
        ? 'boolean'
        : first.dataType === 'string' ? 'string' : 'numeric';
      series.push({
        requestGroupId: first.requestGroupId,
        requestId: first.requestId,
        pointId: first.pointId,
        pointKey: first.pointKey,
        pointName: first.pointName,
        dataType: first.dataType,
        unit: first.unit ?? '',
        kind,
        samples: kind === 'numeric'
          ? numericHistorySamples(rows, query)
          : changeHistorySamples(rows),
        summary: summarizeHistoryRows(rows),
      });
    }
    return { from: query.from, to: query.to, series };
  }

  function numericHistorySamples(rows, query) {
    const bucketCount = Math.max(1, Number(query.bucketCount ?? 50));
    const span = Math.max(1, query.to - query.from + 1);
    const buckets = new Map();
    for (const row of rows) {
      const bucket = Math.min(
        bucketCount - 1,
        Math.floor(((row.createdAt - query.from) * bucketCount) / span),
      );
      const sample = buckets.get(bucket) ?? {
        bucket, firstAt: null, firstValue: null, lastAt: null, lastValue: null,
        minAt: null, minValue: null, maxAt: null, maxValue: null,
        goodCount: 0, abnormalCount: 0, worstQuality: 'good', marker: null,
      };
      if (row.numericValue !== null) {
        if (sample.firstAt === null) {
          sample.firstAt = row.createdAt;
          sample.firstValue = row.numericValue;
        }
        sample.lastAt = row.createdAt;
        sample.lastValue = row.numericValue;
        if (sample.minValue === null || row.numericValue < sample.minValue) {
          sample.minAt = row.createdAt;
          sample.minValue = row.numericValue;
        }
        if (sample.maxValue === null || row.numericValue > sample.maxValue) {
          sample.maxAt = row.createdAt;
          sample.maxValue = row.numericValue;
        }
      }
      if (row.quality === 'good') sample.goodCount += 1;
      else {
        sample.abnormalCount += 1;
        sample.worstQuality = row.quality;
        sample.marker = {
          createdAt: row.createdAt, quality: row.quality, reason: row.reason,
        };
      }
      buckets.set(bucket, sample);
    }
    return [...buckets.values()];
  }

  function changeHistorySamples(rows) {
    const samples = [];
    let previous;
    for (const row of rows) {
      const signature = JSON.stringify([row.value, row.quality, row.reason]);
      if (signature === previous) continue;
      previous = signature;
      samples.push({
        createdAt: row.createdAt,
        value: row.value,
        displayValue: row.displayValue,
        quality: row.quality,
        reason: row.reason,
      });
    }
    return samples;
  }

  function summarizeHistoryRows(rows) {
    const numeric = rows.map(({ numericValue }) => numericValue)
      .filter((value) => typeof value === 'number');
    let changeCount = 0;
    for (let index = 1; index < rows.length; index += 1) {
      if (JSON.stringify(rows[index].value) !== JSON.stringify(rows[index - 1].value)) {
        changeCount += 1;
      }
    }
    return {
      lastDisplayValue: rows.at(-1).displayValue,
      minimum: numeric.length ? Math.min(...numeric) : null,
      maximum: numeric.length ? Math.max(...numeric) : null,
      changeCount,
      abnormalCount: rows.filter(({ quality }) => quality !== 'good').length,
      latestQuality: rows.at(-1).quality,
    };
  }

  function openHistoryWindow(request) {
    const query = new globalThis.URLSearchParams({ view: 'history', kind: request.kind });
    if (request.endpointId) query.set('endpointId', request.endpointId);
    const url = previewRuntime === 'electron'
      ? new globalThis.URL(`/?${query}`, globalThis.location.origin).href
      : `index.html?${query}`;
    const existing = historyWindows.find((window) => window.url === url);
    if (existing) return { focused: true, url: existing.url };
    historyWindows.push({ url, kind: request.kind, endpointId: request.endpointId ?? null });
    return { focused: false, url };
  }

  function modbusTransaction(request, origin, values, success = true, message = 'Preview device timeout') {
    const transaction = {
      endpointId: request.endpointId,
      sessionId: 'session-preview',
      requestGroupId: request.requestGroupId ?? null,
      requestId: request.requestId ?? null,
      origin,
      unitId: request.unitId ?? 1,
      functionCode: request.functionCode,
      address: request.address,
      quantity: request.quantity ?? request.values?.length ?? 1,
      requestValues: clone(request.values ?? []),
      values: clone(values),
      success,
      exceptionCode: null,
      message: success ? null : message,
      createdAt: Date.now(),
      durationMs: 3,
    };
    emitModbus(transaction);
    return transaction;
  }

  function executeModbus(request) {
    previewModbusRequests.push(clone(request));
    if (request.functionCode === 16 && request.unitId === 7 && request.address === 20) {
      const transaction = modbusTransaction(request, 'master', [], false, 'Preview write rejected');
      const error = new Error(transaction.message);
      error.name = previewRuntime === 'electron' ? 'ModbusError' : 'SerialError';
      error.code = 'IO_ERROR';
      error.transaction = transaction;
      throw error;
    }
    if (request.requestId === 'diagnostic-failure') {
      const transaction = modbusTransaction(request, 'master', [], false);
      const error = new Error(transaction.message);
      error.name = previewRuntime === 'electron' ? 'ModbusError' : 'SerialError';
      error.code = 'IO_ERROR';
      error.transaction = transaction;
      throw error;
    }
    const area = {
      1: 'coils', 2: 'discreteInputs', 3: 'holdingRegisters', 4: 'inputRegisters',
      5: 'coils', 6: 'holdingRegisters', 15: 'coils', 16: 'holdingRegisters',
    }[request.functionCode];
    const target = modbusAreas[area];
    const offset = request.address - target.start;
    if (request.functionCode <= 4) {
      return modbusTransaction(
        request,
        'master',
        target.values.slice(offset, offset + request.quantity),
      );
    }
    target.values.splice(offset, request.values.length, ...clone(request.values));
    return modbusTransaction(request, 'master', request.values);
  }

  function writeModbusMap(request) {
    const area = modbusAreas[request.area];
    area.values.splice(request.address - area.start, request.values.length, ...clone(request.values));
    modbusTransaction({
      endpointId: request.endpointId,
      unitId: 1,
      functionCode: 0,
      address: request.address,
      quantity: request.values.length,
      values: request.values,
    }, 'local', request.values);
    return { endpointId: request.endpointId, unitId: 1, areas: clone(modbusAreas) };
  }

  function invokeValue(method, args) {
    switch (method) {
      case 'endpoint.list': return endpoints;
      case 'endpoint.save': {
        const saved = clone(args[0]);
        const index = endpoints.findIndex(({ id }) => id === saved.id);
        if (index === -1) endpoints.push(saved);
        else endpoints[index] = saved;
        if (saved.id === 'modbus-slave' && saved.config.dataAreas) {
          modbusAreas = clone(saved.config.dataAreas);
        }
        return saved;
      }
      case 'endpoint.clone': {
        const source = endpoints.find(({ id }) => id === args[0]);
        return { ...source, ...args[1] };
      }
      case 'endpoint.delete': return null;
      case 'transport.scanSerialPorts': return [
        { path: '/dev/tty.usbserial-DEV', manufacturer: 'Ineed Lab' },
        { path: 'COM8', manufacturer: 'Preview Device' },
      ];
      case 'transport.open': {
        const endpointId = args[0];
        const operationId = args[1]?.operationId;
        if (endpointId === 'tcp-client-cloud') {
          previewTcpOpenAttempts.push({ endpointId, operationId, createdAt: Date.now() });
          const error = new Error('Preview TCP endpoint is unavailable');
          error.name = 'TcpTransportError';
          error.code = 'IO_ERROR';
          throw error;
        }
        const sessionId = 'session-preview';
        activeOperations.set(endpointId, { operationId, sessionId });
        globalThis.setTimeout(
          () => publishActiveState(endpointId, sessionId, operationId),
          0,
        );
        return { sessionId };
      }
      case 'transport.cancelOpen':
      case 'transport.close':
      case 'transport.disconnectPeer': return null;
      case 'transport.send': {
        const request = clone(args[0]);
        previewSends.push(request);
        if (request.endpointId === 'dlt645-meter-simulator') {
          const active = activeOperations.get(request.endpointId);
          globalThis.setTimeout(() => emit('frames', {
            endpointId: request.endpointId,
            sessionId: active?.sessionId ?? 'session-preview',
            operationId: active?.operationId ?? 'open-preview',
            frames: [{ direction: 'out', bytes: request.bytes, createdAt: Date.now() }],
          }), 0);
        }
        if (request.endpointId === 'dlt645-meter-bus') {
          const active = activeOperations.get(request.endpointId);
          const response = [
            0x68, 0x12, 0x90, 0x78, 0x56, 0x34, 0x12, 0x68,
            0x91, 0x06, 0x33, 0x34, 0x34, 0x35, 0x34, 0x56, 0x77, 0x16,
          ];
          globalThis.setTimeout(() => emit('frames', {
            endpointId: request.endpointId,
            sessionId: active?.sessionId ?? 'session-preview',
            operationId: active?.operationId ?? 'open-preview',
            frames: [{ direction: 'out', bytes: request.bytes, createdAt: Date.now() }, {
              direction: 'in', bytes: response, createdAt: Date.now() + 3,
            }],
          }), 0);
        }
        return { byteCount: request.bytes?.length ?? 0 };
      }
      case 'modbus.execute': return executeModbus(args[0]);
      case 'modbus.readMap': return {
        endpointId: args[0], unitId: 1, areas: clone(modbusAreas),
      };
      case 'modbus.writeMap': return writeModbusMap(args[0]);
      case 'modbusHistory.recordBatch': {
        for (const row of args[0]) {
          modbusHistoryId += 1;
          modbusHistoryRows.push({ id: modbusHistoryId, ...clone(row) });
        }
        return { recordedCount: args[0].length };
      }
      case 'modbusHistory.querySeries': return queryModbusPointSeries(args[0]);
      case 'modbusHistory.queryRows': return queryModbusHistoryRows(args[0]);
      case 'modbusHistory.exportCsv': {
        modbusHistoryExports.push(clone(args[0]));
        return { canceled: false, path: '/tmp/preview-modbus-point-history.csv' };
      }
      case 'modbusHistory.clear': {
        const query = args[0];
        let deletedCount = 0;
        for (let index = modbusHistoryRows.length - 1; index >= 0; index -= 1) {
          if (!matchesModbusHistory(modbusHistoryRows[index], query)) continue;
          modbusHistoryRows.splice(index, 1);
          deletedCount += 1;
        }
        return deletedCount;
      }
      case 'modbusHistory.cleanup': {
        const retentionDays = { '7-days': 7, '30-days': 30, '90-days': 90 }[args[0]];
        if (!retentionDays) return { deletedCount: 0, completedAt: Date.now() };
        const cutoff = Date.now() - (retentionDays * 86_400_000);
        let deletedCount = 0;
        for (let index = modbusHistoryRows.length - 1; index >= 0; index -= 1) {
          if (modbusHistoryRows[index].createdAt >= cutoff) continue;
          modbusHistoryRows.splice(index, 1);
          deletedCount += 1;
        }
        return { deletedCount, completedAt: Date.now() };
      }
      case 'modbusHistory.flush': return { flushed: true };
      case 'history.queryFrames': return pageOf(historyFrames, args[0]);
      case 'history.queryLogs': return pageOf(historyLogs, args[0]);
      case 'history.delete':
      case 'history.clear': return { deleted: 1 };
      case 'template.list': return sendTemplates.filter(({ endpointId }) => endpointId === args[0]);
      case 'template.save': {
        const current = clone(args[0]);
        const existing = sendTemplates.find(({ id }) => id === current.id);
        const saved = {
          ...current,
          createdAt: existing?.createdAt ?? FIXED_TIME,
          updatedAt: FIXED_TIME,
        };
        const index = sendTemplates.findIndex(({ id }) => id === saved.id);
        if (index === -1) sendTemplates.unshift(saved);
        else sendTemplates[index] = saved;
        return saved;
      }
      case 'template.delete': {
        const index = sendTemplates.findIndex(({ id }) => id === args[0]);
        if (index === -1) return false;
        sendTemplates.splice(index, 1);
        return true;
      }
      case 'sendHistory.record': {
        sendHistoryId += 1;
        const saved = { id: sendHistoryId, ...clone(args[0]) };
        sendHistoryRows.unshift(saved);
        return saved;
      }
      case 'sendHistory.query': return pageOf(sendHistoryRows, args[0]);
      case 'sendHistory.delete': {
        const index = sendHistoryRows.findIndex(({ id }) => id === args[0]);
        if (index === -1) return false;
        sendHistoryRows.splice(index, 1);
        return true;
      }
      case 'sendHistory.clear': {
        const endpointId = args[0];
        let deleted = 0;
        for (let index = sendHistoryRows.length - 1; index >= 0; index -= 1) {
          if (sendHistoryRows[index].endpointId !== endpointId) continue;
          sendHistoryRows.splice(index, 1);
          deleted += 1;
        }
        return deleted;
      }
      case 'settings.getAll': return settings;
      case 'settings.save': {
        settings = { ...settings, [args[0]]: args[1] };
        return settings;
      }
      case 'settings.saveAll': {
        settings = { ...args[0] };
        return settings;
      }
      case 'workspace.export': return { schemaVersion: 1, endpoints, settings };
      case 'workspace.import': return { imported: true };
      case 'storage.stats': return {
        frameCount: 36, logCount: 48, sendHistoryCount: 8,
        totalCount: 92, diskBytes: 262144,
        modbusPointHistoryCount: modbusHistoryRows.length,
        modbusPointHistoryEstimatedBytes: modbusHistoryRows.length * 192,
        modbusPointHistoryLastCleanupAt: null,
      };
      case 'storage.clearHistory': return { deleted: 84 };
      case 'window.openHistory': return openHistoryWindow(args[0]);
      case 'lifecycle.readyForShutdown': return { acknowledged: true, requestId: args[0] };
      default: throw new Error(`Unknown preview method: ${method}`);
    }
  }

  const electronInvoke = (method) => (...args) => {
    try {
      return success(invokeValue(method, args));
    } catch (error) {
      return failure(method, error);
    }
  };
  const electronSubscribe = (kind) => (listener) => {
    electronListeners[kind].add(listener);
    return () => electronListeners[kind].delete(listener);
  };

  if (previewRuntime === 'electron') {
    globalThis.ineedLinkLab = {
      runtimeName: 'electron',
      opcua: { execute: async request => success(await opcuaExecute(request)), onEvent: () => () => {} },
      endpoint: {
        list: electronInvoke('endpoint.list'), save: electronInvoke('endpoint.save'),
        clone: electronInvoke('endpoint.clone'), delete: electronInvoke('endpoint.delete'),
      },
      transport: {
        scanSerialPorts: electronInvoke('transport.scanSerialPorts'),
        open: electronInvoke('transport.open'), cancelOpen: electronInvoke('transport.cancelOpen'),
        close: electronInvoke('transport.close'), send: electronInvoke('transport.send'),
        disconnectPeer: electronInvoke('transport.disconnectPeer'),
        onFrames: electronSubscribe('frames'), onStatus: electronSubscribe('status'),
        onPeers: electronSubscribe('peers'),
      },
      modbus: {
        execute: electronInvoke('modbus.execute'), readMap: electronInvoke('modbus.readMap'),
        writeMap: electronInvoke('modbus.writeMap'), onTransactions: electronSubscribe('modbus'),
      },
      modbusHistory: {
        recordBatch: electronInvoke('modbusHistory.recordBatch'),
        querySeries: electronInvoke('modbusHistory.querySeries'),
        queryRows: electronInvoke('modbusHistory.queryRows'),
        exportCsv: electronInvoke('modbusHistory.exportCsv'),
        clear: electronInvoke('modbusHistory.clear'),
        cleanup: electronInvoke('modbusHistory.cleanup'),
        flush: electronInvoke('modbusHistory.flush'),
      },
      history: {
        queryFrames: electronInvoke('history.queryFrames'), queryLogs: electronInvoke('history.queryLogs'),
        delete: electronInvoke('history.delete'), clear: electronInvoke('history.clear'),
      },
      template: {
        list: electronInvoke('template.list'), save: electronInvoke('template.save'),
        delete: electronInvoke('template.delete'),
      },
      sendHistory: {
        record: electronInvoke('sendHistory.record'), query: electronInvoke('sendHistory.query'),
        delete: electronInvoke('sendHistory.delete'), clear: electronInvoke('sendHistory.clear'),
      },
      settings: {
        getAll: electronInvoke('settings.getAll'), save: electronInvoke('settings.save'),
        saveAll: electronInvoke('settings.saveAll'),
      },
      workspace: { export: electronInvoke('workspace.export'), import: electronInvoke('workspace.import') },
      storage: { stats: electronInvoke('storage.stats'), clearHistory: electronInvoke('storage.clearHistory') },
      window: { openHistory: electronInvoke('window.openHistory') },
      lifecycle: {
        onBeforeShutdown: electronSubscribe('lifecycle'),
        readyForShutdown: electronInvoke('lifecycle.readyForShutdown'),
      },
    };
  }

  const tauriCommandMethods = {
    endpoint_list: 'endpoint.list', endpoint_save: 'endpoint.save',
    endpoint_clone: 'endpoint.clone', endpoint_delete: 'endpoint.delete',
    transport_scan_serial_ports: 'transport.scanSerialPorts', transport_open: 'transport.open',
    transport_cancel_open: 'transport.cancelOpen', transport_close: 'transport.close',
    transport_send: 'transport.send', transport_disconnect_peer: 'transport.disconnectPeer',
    modbus_execute: 'modbus.execute', modbus_read_map: 'modbus.readMap',
    modbus_write_map: 'modbus.writeMap',
    modbus_history_record_batch: 'modbusHistory.recordBatch',
    modbus_history_query_series: 'modbusHistory.querySeries',
    modbus_history_query_rows: 'modbusHistory.queryRows',
    modbus_history_export_csv: 'modbusHistory.exportCsv',
    modbus_history_clear: 'modbusHistory.clear',
    modbus_history_cleanup: 'modbusHistory.cleanup',
    modbus_history_flush: 'modbusHistory.flush',
    history_query_frames: 'history.queryFrames', history_query_logs: 'history.queryLogs',
    history_delete: 'history.delete', history_clear: 'history.clear',
    template_list: 'template.list', template_save: 'template.save',
    template_delete: 'template.delete', send_history_record: 'sendHistory.record',
    send_history_query: 'sendHistory.query', send_history_delete: 'sendHistory.delete',
    send_history_clear: 'sendHistory.clear',
    settings_get_all: 'settings.getAll', settings_save: 'settings.save',
    settings_save_all: 'settings.saveAll', workspace_export: 'workspace.export',
    workspace_import: 'workspace.import', storage_stats: 'storage.stats',
    storage_clear_history: 'storage.clearHistory', window_open_history: 'window.openHistory',
    lifecycle_ready_for_shutdown: 'lifecycle.readyForShutdown',
  };

  if (previewRuntime === 'tauri') {
    globalThis.__TAURI_INTERNALS__ = {
      transformCallback(callback, once = false) {
        const id = ++callbackId;
        tauriCallbacks.set(id, (...args) => {
          callback?.(...args);
          if (once) tauriCallbacks.delete(id);
        });
        return id;
      },
      unregisterCallback(id) { tauriCallbacks.delete(id); },
      async invoke(command, payload = {}) {
        if (command === 'opcua_execute') return success(await opcuaExecute(payload.request));
        if (command === 'plugin:event|listen') {
          const id = ++listenerId;
          tauriListeners.set(id, { id, event: payload.event, callbackId: payload.handler });
          return id;
        }
        if (command === 'plugin:event|unlisten') {
          tauriListeners.delete(payload.eventId);
          return null;
        }
        const method = tauriCommandMethods[command];
        if (!method) throw new Error(`Unknown preview Tauri command: ${command}`);
        try {
          return success(invokeValue(method, payload.args ?? []));
        } catch (error) {
          return failure(method, error);
        }
      },
      convertFileSrc(value) { return value; },
    };
    globalThis.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener(_event, id) { tauriListeners.delete(id); },
    };
  }
  globalThis.__INEED_PREVIEW_READY__ = true;
})();
