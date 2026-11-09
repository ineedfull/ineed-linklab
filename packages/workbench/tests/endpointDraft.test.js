import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_TCP_KEEP_ALIVE_DELAY_SECONDS,
  MAX_TCP_KEEP_ALIVE_DELAY_SECONDS,
  MAX_SERIAL_BAUD_RATE,
  MAX_MODBUS_AREA_COUNT,
  MIN_TCP_KEEP_ALIVE_DELAY_SECONDS,
  MODBUS_AREA_KEYS,
  SUPPORTED_BAUD_RATES,
  generateEndpointName,
  normalizeModbusConfig,
  normalizeSerialConfig,
  normalizeSerialPorts,
  normalizeTcpResilienceConfig,
  validateEndpointDraft,
} from '../src/model/endpointDraft.js';

const validDrafts = {
  serial: {
    transport: 'serial',
    config: {
      path: '/dev/ttyUSB0', baudRate: 115200, dataBits: 8,
      parity: 'none', stopBits: 1, flowControl: 'none',
    },
  },
  'tcp-client': { transport: 'tcp-client', config: { host: 'localhost', port: 9000 } },
  'tcp-server': {
    transport: 'tcp-server',
    config: { listenHost: '0.0.0.0', listenPort: 9000 },
  },
  'udp-client': {
    transport: 'udp-client',
    config: {
      bindHost: '0.0.0.0', bindPort: 9001, targetHost: 'localhost', targetPort: 9002,
    },
  },
  'udp-server': {
    transport: 'udp-server',
    config: { bindHost: '0.0.0.0', bindPort: 9001 },
  },
  'dlt645-slave': {
    transport: 'dlt645-slave',
    config: {
      path: '/dev/tty.sim', baudRate: 2400, dataBits: 8,
      parity: 'even', stopBits: 1, flowControl: 'none',
      responseDelayMs: 50, wakeUpBytes: 0, meters: [],
    },
  },
};

test('accepts complete transport-specific endpoint drafts', () => {
  for (const draft of Object.values(validDrafts)) {
    assert.deepEqual(validateEndpointDraft(draft), {});
  }
});

test('serial accepts custom baud rates within the unsigned 32-bit range', () => {
  for (const baudRate of [1, 12345, 0xffff_ffff]) {
    assert.deepEqual(
      validateEndpointDraft({ transport: 'serial', config: { path: 'COM3', baudRate } }),
      {},
    );
  }
  assert.equal(MAX_SERIAL_BAUD_RATE, 0xffff_ffff);
  assert.equal(SUPPORTED_BAUD_RATES.includes(115200), true);
});

test('serial rejects baud rates outside the unsigned 32-bit range', () => {
  const expected = { baudRate: '波特率必须为 1 到 4294967295 的整数。' };

  for (const baudRate of [0, 0x1_0000_0000, 1.5, '115200']) {
    assert.deepEqual(
      validateEndpointDraft({ transport: 'serial', config: { path: 'COM3', baudRate } }),
      expected,
    );
  }
});

test('serial requires a selected port', () => {
  assert.deepEqual(
    validateEndpointDraft({ transport: 'serial', config: { path: '', baudRate: -9600 } }),
    {
      path: '请选择或输入串口。',
      baudRate: '波特率必须为 1 到 4294967295 的整数。',
    },
  );
});

test('legacy serial config receives line defaults without mutating the source', () => {
  const source = { path: '/dev/tty.usbserial', baudRate: 9600 };
  assert.deepEqual(normalizeSerialConfig(source), {
    path: '/dev/tty.usbserial', baudRate: 9600, dataBits: 8,
    parity: 'none', stopBits: 1, flowControl: 'none',
    receiveFraming: { mode: 'raw' },
  });
  assert.deepEqual(source, { path: '/dev/tty.usbserial', baudRate: 9600 });
});

