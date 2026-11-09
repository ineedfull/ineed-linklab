const FUNCTION_NAMES = Object.freeze({
  0: '本地修改',
  1: '读取线圈',
  2: '读取离散输入',
  3: '读取保持寄存器',
  4: '读取输入寄存器',
  5: '写单个线圈',
  6: '写单个寄存器',
  15: '写多个线圈',
  16: '写多个寄存器',
});

export function describeModbusTransaction(transaction, { capturedFramesOnly = false } = {}) {
  const functionCode = Number(transaction?.functionCode ?? 0);
  if (functionCode === 0) {
    return {
      functionLabel: FUNCTION_NAMES[0],
      requestHex: '',
      responseHex: '',
      requestSegments: [],
      responseSegments: [],
      requestFrameUnavailable: false,
      responseFrameUnavailable: false,
      framesUnavailable: false,
      requestText: `本地写入 ${transaction?.quantity ?? 0} 项`,
      responseText: '数据区已更新',
    };
  }
  const capturedRequest = capturedFrame(transaction?.requestFrame, transaction?.transport);
  const capturedResponse = capturedFrame(transaction?.responseFrame, transaction?.transport);
  const request = capturedRequest ?? (capturedFramesOnly
    ? []
    : completeFrame(transaction, requestPdu(transaction)));
  const response = capturedResponse ?? (capturedFramesOnly
    ? []
    : completeFrame(transaction, responsePdu(transaction)));
  return {
    functionLabel: `FC${String(functionCode).padStart(2, '0')} ${FUNCTION_NAMES[functionCode] ?? '未知功能'}`,
    requestHex: formatHex(request),
    responseHex: formatHex(response),
    requestSegments: frameSegments(transaction?.transport, request, request),
    responseSegments: frameSegments(transaction?.transport, response, response),
    requestFrameCaptured: capturedRequest !== null,
    responseFrameCaptured: capturedResponse !== null,
    requestFrameUnavailable: capturedFramesOnly && capturedRequest === null,
    responseFrameUnavailable: capturedFramesOnly && capturedResponse === null,
    framesUnavailable: capturedFramesOnly && (capturedRequest === null || capturedResponse === null),
    requestText: `站号 ${transaction.unitId} · 地址 ${transaction.address} · 数量 ${transaction.quantity}`,
    responseText: transaction.success
      ? `成功 · ${transaction.durationMs} ms`
      : `失败 · ${transaction.message ?? 'Modbus 异常'}`,
  };
}

function capturedFrame(value, transport) {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((byte) => integerInRange(byte, 0, 255))) return null;
  if (transport?.includes('-tcp-')) {
    if (value.length < 8 || value[2] !== 0 || value[3] !== 0) return null;
    const declaredLength = (value[4] << 8) | value[5];
    return declaredLength >= 2 && declaredLength === value.length - 6 ? value : null;
  }
  if (transport?.includes('-rtu-')) {
    if (value.length < 4) return null;
    const checksum = modbusCrc16(value.slice(0, -2));
    return value.at(-2) === (checksum & 0xff) && value.at(-1) === ((checksum >> 8) & 0xff)
      ? value : null;
  }
  return null;
}

function frameSegments(transport, bytes, captured) {
  if (!capturedFrame(captured, transport)) return [];
  if (transport?.includes('-tcp-') && bytes.length >= 8) {
    return [
      segment('transaction-id', '事务 ID', bytes.slice(0, 2)),
      segment('protocol-id', '协议 ID', bytes.slice(2, 4)),
      segment('length', '长度', bytes.slice(4, 6)),
      segment('unit-id', '单元 ID', bytes.slice(6, 7)),
      segment('function-code', '功能码', bytes.slice(7, 8)),
      segment('data', '数据', bytes.slice(8)),
    ].filter(({ hex }) => hex);
  }
  if (transport?.includes('-rtu-') && bytes.length >= 4) {
    return [
      segment('slave-address', '从站地址', bytes.slice(0, 1)),
      segment('function-code', '功能码', bytes.slice(1, 2)),
      segment('data', '数据', bytes.slice(2, -2)),
      segment('crc16', 'CRC16', bytes.slice(-2)),
    ].filter(({ hex }) => hex);
  }
  return [];
}

function segment(key, label, bytes) {
  return { key, label, hex: formatHex(bytes) };
}

function completeFrame(transaction, pdu) {
  if (pdu.length === 0) return [];
  const transport = transaction?.transport;
  const unitId = integerInRange(transaction?.unitId, 1, 247) ? transaction.unitId : 1;
  if (transport?.includes('-tcp-')) {
    const transactionId = integerInRange(transaction?.transactionId, 0, 65_535)
      ? transaction.transactionId
      : 0;
    const body = [unitId, ...pdu];
    return [...word(transactionId), 0x00, 0x00, ...word(body.length), ...body];
  }
  if (transport?.includes('-rtu-')) {
    const body = [unitId, ...pdu];
    const checksum = modbusCrc16(body);
    return [...body, checksum & 0xff, (checksum >> 8) & 0xff];
  }
  return pdu;
}

