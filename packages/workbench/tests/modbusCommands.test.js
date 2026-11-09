import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeModbusTransaction,
  formatModbusRequestFrame,
  formatModbusRequestPdu,
} from '../src/model/modbusCommands.js';

test('formats configured read requests as stable Modbus request PDUs', () => {
  assert.equal(formatModbusRequestPdu({
    functionCode: 3, address: 100, quantity: 2, values: [],
  }), '03 00 64 00 02');
  assert.equal(formatModbusRequestPdu({
    functionCode: 1, address: 20, quantity: 10, values: [],
  }), '01 00 14 00 0A');
});

test('formats configured single and multiple writes as complete request PDUs', () => {
  assert.equal(formatModbusRequestPdu({
    functionCode: 5, address: 5, quantity: 1, values: [true],
  }), '05 00 05 FF 00');
  assert.equal(formatModbusRequestPdu({
    functionCode: 6, address: 20, quantity: 1, values: [100],
  }), '06 00 14 00 64');
  assert.equal(formatModbusRequestPdu({
    functionCode: 15, address: 5, quantity: 3, values: [true, false, true],
  }), '0F 00 05 00 03 01 05');
  assert.equal(formatModbusRequestPdu({
    functionCode: 16, address: 20, quantity: 2, values: [100, 200],
  }), '10 00 14 00 02 04 00 64 00 C8');
});

test('formats complete TCP and RTU request frames from one validated request', () => {
  const request = { functionCode: 3, address: 0, quantity: 10, values: [] };

  assert.equal(formatModbusRequestFrame(request, {
    transport: 'modbus-tcp-master', unitId: 1,
  }), '00 00 00 00 00 06 01 03 00 00 00 0A');
  assert.equal(formatModbusRequestFrame(request, {
    transport: 'modbus-tcp-master', unitId: 1, transactionId: 0x1234,
  }), '12 34 00 00 00 06 01 03 00 00 00 0A');
  assert.equal(formatModbusRequestFrame(request, {
    transport: 'modbus-rtu-master', unitId: 1,
  }), '01 03 00 00 00 0A C5 CD');
});

test('does not synthesize a PDU from malformed configured requests', () => {
  for (const request of [
    { functionCode: 3, address: 100, quantity: 0, values: [] },
    { functionCode: 3, address: '100', quantity: 2, values: [] },
    { functionCode: 5, address: 5, quantity: 1, values: ['true'] },
    { functionCode: 16, address: 65_535, quantity: 2, values: [1, 2] },
    { functionCode: 99, address: 0, quantity: 1, values: [] },
  ]) {
    assert.equal(formatModbusRequestPdu(request), '');
  }
});

test('describes register reads as paired Modbus request and response PDUs', () => {
  const command = describeModbusTransaction({
    functionCode: 3, unitId: 2, address: 100, quantity: 2,
    values: [0x1234, 0xabcd], success: true, durationMs: 8,
  });
  assert.equal(command.functionLabel, 'FC03 读取保持寄存器');
  assert.equal(command.requestHex, '03 00 64 00 02');
  assert.equal(command.responseHex, '03 04 12 34 AB CD');
  assert.equal(command.requestText, '站号 2 · 地址 100 · 数量 2');
});

test('reconstructs complete labelled master frames when raw wire bytes are unavailable', () => {
  const tcp = describeModbusTransaction({
    transport: 'modbus-tcp-master', transactionId: 0x1234,
    functionCode: 3, unitId: 2, address: 100, quantity: 2,
    values: [0x1234, 0xabcd], success: true, durationMs: 8,
  });
  assert.equal(tcp.requestHex, '12 34 00 00 00 06 02 03 00 64 00 02');
  assert.equal(tcp.responseHex, '12 34 00 00 00 07 02 03 04 12 34 AB CD');
  assert.equal(tcp.requestFrameCaptured, false);
  assert.equal(tcp.responseFrameCaptured, false);
  assert.deepEqual(tcp.responseSegments.map(({ label }) => label), [
    '事务 ID', '协议 ID', '长度', '单元 ID', '功能码', '数据',
  ]);

  const rtu = describeModbusTransaction({
    transport: 'modbus-rtu-master', functionCode: 6, unitId: 1,
    address: 2, quantity: 1, requestValues: [22], values: [22],
    success: true, durationMs: 1,
  });
  assert.equal(rtu.requestHex, '01 06 00 02 00 16 A9 C4');
  assert.equal(rtu.responseHex, '01 06 00 02 00 16 A9 C4');
  assert.equal(rtu.responseSegments.at(-1).label, 'CRC16');
});