test('serial receive framing normalizes all persisted modes without aliasing delimiter bytes', () => {
  const cases = [
    [{ mode: 'raw' }, { mode: 'raw' }],
    [{ mode: 'delimiter', delimiterBytes: [13, 10] }, { mode: 'delimiter', delimiterBytes: [13, 10] }],
    [{ mode: 'fixed', length: 64 }, { mode: 'fixed', length: 64 }],
    [{ mode: 'idle', idleMs: 50 }, { mode: 'idle', idleMs: 50 }],
  ];

  for (const [receiveFraming, expected] of cases) {
    const normalized = normalizeSerialConfig({ receiveFraming });
    assert.deepEqual(normalized.receiveFraming, expected);
    assert.notEqual(normalized.receiveFraming, receiveFraming);
  }
  const delimiter = cases[1][0];
  assert.notEqual(normalizeSerialConfig({ receiveFraming: delimiter }).receiveFraming.delimiterBytes,
    delimiter.delimiterBytes);
});

test('serial receive framing validates strict bytes, supported modes, and bounded positive values', () => {
  const base = {
    path: 'COM3', baudRate: 115200, dataBits: 8,
    parity: 'none', stopBits: 1, flowControl: 'none',
  };
  const errorFor = (receiveFraming) => validateEndpointDraft({
    transport: 'serial', config: { ...base, receiveFraming },
  });

  assert.deepEqual(errorFor({ mode: 'delimiter', delimiterBytes: [] }), {
    delimiterBytes: '分隔符必须是非空的 HEX 字节序列。',
  });
  for (const delimiterBytes of [[0, 256], [1.5], ['13'], new Uint8Array([13, 10])]) {
    assert.deepEqual(errorFor({ mode: 'delimiter', delimiterBytes }), {
      delimiterBytes: '分隔符必须是非空的 HEX 字节序列。',
    });
  }
  assert.deepEqual(errorFor({ mode: 'fixed', length: 0 }), {
    receiveFrameLength: '固定长度必须为 1 到 1048576 的整数。',
  });
  assert.deepEqual(errorFor({ mode: 'fixed', length: 1048577 }), {
    receiveFrameLength: '固定长度必须为 1 到 1048576 的整数。',
  });
  assert.deepEqual(errorFor({ mode: 'idle', idleMs: -1 }), {
    receiveIdleMs: '空闲毫秒必须为 1 到 60000 的整数。',
  });
  assert.deepEqual(errorFor({ mode: 'idle', idleMs: 60001 }), {
    receiveIdleMs: '空闲毫秒必须为 1 到 60000 的整数。',
  });
  assert.deepEqual(errorFor({ mode: 'lines' }), {
    receiveFraming: '请选择有效的接收分帧方式。',
  });
  for (const receiveFraming of [
    { mode: 'raw' },
    { mode: 'delimiter', delimiterBytes: [0, 13, 255] },
    { mode: 'fixed', length: 1048576 },
    { mode: 'idle', idleMs: 60000 },
  ]) {
    assert.deepEqual(errorFor(receiveFraming), {});
  }
});

test('only a missing receiveFraming field receives the legacy raw validation default', () => {
  const base = {
    path: 'COM3', baudRate: 115200, dataBits: 8,
    parity: 'none', stopBits: 1, flowControl: 'none',
  };
  const validate = (config) => validateEndpointDraft({ transport: 'serial', config });

  assert.deepEqual(validate(base), {});
  for (const receiveFraming of [null, [], 'raw']) {
    assert.deepEqual(validate({ ...base, receiveFraming }), {
      receiveFraming: '接收分帧配置格式无效。',
    });
  }
});

test('receiveFraming rejects unknown and mode-specific extra fields before normalization', () => {
  const base = {
    path: 'COM3', baudRate: 115200, dataBits: 8,
    parity: 'none', stopBits: 1, flowControl: 'none',
  };
  const errorFor = (receiveFraming) => validateEndpointDraft({
    transport: 'serial', config: { ...base, receiveFraming },
  });
  const malformed = { receiveFraming: '接收分帧配置格式无效。' };

  for (const receiveFraming of [
    { mode: 'raw', unknown: true },
    { mode: 'raw', delimiterBytes: [10] },
    { mode: 'delimiter', delimiterBytes: [13, 10], length: 2 },
    { mode: 'fixed', length: 64, idleMs: 50 },
    { mode: 'idle', idleMs: 50, delimiterBytes: [10] },
  ]) {
    assert.deepEqual(errorFor(receiveFraming), malformed);
  }
  assert.deepEqual(errorFor({ mode: 'unknown' }), {
    receiveFraming: '请选择有效的接收分帧方式。',
  });
});