export function formatModbusRequestPdu(request) {
  if (!validConfiguredRequest(request)) return '';
  return formatHex(requestPdu({
    ...request,
    requestValues: request.values,
  }));
}

export function formatModbusRequestFrame(request, {
  transport,
  unitId,
  transactionId = 0,
} = {}) {
  if (!validConfiguredRequest(request) || !integerInRange(unitId, 1, 247)) return '';
  const pdu = requestPdu({ ...request, requestValues: request.values });
  if (transport === 'modbus-tcp-master') {
    if (!integerInRange(transactionId, 0, 65_535)) return '';
    const body = [unitId, ...pdu];
    return formatHex([...word(transactionId), 0x00, 0x00, ...word(body.length), ...body]);
  }
  if (transport === 'modbus-rtu-master') {
    const body = [unitId, ...pdu];
    const checksum = modbusCrc16(body);
    return formatHex([...body, checksum & 0xff, (checksum >> 8) & 0xff]);
  }
  return '';
}

function requestPdu(transaction) {
  const code = transaction.functionCode;
  const address = word(transaction.address);
  const quantity = word(transaction.quantity);
  const values = Array.isArray(transaction.requestValues)
    ? transaction.requestValues
    : Array.isArray(transaction.values) ? transaction.values : [];
  if (code >= 1 && code <= 4) return [code, ...address, ...quantity];
  if (code === 5) return [code, ...address, ...(values[0] ? [0xff, 0x00] : [0x00, 0x00])];
  if (code === 6) return [code, ...address, ...word(values[0] ?? 0)];
  if (code === 15) {
    const packed = packBits(values);
    return [code, ...address, ...quantity, packed.length, ...packed];
  }
  if (code === 16) {
    const payload = values.flatMap((value) => word(value));
    return [code, ...address, ...quantity, payload.length, ...payload];
  }
  return [code];
}

function validConfiguredRequest(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) return false;
  const { functionCode, address, quantity, values } = request;
  if (!Number.isInteger(functionCode) || ![1, 2, 3, 4, 5, 6, 15, 16].includes(functionCode)) return false;
  if (!integerInRange(address, 0, 65_535) || !Number.isInteger(quantity)) return false;

  if (functionCode <= 4) {
    const maximum = functionCode <= 2 ? 2000 : 125;
    return integerInRange(quantity, 1, maximum) && address + quantity <= 65_536;
  }
  if (!Array.isArray(values) || quantity !== values.length || address + quantity > 65_536) return false;
  if (functionCode === 5) return quantity === 1 && typeof values[0] === 'boolean';
  if (functionCode === 6) return quantity === 1 && integerInRange(values[0], 0, 65_535);
  if (functionCode === 15) {
    return integerInRange(quantity, 1, 1968) && values.every((value) => typeof value === 'boolean');
  }
  return integerInRange(quantity, 1, 123)
    && values.every((value) => integerInRange(value, 0, 65_535));
}

function integerInRange(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function responsePdu(transaction) {
  const code = transaction.functionCode;
  if (!transaction.success) {
    if (!Number.isInteger(transaction.exceptionCode)) return [];
    return [code | 0x80, transaction.exceptionCode & 0xff];
  }
  const values = Array.isArray(transaction.values) ? transaction.values : [];
  if (code === 1 || code === 2) {
    const packed = packBits(values);
    return [code, packed.length, ...packed];
  }
  if (code === 3 || code === 4) {
    const payload = values.flatMap((value) => word(value));
    return [code, payload.length, ...payload];
  }
  if (code === 5 || code === 6) return requestPdu(transaction);
  if (code === 15 || code === 16) {
    return [code, ...word(transaction.address), ...word(transaction.quantity)];
  }
  return [code];
}

function packBits(values) {
  const bytes = [];
  for (let index = 0; index < values.length; index += 8) {
    let byte = 0;
    for (let bit = 0; bit < 8 && index + bit < values.length; bit += 1) {
      if (values[index + bit]) byte |= 1 << bit;
    }
    bytes.push(byte);
  }
  return bytes;
}

function word(value) {
  const normalized = Number(value) & 0xffff;
  return [(normalized >> 8) & 0xff, normalized & 0xff];
}

function modbusCrc16(bytes) {
  let checksum = 0xffff;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = checksum & 1 ? (checksum >> 1) ^ 0xa001 : checksum >> 1;
    }
  }
  return checksum & 0xffff;
}

function formatHex(bytes) {
  return bytes.map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}
