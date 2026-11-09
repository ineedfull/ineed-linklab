import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cloneModbusRequest,
  cloneModbusRequestGroup,
  normalizeModbusMasterConfig,
  validateModbusMasterSettings,
  validateModbusRequestGroups,
} from '../src/model/modbusMasterConfig.js';

test('legacy master config gains an empty stopped schedule without losing connection fields', () => {
  const source = { host: '192.0.2.10', port: 1502, unitId: 7, timeoutMs: 800 };
  const normalized = normalizeModbusMasterConfig(source);

  assert.equal(normalized.host, '192.0.2.10');
  assert.equal(normalized.port, 1502);
  assert.equal(normalized.unitId, 7);
  assert.equal(normalized.timeoutMs, 800);
  assert.equal(normalized.configVersion, 3);
  assert.equal(normalized.enabled, true);
  assert.deepEqual(normalized.scheduler, { minGapMs: 50, autoStart: false });
  assert.deepEqual(normalized.requestGroups, []);
  assert.deepEqual(normalized.writeCommands, []);
  assert.deepEqual(source, { host: '192.0.2.10', port: 1502, unitId: 7, timeoutMs: 800 });
});

test('master normalization preserves write commands and validation reports their fields', () => {
  const source = {
    host: '192.0.2.10', custom: 'preserved',
    writeCommands: [{
      id: 'set-target', name: '设定目标', description: '', enabled: true, order: 4,
      unitId: 1, functionCode: 16, address: 20, values: [100, 200],
    }],
  };
  const normalized = normalizeModbusMasterConfig(source);

  assert.equal(normalized.custom, 'preserved');
  assert.deepEqual(normalized.writeCommands, [{ ...source.writeCommands[0], order: 0 }]);
  assert.deepEqual(validateModbusMasterSettings({ writeCommands: 'invalid' }), {
    writeCommands: '写入指令配置格式无效。',
  });
});

test('version 2 request groups migrate into deterministic version 3 child requests', () => {
  const normalized = normalizeModbusMasterConfig({
    configVersion: 2,
    requestGroups: [{
      id: 'boiler', name: '锅炉房', unitId: 7, enabled: true, order: 0,
      functionCode: 3, startAddress: 100, quantity: 10, intervalMs: 2000,
      timeoutMs: null, retryCount: null, retryIntervalMs: null,
      dataPoints: [{
        id: 'temperature', key: 'temperature', name: '温度', enabled: true,
        offset: 0, dataType: 'float32', length: 2,
      }],
    }],
  });

  assert.equal(normalized.configVersion, 3);
  assert.deepEqual(normalized.requestGroups[0], {
    id: 'boiler', name: '锅炉房', description: '', unitId: 7, enabled: true, order: 0,
    requests: [{
      id: 'boiler-request', name: '锅炉房请求', enabled: true, order: 0,
      functionCode: 3, startAddress: 100, quantity: 10, intervalMs: 2000,
      timeoutMs: null, retryCount: null, retryIntervalMs: null,
      dataPoints: [assertNormalizedPoint({
        id: 'temperature', key: 'temperature', name: '温度',
        dataType: 'float32', length: 2,
      })],
    }],
  });
  assert.deepEqual(normalizeModbusMasterConfig(normalized), normalized);
});

test('request normalization derives fixed widths and preserves nullable overrides', () => {
  const [group] = normalizeModbusMasterConfig({ requestGroups: [{
    id: 'temperatures', name: '温度区', unitId: 2,
    requests: [{
      id: 'holding', name: '温度寄存器', functionCode: 3,
      startAddress: 100, quantity: 10, intervalMs: 2000,
      timeoutMs: null, retryCount: null, retryIntervalMs: null,
      dataPoints: [{
        id: 'outlet', key: 'outlet_temperature', name: '出水温度', offset: 0,
        dataType: 'float32', length: 9, scale: 0.1, valueOffset: -20,
      }],
    }],
  }] }).requestGroups;

  assert.equal(group.enabled, true);
  assert.equal(group.order, 0);
  assert.equal(group.description, '');
  assert.equal(group.requests[0].dataPoints[0].length, 2);
  assert.equal(group.requests[0].dataPoints[0].byteOrder, 'big-endian');
  assert.equal(group.requests[0].dataPoints[0].wordOrder, 'high-first');
  assert.equal(group.requests[0].dataPoints[0].invalidPolicy, 'mark-bad');
  assert.equal(group.requests[0].dataPoints[0].saveHistory, false);
});