test('TCP drafts validate receive framing like serial endpoints', () => {
  const validConfigs = {
    'tcp-client': { host: '127.0.0.1', port: 41000 },
    'tcp-server': { listenHost: '127.0.0.1', listenPort: 41000 },
  };

  for (const [transport, config] of Object.entries(validConfigs)) {
    assert.deepEqual(
      validateEndpointDraft({
        transport,
        config: {
          ...config,
          receiveFraming: { mode: 'delimiter', delimiterBytes: [0x0d, 0x0a] },
        },
      }),
      {},
    );
    assert.deepEqual(
      validateEndpointDraft({
        transport,
        config: { ...config, receiveFraming: { mode: 'fixed', length: 0 } },
      }),
      { receiveFrameLength: '固定长度必须为 1 到 1048576 的整数。' },
    );
  }
});

test('legacy TCP configs receive resilience defaults without source mutation', () => {
  const client = { host: 'localhost', port: 9000 };
  assert.deepEqual(normalizeTcpResilienceConfig(client, 'tcp-client'), {
    keepAlive: { enabled: true, initialDelaySeconds: 30 },
    autoReconnect: false,
  });
  assert.deepEqual(normalizeTcpResilienceConfig({}, 'tcp-server'), {
    keepAlive: { enabled: true, initialDelaySeconds: 30 },
  });
  assert.deepEqual(normalizeTcpResilienceConfig({ autoReconnect: true }, 'modbus-tcp-master'), {
    keepAlive: { enabled: true, initialDelaySeconds: 30 },
    autoReconnect: true,
  });
  assert.deepEqual(client, { host: 'localhost', port: 9000 });
});

test('TCP resilience preserves explicit values and validates exact bounds', () => {
  const base = { host: 'localhost', port: 9000 };
  for (const initialDelaySeconds of [
    MIN_TCP_KEEP_ALIVE_DELAY_SECONDS,
    DEFAULT_TCP_KEEP_ALIVE_DELAY_SECONDS,
    MAX_TCP_KEEP_ALIVE_DELAY_SECONDS,
  ]) {
    assert.deepEqual(validateEndpointDraft({
      transport: 'tcp-client',
      config: {
        ...base,
        keepAlive: { enabled: false, initialDelaySeconds },
        autoReconnect: true,
      },
    }), {});
  }
  for (const initialDelaySeconds of [0, 3601, 1.5, '30']) {
    assert.deepEqual(validateEndpointDraft({
      transport: 'tcp-client',
      config: { ...base, keepAlive: { enabled: true, initialDelaySeconds } },
    }), {
      keepAliveInitialDelaySeconds: '首次探测延迟必须为 1 到 3600 的整数秒。',
    });
  }
});

test('TCP resilience rejects malformed policy and server auto reconnect', () => {
  const server = { listenHost: '0.0.0.0', listenPort: 9000 };
  assert.deepEqual(validateEndpointDraft({
    transport: 'tcp-server', config: { ...server, autoReconnect: true },
  }), { autoReconnect: 'TCP 服务端不支持自动重连。' });
  assert.deepEqual(validateEndpointDraft({
    transport: 'tcp-client',
    config: {
      host: 'localhost', port: 9000,
      keepAlive: { enabled: 1, initialDelaySeconds: 30, interval: 10 },
      autoReconnect: 'yes',
    },
  }), {
    keepAlive: 'TCP Keepalive 配置格式无效。',
    autoReconnect: '自动重连必须为布尔值。',
  });
});

