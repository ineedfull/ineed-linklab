import { describeModbusTransaction, formatModbusRequestFrame } from './modbusCommands.js';

// These conversions only read their inputs. Keep captured-frame diagnostics and
// generated-frame fallbacks together so the component only chooses what to render.
export function transactionIdentity(transaction) {
  return JSON.stringify([
    transaction.endpointId, transaction.sessionId, transaction.origin,
    transaction.requestGroupId, transaction.requestId,
    transaction.functionCode, transaction.unitId, transaction.address, transaction.quantity,
    transaction.requestValues, transaction.values,
    transaction.success, transaction.exceptionCode, transaction.message,
    transaction.createdAt, transaction.durationMs,
  ]);
}


export function successRate(groupStatus) {
  const success = groupStatus?.successCount ?? 0;
  const total = success + (groupStatus?.failureCount ?? 0);
  return total === 0 ? '—' : `${((success / total) * 100).toFixed(1)}%`;
}


export { formatTimestamp as formatTime } from './dateTime.js';


export function formatRaw(values) {
  if (!Array.isArray(values)) return values === undefined || values === null ? '—' : String(values);
  return values.length
    ? values.map((value) => typeof value === 'boolean' ? Number(value) : value).join(', ')
    : '—';
}


export function writeAddressRange(command) {
  const quantity = Array.isArray(command.values) ? command.values.length : 0;
  if (!Number.isInteger(command.address) || quantity === 0) return '地址配置无效';
  const end = command.address + quantity - 1;
  return end === command.address ? `地址 ${command.address}` : `地址 ${command.address}–${end}`;
}


/** Build display helpers for one explicit endpoint/config/session snapshot. */
export function createModbusMasterPresentation({ endpoint, sessionId, config, records }) {
  return {
    readRequestFrame,
    writeCommandFrame,
    transactionRequestFrame,
    transactionCommand,
    transactionTransport,
    isTcpTransaction,
    transactionProtocolTitle,
    transactionProtocolDescription,
    transactionFrameHeading,
    transactionSegmentHex,
    transactionRequestHex,
    transactionResponseHex,
    transactionGroupName,
    transactionRequestName,
    transactionRecord,
    transactionFromRecord,
    transactionFrameType,
    requestFrameTitle,
  };

  function readRequestFrame(group, request) {
    return formatModbusRequestFrame({
      functionCode: request.functionCode,
      address: request.startAddress,
      quantity: request.quantity,
      values: [],
    }, {
      transport: endpoint.transport,
      unitId: group.unitId,
    }) || '配置无效，无法生成指令';
  }


  function writeCommandFrame(command) {
    return formatModbusRequestFrame({
      functionCode: command.functionCode,
      address: command.address,
      quantity: Array.isArray(command.values) ? command.values.length : 0,
      values: command.values,
    }, {
      transport: endpoint.transport,
      unitId: command.unitId,
    }) || '配置无效，无法生成指令';
  }


  function transactionRequestFrame(transaction) {
    return formatModbusRequestFrame({
      functionCode: transaction.functionCode,
      address: transaction.address,
      quantity: transaction.quantity,
      values: transaction.requestValues,
    }, {
      transport: endpoint.transport,
      unitId: transaction.unitId,
      transactionId: transaction.transactionId ?? 0,
    }) || describeModbusTransaction(transaction).requestHex;
  }


  function transactionCommand(transaction) {
    return describeModbusTransaction({
      ...transaction,
      transport: transaction.transport ?? endpoint.transport,
    });
  }


  function transactionTransport(transaction) {
    return transaction.transport ?? endpoint.transport;
  }


  function isTcpTransaction(transaction) {
    return transactionTransport(transaction).includes('-tcp-');
  }


  function transactionProtocolTitle(transaction) {
    return isTcpTransaction(transaction) ? 'Modbus TCP 报文' : 'Modbus RTU 报文';
  }


  function transactionProtocolDescription(transaction) {
    return isTcpTransaction(transaction)
      ? 'TCP ADU · MBAP + PDU · 不包含 CRC'
      : 'RTU 帧 · 从站地址 + PDU + CRC16';
  }


  function transactionFrameHeading(transaction, direction) {
    if (isTcpTransaction(transaction)) return direction === 'request' ? 'TCP TX 请求 ADU' : 'TCP RX 响应 ADU';
    return direction === 'request' ? 'RTU TX 请求帧' : 'RTU RX 响应帧';
  }


  function transactionSegmentHex(transaction, direction, key) {
    const command = transactionCommand(transaction);
    const segments = direction === 'request' ? command.requestSegments : command.responseSegments;
    return segments.find((segment) => segment.key === key)?.hex ?? '—';
  }


  function transactionRequestHex(transaction) {
    const command = transactionCommand(transaction);
    return command.requestSegments.length ? command.requestHex : transactionRequestFrame(transaction);
  }


  function transactionResponseHex(transaction) {
    return transactionCommand(transaction).responseHex;
  }


  function transactionGroupName(transaction) {
    return config.requestGroups.find(({ id }) => id === transaction.requestGroupId)?.name ?? '按需操作';
  }


  function transactionRequestName(transaction) {
    const group = config.requestGroups.find(({ id }) => id === transaction.requestGroupId);
    return group?.requests.find(({ id }) => id === transaction.requestId)?.name ?? '临时指令';
  }


  function transactionRecord(transaction) {
    const identity = transactionIdentity(transaction);
    return records.find((record) => (
      (record.transaction && transactionIdentity(record.transaction) === identity)
      || (
        record.groupId === transaction.requestGroupId
        && record.requestId === transaction.requestId
        && record.createdAt === transaction.createdAt
      )
    )) ?? null;
  }


  function transactionFromRecord(record) {
    const group = config.requestGroups.find(({ id }) => id === (record.requestGroupId ?? record.groupId));
    const request = group?.requests.find(({ id }) => id === record.requestId);
    if (!group || !request) return null;
    return {
      endpointId: endpoint.id,
      sessionId: sessionId,
      origin: 'master',
      transport: endpoint.transport,
      requestGroupId: group.id,
      requestId: request.id,
      functionCode: request.functionCode,
      unitId: group.unitId,
      address: request.startAddress,
      quantity: request.quantity,
      requestValues: [],
      values: [],
      success: record.success,
      exceptionCode: null,
      message: record.error,
      createdAt: record.createdAt,
      durationMs: record.durationMs,
    };
  }


  function transactionFrameType(transaction, direction) {
    const command = transactionCommand(transaction);
    const captured = direction === 'request' ? command.requestFrameCaptured : command.responseFrameCaptured;
    if (captured) return '捕获完整帧';
    if (direction === 'request' && transactionRequestHex(transaction)) return '根据指令生成';
    if (direction === 'response' && transactionResponseHex(transaction)) return '根据结果生成';
    return '未捕获';
  }


  function requestFrameTitle() {
    return endpoint.transport === 'modbus-tcp-master'
      ? '完整 TCP 请求帧；事务 ID 由运行时动态生成，00 00 为模板值'
      : '完整 RTU 请求帧，包含从站地址和 CRC16';
  }
}