test('preserves exact unsafe 64-bit integer bounds and compares them without rounding', () => {
  const group = groupWithRequests([requestWithPoints([point({
    dataType: 'uint64',
    minimum: '9007199254740995',
    maximum: '18446744073709551615',
  })])]);
  const normalized = normalizeModbusMasterConfig({ requestGroups: [group] });
  const normalizedPoint = normalized.requestGroups[0].requests[0].dataPoints[0];

  assert.equal(normalizedPoint.minimum, '9007199254740995');
  assert.equal(normalizedPoint.maximum, '18446744073709551615');
  assert.deepEqual(validateModbusRequestGroups(normalized.requestGroups, normalized), {});

  const errors = validateModbusRequestGroups([groupWithRequests([requestWithPoints([point({
    dataType: 'uint64',
    minimum: '9007199254740996',
    maximum: '9007199254740995',
  })])])], normalized);
  assert.equal(
    errors['requestGroup-0-request-0-point-0-minimum'],
    '合理值下限不能大于上限。',
  );
});

test('preserves exact decimal-string bounds for scaled 64-bit points', () => {
  const normalized = normalizeModbusMasterConfig({
    requestGroups: [groupWithRequests([requestWithPoints([point({
      dataType: 'uint64', scale: 0.1,
      minimum: '0.01', maximum: '900719925474099.59',
    })])])],
  });
  const normalizedPoint = normalized.requestGroups[0].requests[0].dataPoints[0];

  assert.equal(normalizedPoint.minimum, '0.01');
  assert.equal(normalizedPoint.maximum, '900719925474099.59');
  assert.deepEqual(validateModbusRequestGroups(normalized.requestGroups, normalized), {});
});

test('treats whitespace-only point bounds as unlimited', () => {
  const normalized = normalizeModbusMasterConfig({
    requestGroups: [groupWithRequests([requestWithPoints([point({
      dataType: 'uint64', minimum: '   ', maximum: '\t',
    })])])],
  });
  const normalizedPoint = normalized.requestGroups[0].requests[0].dataPoints[0];

  assert.equal(normalizedPoint.minimum, null);
  assert.equal(normalizedPoint.maximum, null);
});

test('rejects impractically large decimal bounds without throwing', () => {
  const groups = [groupWithRequests([requestWithPoints([point({
    dataType: 'uint64', maximum: '1e4294967296',
  })])])];
  let normalized;

  assert.doesNotThrow(() => {
    normalized = normalizeModbusMasterConfig({ requestGroups: groups });
  });
  assert.equal(Number.isNaN(
    normalized.requestGroups[0].requests[0].dataPoints[0].maximum,
  ), true);
  assert.equal(
    validateModbusRequestGroups(groups, normalized)['requestGroup-0-request-0-point-0-maximum'],
    '合理值上限必须是有效数字。',
  );
});

test('point history policy defaults enabled legacy points to on-change', () => {
  const normalized = normalizeModbusMasterConfig({
    requestGroups: [groupWithRequests([requestWithPoints([
      point({ saveHistory: true, historyMode: undefined }),
    ])])],
  });

  assert.equal(normalized.requestGroups[0].requests[0].dataPoints[0].saveHistory, true);
  assert.equal(normalized.requestGroups[0].requests[0].dataPoints[0].historyMode, 'on-change');
});

test('a persisted capture mode does not enable disabled point history', () => {
  const normalized = normalizeModbusMasterConfig({
    requestGroups: [groupWithRequests([requestWithPoints([
      point({ saveHistory: false, historyMode: 'every-poll' }),
    ])])],
  });

  assert.equal(normalized.requestGroups[0].requests[0].dataPoints[0].saveHistory, false);
  assert.equal(normalized.requestGroups[0].requests[0].dataPoints[0].historyMode, 'every-poll');
});