test('UDP drafts ignore legacy stream framing because every datagram is one frame', () => {
  for (const [transport, config] of Object.entries({
    'udp-client': {
      bindHost: '127.0.0.1', bindPort: 41001, targetHost: '127.0.0.1', targetPort: 41002,
    },
    'udp-server': { bindHost: '127.0.0.1', bindPort: 41001 },
  })) {
    assert.deepEqual(validateEndpointDraft({
      transport,
      config: { ...config, receiveFraming: { mode: 'fixed', length: 0 } },
    }), {});
  }
});

test('serial scan results normalize strings and common object labels', () => {
  assert.deepEqual(normalizeSerialPorts([
    'COM3',
    { path: '/dev/ttyUSB0', manufacturer: 'Acme' },
    { name: '/dev/cu.usbmodem', label: 'USB Modem' },
    { label: 'missing-path' },
    { path: '/dev/ttyUSB0', label: 'duplicate' },
  ]), [
    { path: 'COM3', label: 'COM3' },
    { path: '/dev/ttyUSB0', label: '/dev/ttyUSB0 - Acme' },
    { path: '/dev/cu.usbmodem', label: 'USB Modem' },
  ]);
});

test('generates transport-specific endpoint names', () => {
  const cases = [
    [validDrafts.serial, 'SERIAL_ttyUSB0'],
    [validDrafts['tcp-client'], 'TCP_CLIENT_localhost_9000'],
    [validDrafts['tcp-server'], 'TCP_SERVER_9000'],
    [validDrafts['udp-client'], 'UDP_CLIENT_localhost_9002'],
    [validDrafts['udp-server'], 'UDP_SERVER_9001'],
    [validDrafts['dlt645-slave'], 'DLT645_SIMULATOR_tty.sim'],
  ];

  for (const [draft, expected] of cases) {
    assert.equal(generateEndpointName(draft), expected);
  }
});

test('serial endpoint names use the final slash or backslash path segment', () => {
  assert.equal(
    generateEndpointName({ transport: 'serial', config: { path: 'COM3' } }),
    'SERIAL_COM3',
  );
  assert.equal(
    generateEndpointName({
      transport: 'serial', config: { path: String.raw`C:\devices\COM7` },
    }),
    'SERIAL_COM7',
  );
});

test('serial endpoint names ignore trailing slash or backslash separators', () => {
  assert.equal(
    generateEndpointName({ transport: 'serial', config: { path: '/dev/ttyUSB0/' } }),
    'SERIAL_ttyUSB0',
  );
  assert.equal(
    generateEndpointName({
      transport: 'serial', config: { path: 'C:\\devices\\COM7\\' },
    }),
    'SERIAL_COM7',
  );
});

test('generated endpoint names normalize separators and unknown transports', () => {
  assert.equal(
    generateEndpointName({
      transport: 'tcp-client', config: { host: ' api///host__ / local ', port: 9000 },
    }),
    'TCP_CLIENT_api_host_local_9000',
  );
  assert.equal(
    generateEndpointName({ transport: 'udp-server', config: { bindPort: '---' } }),
    'UDP_SERVER',
  );
  assert.equal(generateEndpointName({ transport: 'websocket' }), 'ENDPOINT');
});

test('generated endpoint names preserve hostname and IP periods', () => {
  assert.equal(
    generateEndpointName({
      transport: 'tcp-client', config: { host: '192.168.1.10', port: 9000 },
    }),
    'TCP_CLIENT_192.168.1.10_9000',
  );
});

test('generated serial endpoint names preserve Unicode letters and numbers', () => {
  assert.equal(
    generateEndpointName({ transport: 'serial', config: { path: '/dev/串口一' } }),
    'SERIAL_串口一',
  );
});

test('generated serial endpoint names preserve Unicode combining marks', () => {
  assert.equal(
    generateEndpointName({ transport: 'serial', config: { path: '/dev/हिन्दी' } }),
    'SERIAL_हिन्दी',
  );
});

test('generated TCP client names preserve Unicode hostnames', () => {
  assert.equal(
    generateEndpointName({
      transport: 'tcp-client', config: { host: '例子.中国', port: 9000 },
    }),
    'TCP_CLIENT_例子.中国_9000',
  );
});

