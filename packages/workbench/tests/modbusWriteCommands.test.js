import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cloneModbusWriteCommand,
  normalizeModbusWriteCommands,
  validateModbusWriteCommands,
} from '../src/model/modbusWriteCommands.js';
import * as modbusWriteCommands from '../src/model/modbusWriteCommands.js';

test('normalizes ordered write commands without aliasing values', () => {
  const source = [{
    id: 'target', name: '设定目标', description: '', enabled: true, order: 2,
    unitId: 7, functionCode: 16, address: 20, values: [100, 200],
  }];
  const normalized = normalizeModbusWriteCommands(source);

  assert.deepEqual(normalized[0], { ...source[0], order: 0 });
  assert.notEqual(normalized[0].values, source[0].values);
  assert.deepEqual(normalizeModbusWriteCommands(normalized), normalized);
});

test('preserves explicitly malformed execution fields so validation cannot be bypassed', () => {
  const source = command({
    enabled: 'yes', unitId: '7', functionCode: '16', address: '20',
    values: [100, '200'],
  });
  const normalized = normalizeModbusWriteCommands([source]);

  assert.deepEqual(normalized[0], { ...source, order: 0 });
  assert.notEqual(normalized[0].values, source.values);
  assert.deepEqual(validateModbusWriteCommands(normalized), {
    'writeCommand-0-enabled': '写入指令启用状态必须为布尔值。',
    'writeCommand-0-unitId': '从站 ID 必须为 1 到 247 的整数。',
    'writeCommand-0-functionCode': '写入仅支持 FC05、FC06、FC15 或 FC16。',
    'writeCommand-0-address': '写入地址必须为 0 到 65535 的整数。',
  });
});

test('preserves a non-array values field through normalization and cloning', () => {
  const source = command({ values: 'true' });
  const normalized = normalizeModbusWriteCommands([source]);
  const cloned = cloneModbusWriteCommand(normalized[0], () => 'write-copy');

  assert.equal(normalized[0].values, 'true');
  assert.equal(cloned.values, 'true');
  assert.deepEqual(validateModbusWriteCommands(normalized), {
    'writeCommand-0-values': '写入值配置格式无效。',
  });
});

test('clones a command with fresh identity and isolated values', () => {
  const source = command();
  const clone = cloneModbusWriteCommand(source, () => 'write-copy');

  assert.equal(clone.id, 'write-copy');
  assert.equal(clone.name, '设定目标副本');
  assert.notEqual(clone.values, source.values);
});

test('builds an isolated execution request from the current saved command', () => {
  assert.equal(typeof modbusWriteCommands.buildModbusWriteRequest, 'function');
  const source = command({ unitId: 9, address: 30, values: [321, 654] });
  const request = modbusWriteCommands.buildModbusWriteRequest(source, 'master-1');
  source.values[0] = 999;

  assert.deepEqual(request, {
    endpointId: 'master-1', functionCode: 16, unitId: 9,
    address: 30, quantity: 2, values: [321, 654],
  });
});

test('validates exact write command protocol limits and malformed value arrays', () => {
  assert.deepEqual(validateModbusWriteCommands('invalid'), {
    writeCommands: '写入指令配置格式无效。',
  });
  assert.deepEqual(validateModbusWriteCommands([{ ...command(), functionCode: 16, address: 65535, values: [1, 2] }]), {
    'writeCommand-0-values': '写入范围不能超过地址 65535。',
  });
  const errors = validateModbusWriteCommands([
    { ...command(), id: 'same', name: ' ', unitId: 0, functionCode: 3, address: -1, values: '1' },
    { ...command(), id: 'same', unitId: 248, functionCode: 5, values: [true, false] },
    { ...command(), functionCode: 6, values: [-1] },
    { ...command(), functionCode: 15, values: [] },
    { ...command(), functionCode: 15, values: [true, 1] },
    { ...command(), functionCode: 15, values: Array.from({ length: 1969 }, () => true) },
    { ...command(), functionCode: 16, values: [] },
    { ...command(), functionCode: 16, values: Array.from({ length: 124 }, () => 1) },
    { ...command(), functionCode: 16, values: [65536] },
  ]);

  assert.equal(errors['writeCommand-0-name'], '请输入写入指令名称。');
  assert.equal(errors['writeCommand-0-unitId'], '从站 ID 必须为 1 到 247 的整数。');
  assert.equal(errors['writeCommand-0-functionCode'], '写入仅支持 FC05、FC06、FC15 或 FC16。');
  assert.equal(errors['writeCommand-0-address'], '写入地址必须为 0 到 65535 的整数。');
  assert.equal(errors['writeCommand-0-values'], '写入值配置格式无效。');
  assert.equal(errors['writeCommand-1-id'], '写入指令标识必须唯一。');
  assert.equal(errors['writeCommand-1-unitId'], '从站 ID 必须为 1 到 247 的整数。');
  assert.equal(errors['writeCommand-1-values'], 'FC05 必须写入一个布尔值。');
  assert.equal(errors['writeCommand-2-values'], 'FC06 必须写入一个 0 到 65535 的整数。');
  assert.equal(errors['writeCommand-3-values'], 'FC15 必须写入 1 到 1968 个布尔值。');
  assert.equal(errors['writeCommand-4-values'], 'FC15 必须写入 1 到 1968 个布尔值。');
  assert.equal(errors['writeCommand-5-values'], 'FC15 必须写入 1 到 1968 个布尔值。');
  assert.equal(errors['writeCommand-6-values'], 'FC16 必须写入 1 到 123 个 0 到 65535 的整数。');
  assert.equal(errors['writeCommand-7-values'], 'FC16 必须写入 1 到 123 个 0 到 65535 的整数。');
  assert.equal(errors['writeCommand-8-values'], 'FC16 必须写入 1 到 123 个 0 到 65535 的整数。');
});

function command(overrides = {}) {
  return {
    id: 'target', name: '设定目标', description: '', enabled: true, order: 0,
    unitId: 7, functionCode: 16, address: 20, values: [100, 200],
    ...overrides,
  };
}