test('enabled point history preserves every-poll mode through normalization', () => {
  const source = {
    requestGroups: [groupWithRequests([requestWithPoints([
      point({ saveHistory: true, historyMode: 'every-poll' }),
    ])])],
  };

  const normalized = normalizeModbusMasterConfig(source);

  assert.equal(normalized.requestGroups[0].requests[0].dataPoints[0].historyMode, 'every-poll');
  assert.deepEqual(normalizeModbusMasterConfig(normalized), normalized);
});

test('nested validation rejects protocol overflow, duplicate keys and out-of-range points', () => {
  const errors = validateModbusRequestGroups([{
    id: 'read-a', name: 'A', enabled: true, order: 0, unitId: 248,
    requests: [{
      id: 'holding', name: '保持寄存器', enabled: true, order: 0,
      functionCode: 3, startAddress: 65_530, quantity: 126, intervalMs: 50,
      dataPoints: [
        { id: 'p1', key: 'pressure', name: '压力', offset: 0, dataType: 'uint32' },
        { id: 'p2', key: 'pressure', name: '温度', offset: 125, dataType: 'float32' },
      ],
    }],
  }], normalizeModbusMasterConfig({}));

  assert.equal(errors['requestGroup-0-unitId'], '从站 ID 必须为 1 到 247 的整数。');
  assert.equal(errors['requestGroup-0-request-0-quantity'], 'FC03 单次最多读取 125 个寄存器，且地址不能超过 65535。');
  assert.equal(errors['requestGroup-0-request-0-intervalMs'], '轮询周期必须为 100 到 3600000 毫秒。');
  assert.equal(errors['requestGroup-0-request-0-point-1-key'], '数据点标识在请求组内必须唯一。');
  assert.equal(errors['requestGroup-0-request-0-point-1-offset'], '数据点超出请求响应范围。');
});

test('request IDs are unique within a group and point identities are unique across its requests', () => {
  const errors = validateModbusRequestGroups([groupWithRequests([
    requestWithPoints([point({ id: 'shared', key: 'shared' })], { id: 'same' }),
    requestWithPoints([point({ id: 'shared', key: 'shared' })], { id: 'same', functionCode: 4 }),
  ])], normalizeModbusMasterConfig({}));

  assert.equal(errors['requestGroup-0-request-1-id'], '请求标识在请求组内必须唯一。');
  assert.equal(errors['requestGroup-0-request-1-point-0-id'], '数据点标识在请求组内必须唯一。');
  assert.equal(errors['requestGroup-0-request-1-point-0-key'], '数据点标识在请求组内必须唯一。');
});

test('register bit views may share a word but ordinary point ranges may not overlap', () => {
  const master = normalizeModbusMasterConfig({});
  const bitViewErrors = validateModbusRequestGroups([groupWithRequests([requestWithPoints([
    point({ id: 'run', key: 'run', dataType: 'boolean', offset: 0, bitIndex: 0 }),
    point({ id: 'alarm', key: 'alarm', dataType: 'boolean', offset: 0, bitIndex: 3 }),
  ])])], master);
  assert.deepEqual(bitViewErrors, {});

  const overlapErrors = validateModbusRequestGroups([groupWithRequests([requestWithPoints([
    point({ id: 'wide', key: 'wide', dataType: 'uint32', offset: 0 }),
    point({ id: 'word', key: 'word', dataType: 'uint16', offset: 1 }),
  ])])], master);
  assert.equal(overlapErrors['requestGroup-0-request-0-point-1-offset'], '数据点范围与同一请求的其他数据点重叠。');
});

test('disabled points may stay parked outside the active response range', () => {
  const errors = validateModbusRequestGroups([groupWithRequests([requestWithPoints([
    point({ id: 'active', key: 'active', offset: 0 }),
    point({ id: 'parked', key: 'parked', enabled: false, offset: 99, dataType: 'uint32' }),
  ])])], normalizeModbusMasterConfig({}));

  assert.equal(errors['requestGroup-0-request-0-point-1-offset'], undefined);
});