test('generated endpoint names normalize decomposed accents to NFC', () => {
  const generateSerialName = (path) => generateEndpointName({
    transport: 'serial', config: { path },
  });
  const composed = generateSerialName('/dev/café');
  const decomposed = generateSerialName('/dev/cafe\u0301');

  assert.equal(decomposed, 'SERIAL_café');
  assert.equal(decomposed, composed);
});

test('generated endpoint names add case-insensitive collision suffixes', () => {
  const draft = { transport: 'serial', config: { path: 'COM3' } };

  assert.equal(generateEndpointName(draft, ['serial_com3']), 'SERIAL_COM3_2');
  assert.equal(
    generateEndpointName(draft, ['serial_com3', 'Serial_Com3_2']),
    'SERIAL_COM3_3',
  );
});

test('generated endpoint names trim existing names before collision checks', () => {
  const draft = { transport: 'serial', config: { path: 'COM3' } };

  assert.equal(generateEndpointName(draft, [' Serial_Com3 ']), 'SERIAL_COM3_2');
});

test('generated endpoint names preserve the 80-character cap when suffixing', () => {
  const draft = {
    transport: 'tcp-client',
    config: { host: 'a'.repeat(100), port: 9000 },
  };
  const capped = `TCP_CLIENT_${'a'.repeat(69)}`;

  assert.equal(capped.length, 80);
  assert.equal(generateEndpointName(draft), capped);
  const suffixed = generateEndpointName(draft, [capped.toLowerCase()]);
  assert.equal(suffixed, `TCP_CLIENT_${'a'.repeat(67)}_2`);
  assert.equal(suffixed.length, 80);
});

test('generated endpoint names truncate supplementary letters on grapheme boundaries', () => {
  const letter = '\u{10400}';
  const draft = {
    transport: 'serial', config: { path: `/dev/${letter.repeat(100)}` },
  };
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const graphemeCount = (value) => [...segmenter.segment(value)].length;
  const hasLoneSurrogate = (value) => [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint >= 0xd800 && codePoint <= 0xdfff;
  });

  const generated = generateEndpointName(draft);
  assert.equal(generated, `SERIAL_${letter.repeat(73)}`);
  assert.equal(hasLoneSurrogate(generated), false);
  assert.ok(graphemeCount(generated) <= 80);

  const suffixed = generateEndpointName(draft, [generated]);
  assert.equal(suffixed, `SERIAL_${letter.repeat(71)}_2`);
  assert.equal(hasLoneSurrogate(suffixed), false);
  assert.ok(graphemeCount(suffixed) <= 80);
});

test('serial line settings report field-specific allowed-value errors', () => {
  assert.deepEqual(validateEndpointDraft({
    transport: 'serial',
    config: {
      path: 'COM3', baudRate: 115200, dataBits: 9,
      parity: 'zero', stopBits: 3, flowControl: 'magic',
    },
  }), {
    dataBits: '数据位必须为 5、6、7 或 8。',
    parity: '请选择有效的校验位。',
    stopBits: '停止位必须为 1、1.5 或 2。',
    flowControl: '请选择有效的流控方式。',
  });
  assert.deepEqual(validateEndpointDraft({
    transport: 'serial',
    config: {
      path: 'COM3', baudRate: 115200, dataBits: 5,
      parity: 'mark', stopBits: 1.5, flowControl: 'software',
    },
  }), {});
});

test('TCP client reports host and valid port errors', () => {
  assert.deepEqual(
    validateEndpointDraft({ transport: 'tcp-client', config: { host: ' ', port: 0 } }),
    { host: '请输入服务器地址。', port: '服务器端口必须为 1 到 65535 的整数。' },
  );
});

test('TCP server reports listen host and listen port errors', () => {
  assert.deepEqual(
    validateEndpointDraft({
      transport: 'tcp-server', config: { listenHost: '', listenPort: 65536 },
    }),
    {
      listenHost: '请输入监听地址。',
      listenPort: '监听端口必须为 1 到 65535 的整数。',
    },
  );
});