test('describes captured Modbus TCP ADUs as complete labelled frame segments', () => {
  const command = describeModbusTransaction({
    transport: 'modbus-tcp-slave',
    functionCode: 6, unitId: 1, address: 2, quantity: 1,
    requestValues: [22], values: [22], success: true, durationMs: 1,
    requestFrame: [0x12, 0x34, 0x00, 0x00, 0x00, 0x06, 0x01, 0x06, 0x00, 0x02, 0x00, 0x16],
    responseFrame: [0x12, 0x34, 0x00, 0x00, 0x00, 0x06, 0x01, 0x06, 0x00, 0x02, 0x00, 0x16],
  });

  assert.equal(command.requestHex, '12 34 00 00 00 06 01 06 00 02 00 16');
  assert.deepEqual(command.requestSegments, [
    { key: 'transaction-id', label: '事务 ID', hex: '12 34' },
    { key: 'protocol-id', label: '协议 ID', hex: '00 00' },
    { key: 'length', label: '长度', hex: '00 06' },
    { key: 'unit-id', label: '单元 ID', hex: '01' },
    { key: 'function-code', label: '功能码', hex: '06' },
    { key: 'data', label: '数据', hex: '00 02 00 16' },
  ]);
  assert.deepEqual(command.responseSegments, command.requestSegments);
});

test('describes captured Modbus RTU frames with slave address and wire-order CRC16', () => {
  const command = describeModbusTransaction({
    transport: 'modbus-rtu-slave',
    functionCode: 6, unitId: 1, address: 2, quantity: 1,
    requestValues: [22], values: [22], success: true, durationMs: 1,
    requestFrame: [0x01, 0x06, 0x00, 0x02, 0x00, 0x16, 0xa9, 0xc4],
    responseFrame: [0x01, 0x06, 0x00, 0x02, 0x00, 0x16, 0xa9, 0xc4],
  });

  assert.equal(command.requestHex, '01 06 00 02 00 16 A9 C4');
  assert.deepEqual(command.requestSegments, [
    { key: 'slave-address', label: '从站地址', hex: '01' },
    { key: 'function-code', label: '功能码', hex: '06' },
    { key: 'data', label: '数据', hex: '00 02 00 16' },
    { key: 'crc16', label: 'CRC16', hex: 'A9 C4' },
  ]);
});

test('does not fabricate complete slave frames when captured bytes are unavailable or invalid', () => {
  for (const [transport, frameFields] of [
    ['modbus-tcp-slave', {}],
    ['modbus-tcp-slave', { requestFrame: [], responseFrame: [] }],
    ['modbus-tcp-slave', { requestFrame: [1, 3, -1], responseFrame: [1, 3, 256] }],
    ['modbus-tcp-slave', {
      requestFrame: [0, 1, 0, 0, 0, 6, 1, 3],
      responseFrame: [0, 1, 0, 0, 0, 5, 1, 3],
    }],
    ['modbus-rtu-slave', {
      requestFrame: [1, 6, 0, 2, 0, 22, 0, 0],
      responseFrame: [1, 6, 0, 2, 0, 22, 0, 0],
    }],
  ]) {
    const command = describeModbusTransaction({
      transport, functionCode: 3, unitId: 1,
      address: 0, quantity: 1, values: [42], success: true, durationMs: 1,
      ...frameFields,
    }, { capturedFramesOnly: true });

    assert.equal(command.requestHex, '');
    assert.equal(command.responseHex, '');
    assert.deepEqual(command.requestSegments, []);
    assert.deepEqual(command.responseSegments, []);
    assert.equal(command.framesUnavailable, true);
  }
});

test('reports the unavailable side without hiding the captured side of a slave transaction', () => {
  const command = describeModbusTransaction({
    transport: 'modbus-tcp-slave', functionCode: 6, unitId: 1,
    address: 2, quantity: 1, requestValues: [22], values: [], success: false,
    message: '连接断开', durationMs: 2,
    requestFrame: [0, 1, 0, 0, 0, 6, 1, 6, 0, 2, 0, 22],
  }, { capturedFramesOnly: true });

  assert.equal(command.requestHex, '00 01 00 00 00 06 01 06 00 02 00 16');
  assert.equal(command.responseHex, '');
  assert.equal(command.requestFrameUnavailable, false);
  assert.equal(command.responseFrameUnavailable, true);
  assert.equal(command.framesUnavailable, true);
});

test('describes multi-coil writes and exception responses', () => {
  const write = describeModbusTransaction({
    functionCode: 15, unitId: 1, address: 5, quantity: 3,
    values: [true, false, true], success: true, durationMs: 1,
  });
  assert.equal(write.requestHex, '0F 00 05 00 03 01 05');
  assert.equal(write.responseHex, '0F 00 05 00 03');

  const failed = describeModbusTransaction({
    functionCode: 4, unitId: 1, address: 0, quantity: 1,
    values: [], success: false, exceptionCode: 2, message: '非法地址', durationMs: 2,
  });
  assert.equal(failed.responseHex, '84 02');
  assert.equal(failed.responseText, '失败 · 非法地址');
});

test('does not synthesize a response PDU when a request fails before receiving one', () => {
  const failed = describeModbusTransaction({
    functionCode: 3, unitId: 1, address: 0, quantity: 2,
    requestValues: [], values: [], success: false, message: '请求超时', durationMs: 1000,
  });

  assert.equal(failed.requestHex, '03 00 00 00 02');
  assert.equal(failed.responseHex, '');
  assert.equal(failed.responseText, '失败 · 请求超时');
});