test('cloning a request group assigns fresh group, request and point identities', () => {
  let index = 0;
  const clone = cloneModbusRequestGroup(groupWithRequests([
    requestWithPoints([point({ id: 'source-point', key: 'value' })], { id: 'source-request' }),
  ]), (kind) => `${kind}-${++index}`);

  assert.equal(clone.id, 'group-1');
  assert.equal(clone.name, '读取区副本');
  assert.equal(clone.requests[0].id, 'request-2');
  assert.equal(clone.requests[0].dataPoints[0].id, 'point-3');
  assert.equal(clone.requests[0].dataPoints[0].key, 'value_copy');
});

test('cloning one request leaves the source untouched and assigns fresh nested identities', () => {
  const source = requestWithPoints([point({ id: 'source-point', key: 'value' })], {
    id: 'source-request', name: '温度',
  });
  let index = 0;
  const clone = cloneModbusRequest(source, (kind) => `${kind}-${++index}`);

  assert.equal(clone.id, 'request-1');
  assert.equal(clone.name, '温度副本');
  assert.equal(clone.dataPoints[0].id, 'point-2');
  assert.equal(clone.dataPoints[0].key, 'value_copy');
  assert.equal(source.dataPoints[0].id, 'source-point');
});

test('cloning a request chooses point keys that remain unique within its destination group', () => {
  const source = requestWithPoints([point({ id: 'source-point', key: 'value' })]);
  let index = 0;
  const first = cloneModbusRequest(source, (kind) => `${kind}-${++index}`, ['value']);
  const second = cloneModbusRequest(
    source,
    (kind) => `${kind}-${++index}`,
    ['value', first.dataPoints[0].key],
  );

  assert.equal(first.dataPoints[0].key, 'value_copy');
  assert.equal(second.dataPoints[0].key, 'value_copy_2');
});

function groupWithRequests(requests) {
  return {
    id: 'source', name: '读取区', enabled: true, order: 0, unitId: 1,
    description: '', requests,
  };
}

function requestWithPoints(dataPoints, overrides = {}) {
  return {
    id: 'request', name: '读取请求', enabled: true, order: 0,
    functionCode: 3, startAddress: 100, quantity: 10, intervalMs: 1000,
    timeoutMs: null, retryCount: null, retryIntervalMs: null, dataPoints,
    ...overrides,
  };
}

function point(overrides = {}) {
  return {
    id: 'point', key: 'point', name: '数据点', enabled: true, offset: 0,
    dataType: 'uint16', length: 1, byteOrder: 'big-endian', wordOrder: 'high-first',
    bitIndex: null, scale: 1, valueOffset: 0, unit: '', decimals: null,
    minimum: null, maximum: null, invalidPolicy: 'mark-bad', saveHistory: false,
    historyMode: 'on-change',
    ...overrides,
  };
}

function assertNormalizedPoint(overrides = {}) {
  return point(overrides);
}


test('request validation rejects explicit invalid numeric drafts before defaults can hide them', () => {
  for (const value of ['', ' ', 1.5, NaN, Infinity, null, true]) {
    const errors = validateModbusRequestGroups([groupWithRequests([
      requestWithPoints([], { startAddress: value, quantity: value }),
    ])]);
    assert.ok(errors['requestGroup-0-request-0-startAddress'], `address ${String(value)}`);
    assert.ok(errors['requestGroup-0-request-0-quantity'], `quantity ${String(value)}`);
    const groupErrors = validateModbusRequestGroups([{ ...groupWithRequests([]), unitId: value }]);
    assert.ok(groupErrors['requestGroup-0-unitId'], `unitId ${String(value)}`);
  }
});

test('request validation preserves omitted legacy defaults and accepts nonblank numeric strings', () => {
  assert.deepEqual(validateModbusRequestGroups([{ name: '旧请求组', requests: [{ name: '旧请求' }] }]), {});
  assert.deepEqual(validateModbusRequestGroups([{ name: '旧V2请求组', functionCode: 3 }]), {});
  assert.deepEqual(validateModbusRequestGroups([{ ...groupWithRequests([
    requestWithPoints([], { startAddress: '0', quantity: '125' }),
  ]), unitId: '247' }]), {});
});