test('UDP client requires bind fields and a default target', () => {
  assert.deepEqual(
    validateEndpointDraft({
      transport: 'udp-client',
      config: { bindHost: '', bindPort: 'bad', targetHost: '', targetPort: null },
    }),
    {
      bindHost: '请输入本地绑定地址。',
      bindPort: '本地绑定端口必须为 1 到 65535 的整数。',
      targetHost: '请输入默认目标地址。',
      targetPort: '默认目标端口必须为 1 到 65535 的整数。',
    },
  );
});

test('UDP server allows no default target but validates a partially supplied target', () => {
  assert.deepEqual(validateEndpointDraft(validDrafts['udp-server']), {});
  assert.deepEqual(
    validateEndpointDraft({
      transport: 'udp-server',
      config: { bindHost: '0.0.0.0', bindPort: 9001, targetHost: 'host', targetPort: 0 },
    }),
    { targetPort: '默认目标端口必须为 1 到 65535 的整数。' },
  );
});

test('Modbus TCP and RTU master drafts normalize protocol defaults', () => {
  assert.deepEqual(normalizeModbusConfig({}, 'modbus-tcp-master'), {
    configVersion: 3,
    description: '',
    enabled: true,
    unitId: 1,
    timeoutMs: 1000,
    retryCount: 0,
    retryIntervalMs: 200,
    autoReconnect: false,
    scheduler: { minGapMs: 50, autoStart: false },
    requestGroups: [],
    writeCommands: [],
    addressNotation: 'zero-based',
    byteOrder: 'big-endian',
    wordOrder: 'high-first',
    host: '127.0.0.1',
    port: 502,
  });
  assert.deepEqual(validateEndpointDraft({
    transport: 'modbus-rtu-master',
    config: { path: '/dev/ttyUSB0', baudRate: 9600 },
  }), {});
  assert.deepEqual(validateEndpointDraft({
    transport: 'modbus-rtu-master',
    config: { path: '/dev/ttyUSB0', baudRate: 9600, parity: 'mark', stopBits: 1.5 },
  }), {
    parity: 'Modbus RTU 校验位仅支持 None、Even 或 Odd。',
    stopBits: 'Modbus RTU 停止位仅支持 1 或 2。',
  });
  assert.deepEqual(validateEndpointDraft({
    transport: 'modbus-tcp-master',
    config: { host: '', port: 0, unitId: 248, timeoutMs: 49 },
  }), {
    unitId: '站号必须为 1 到 247 的整数。',
    timeoutMs: '超时时间必须为 50 到 60000 毫秒的整数。',
    host: '请输入从站地址。',
    port: '从站端口必须为 1 到 65535 的整数。',
  });
  assert.deepEqual(validateEndpointDraft({
    transport: 'modbus-tcp-master',
    config: {
      host: '127.0.0.1', port: 502, retryCount: 11,
      scheduler: { minGapMs: -1, autoStart: false }, requestGroups: [],
    },
  }), {
    retryCount: '失败重试次数必须为 0 到 10 的整数。',
    schedulerMinGapMs: '最小请求间隔必须为 0 到 60000 毫秒。',
  });
});

test('Modbus endpoint normalization upgrades version 2 groups without changing transport values', () => {
  const legacy = {
    configVersion: 2,
    host: '10.0.0.8',
    port: 1502,
    requestGroups: [{
      id: 'status', name: 'Status', unitId: 9, enabled: false, order: 0,
      functionCode: 1, startAddress: 20, quantity: 8, intervalMs: 500,
      dataPoints: [{
        id: 'running', key: 'running', name: 'Running', enabled: false,
        offset: 0, dataType: 'boolean', length: 1, saveHistory: true,
      }],
    }],
  };
  const normalized = normalizeModbusConfig(legacy, 'modbus-tcp-master');

  assert.equal(normalized.configVersion, 3);
  assert.equal(normalized.host, '10.0.0.8');
  assert.equal(normalized.port, 1502);
  assert.deepEqual(normalized.writeCommands, []);
  assert.equal(Object.hasOwn(legacy, 'writeCommands'), false);
  const group = normalized.requestGroups[0];
  assert.deepEqual({ id: group.id, unitId: group.unitId, enabled: group.enabled }, {
    id: 'status', unitId: 9, enabled: false,
  });
  const request = group.requests[0];
  assert.deepEqual({
    id: request.id,
    functionCode: request.functionCode,
    startAddress: request.startAddress,
    quantity: request.quantity,
  }, { id: 'status-request', functionCode: 1, startAddress: 20, quantity: 8 });
  assert.deepEqual({
    id: request.dataPoints[0].id,
    enabled: request.dataPoints[0].enabled,
    saveHistory: request.dataPoints[0].saveHistory,
  }, { id: 'running', enabled: false, saveHistory: true });
});

test('Modbus slave drafts provide four data areas and strictly validate their ranges and values', () => {
  const normalized = normalizeModbusConfig({}, 'modbus-tcp-slave');
  assert.deepEqual(Object.keys(normalized.dataAreas), [...MODBUS_AREA_KEYS]);
  for (const key of MODBUS_AREA_KEYS) {
    assert.equal(normalized.dataAreas[key].count, 100);
    assert.equal(normalized.dataAreas[key].values.length, 100);
  }

  assert.deepEqual(validateEndpointDraft({
    transport: 'modbus-tcp-slave',
    config: {
      listenHost: '127.0.0.1',
      listenPort: 1502,
      dataAreas: {
        coils: { start: 65_535, count: 2, values: [false, true] },
        holdingRegisters: { start: 0, count: 2, values: [1, 70_000] },
      },
    },
  }), {
    coilsCount: '数量必须为 1 到 10000，且地址不能超过 65535。',
    holdingRegistersValues: '寄存器数据必须为 0 到 65535 的整数，且不能超过配置数量。',
  });
  assert.deepEqual(validateEndpointDraft({
    transport: 'modbus-rtu-slave',
    config: {
      path: '/dev/ttyUSB0',
      dataAreas: { discreteInputs: { start: 0, count: 1, values: ['0'] } },
    },
  }), {
    discreteInputsValues: '位数据只能为 true、false、0 或 1，且不能超过配置数量。',
  });
});

test('unsupported or malformed drafts produce deterministic validation errors', () => {
  assert.deepEqual(validateEndpointDraft(), { transport: '请选择支持的传输类型。' });
  assert.deepEqual(
    validateEndpointDraft({ transport: 'websocket', config: {} }),
    { transport: '请选择支持的传输类型。' },
  );
});

test('Modbus slave normalization does not allocate values for an oversized data area', () => {
  const count = MAX_MODBUS_AREA_COUNT + 1;
  const config = { dataAreas: { coils: { start: 0, count, values: [true] } } };
  const normalized = normalizeModbusConfig(config, 'modbus-tcp-slave');
  assert.equal(normalized.dataAreas.coils.count, count);
  assert.equal(normalized.dataAreas.coils.values.length, 0);
  assert.ok(validateEndpointDraft({ transport: 'modbus-tcp-slave', config }).coilsCount);
});

test('Modbus slave validation rejects noninteger source ranges instead of accepting normalized defaults', () => {
  for (const invalid of [Infinity, NaN, 1.5, '10', null]) {
    const config = { dataAreas: { coils: { start: invalid, count: invalid } } };
    const errors = validateEndpointDraft({ transport: 'modbus-tcp-slave', config });
    assert.ok(errors.coilsStart);
    assert.ok(errors.coilsCount);
  }
});

test('Modbus slave maximum data area preserves values and fills only within the configured limit', () => {
  const config = {
    dataAreas: { holdingRegisters: { start: 0, count: MAX_MODBUS_AREA_COUNT, values: [123, 65535] } },
  };
  const normalized = normalizeModbusConfig(config, 'modbus-tcp-slave');
  const values = normalized.dataAreas.holdingRegisters.values;
  assert.equal(values.length, MAX_MODBUS_AREA_COUNT);
  assert.deepEqual(values.slice(0, 3), [123, 65535, 0]);
  assert.equal(values.at(-1), 0);
  assert.deepEqual(config.dataAreas.holdingRegisters.values, [123, 65535]);
  assert.deepEqual(validateEndpointDraft({ transport: 'modbus-tcp-slave', config }), {});
});
