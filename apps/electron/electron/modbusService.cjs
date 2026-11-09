const { protectCoilBatchVector } = require('./modbusCoilHandler.cjs');
const MODBUS_TRANSPORTS = new Set([
  'modbus-tcp-master', 'modbus-tcp-slave',
  'modbus-rtu-master', 'modbus-rtu-slave',
]);
const AREA_NAMES = new Set([
  'coils', 'discreteInputs', 'holdingRegisters', 'inputRegisters',
]);

class ModbusService {
  constructor({ ModbusRTU, emitTransportEvent = () => {}, emitModbusEvent = () => {} } = {}) {
    if (typeof ModbusRTU !== 'function') throw new TypeError('ModbusRTU is required');
    this.ModbusRTU = ModbusRTU;
    this.emitTransportEvent = emitTransportEvent;
    this.emitModbusEvent = emitModbusEvent;
    this.sessions = new Map();
    this.opening = new Map();
    this.closing = new Map();
    this.nextSessionId = 1;
    this.stopped = false;
  }

  async open(endpoint, options) {
    const operationId = typeof options === 'string' ? options : options?.operationId;
    requireId(endpoint?.id, 'endpoint.id');
    requireId(operationId, 'operationId');
    if (!MODBUS_TRANSPORTS.has(endpoint.transport)) throw modbusError('IO_ERROR', 'Unsupported Modbus endpoint');
    if (this.stopped) throw modbusError('IO_ERROR', 'Modbus service is shut down');
    if (this.sessions.has(endpoint.id) || this.opening.has(endpoint.id) || this.closing.has(endpoint.id)) {
      throw modbusError('PORT_BUSY', `Endpoint ${endpoint.id} is already active`);
    }
    const session = {
      endpointId: endpoint.id,
      operationId,
      sessionId: `modbus-${this.nextSessionId++}`,
      transport: endpoint.transport,
      config: normalizeConfig(endpoint),
      resource: null,
      dataStore: null,
      queue: Promise.resolve(),
      runtimeError: null,
      cancelled: false,
    };
    const cancellation = new Promise((resolve, reject) => { session.rejectOpen = reject; });
    this.opening.set(endpoint.id, session);
    this.emitStatus(session, 'opening', null, null);
    try {
      if (session.cancelled || this.stopped) throw modbusError('OPEN_CANCELLED', 'Modbus open cancelled');
      const connecting = endpoint.transport.endsWith('-master')
        ? this.openMaster(session) : this.openSlave(session);
      // Opening may finish after cancellation. It must never publish or own a
      // replacement session, and any late resource still needs cleanup.
      session.connecting = connecting;
      await Promise.race([connecting, cancellation]);
      if (this.stopped || session.cancelled) throw modbusError('OPEN_CANCELLED', 'Modbus open cancelled');
      this.sessions.set(endpoint.id, session);
      if (session.runtimeError) {
        this.sessions.delete(endpoint.id);
        throw session.runtimeError;
      }
      const status = endpoint.transport.endsWith('-slave') ? 'listening' : 'open';
      this.emitStatus(session, status, null, endpoint.transport.replace('modbus-', '').replace('-', ' '));
      return {
        endpointId: endpoint.id,
        operationId,
        sessionId: session.sessionId,
      };
    } catch (reason) {
      const error = mapError(reason);
      try {
        await (session.cancelled ? releaseOpeningResource(session) : closeResource(session.resource));
      } catch (cleanupError) {
        session.cleanupFailed = true;
        this.emitStatus(session, 'error', mapError(cleanupError), null);
        throw cleanupError;
      }
      if (!session.cancelled) this.emitStatus(session, 'error', error, null);
      this.emitStatus(session, 'closed', error, null);
      throw error;
    } finally {
      if (!session.cleanupFailed && this.opening.get(endpoint.id) === session) this.opening.delete(endpoint.id);
    }
  }

  async openMaster(session) {
    const client = new this.ModbusRTU();
    session.resource = client;
    client.setID(session.config.unitId);
    client.setTimeout(session.config.timeoutMs);
    if (session.transport === 'modbus-tcp-master') {
      await client.connectTCP(session.config.host, { port: session.config.port });
    } else {
      await client.connectRTUBuffered(session.config.path, serialOptions(session.config));
    }
  }

  async openSlave(session) {
    session.dataStore = createDataStore(session.config.dataAreas);
    const vector = protectCoilBatchVector(createServerVector(session));
    if (session.transport === 'modbus-tcp-slave') {
      session.resource = new this.ModbusRTU.ServerTCP(vector, {
        host: session.config.listenHost,
        port: session.config.listenPort,
        unitID: session.config.unitId,
      });
      captureTcpSlaveFrames(session, session.resource, this.emitModbusEvent);
      session.resource.on('socketError', (reason) => this.emitRuntimeError(session, reason));
      session.resource.on('serverError', (reason) => this.handleTerminalRuntimeError(session, reason));
      await waitForTcpListening(session.resource);
      return;
    }
    if (typeof this.ModbusRTU.ServerSerial !== 'function') {
      throw modbusError('IO_ERROR', 'Modbus RTU slave support is unavailable');
    }
    session.resource = await createSerialServer(this.ModbusRTU, vector, session.config,
      (resource) => { session.resource = resource; });
    if (session.cancelled) return;
    captureRtuSlaveFrames(session, session.resource, this.emitModbusEvent);
    session.resource.on('socketError', (reason) => this.handleTerminalRuntimeError(session, reason));
    session.resource.on('error', (reason) => this.emitRuntimeError(session, reason));
  }

  execute(request) {
    requireId(request?.endpointId, 'endpointId');
    const session = this.session(request.endpointId);
    if (!session.transport.endsWith('-master')) throw modbusError('IO_ERROR', 'Only a Modbus master can execute requests');
    const operation = normalizeOperation(request);
    if (operation.expectedSessionId && operation.expectedSessionId !== session.sessionId) {
      throw modbusError('OPEN_CANCELLED', 'Modbus request belongs to an inactive session');
    }
    const execute = () => this.executeNow(session, operation);
    const pending = session.queue.then(execute, execute);
    session.queue = pending.catch(() => {});
    return pending;
  }

  async executeNow(session, operation) {
    if (this.sessions.get(session.endpointId) !== session) {
      throw modbusError('IO_ERROR', `Endpoint ${session.endpointId} is not open`);
    }
    const startedAt = Date.now();
    const client = session.resource;
    client.setID(operation.unitId);
    if (operation.timeoutMs !== undefined) client.setTimeout(operation.timeoutMs);
    try {
      let response;
      switch (operation.functionCode) {
        case 1: response = await client.readCoils(operation.address, operation.quantity); break;
        case 2: response = await client.readDiscreteInputs(operation.address, operation.quantity); break;
        case 3: response = await client.readHoldingRegisters(operation.address, operation.quantity); break;
        case 4: response = await client.readInputRegisters(operation.address, operation.quantity); break;
        case 5: response = await client.writeCoil(operation.address, operation.values[0]); break;
        case 6: response = await client.writeRegister(operation.address, operation.values[0]); break;
        case 15: response = await client.writeCoils(operation.address, operation.values); break;
        case 16: response = await client.writeRegisters(operation.address, operation.values); break;
        default: throw modbusError('IO_ERROR', 'Unsupported Modbus function code');
      }
      const values = operation.functionCode <= 4
        ? Array.from(response?.data ?? [])
        : [...operation.values];
      const transaction = transactionRecord(session, operation, values, startedAt, null, 'master');
      this.emitModbusEvent(transaction);
      return transaction;
    } catch (reason) {
      const message = errorMessage(reason);
      const exceptionCode = Number.isInteger(reason?.modbusCode) ? reason.modbusCode : null;
      const transaction = transactionRecord(session, operation, [], startedAt, {
        exceptionCode, message,
      }, 'master');
      this.emitModbusEvent(transaction);
      const error = exceptionCode === null
        ? mapError(reason)
        : modbusError('MODBUS_EXCEPTION', message);
      error.transaction = transaction;
      if (exceptionCode === null) await this.retireFailedSession(session, error);
      throw error;
    } finally {
      if (operation.timeoutMs !== undefined) client.setTimeout(session.config.timeoutMs);
    }
  }

  readMap(endpointId) {
    const session = this.session(endpointId);
    if (!session.dataStore) throw modbusError('IO_ERROR', 'Only a Modbus slave has a data map');
    return snapshotMap(session);
  }

  writeMap(request) {
    requireId(request?.endpointId, 'endpointId');
    const session = this.session(request.endpointId);
    const expectedSessionId = optionalId(request, 'expectedSessionId');
    if (expectedSessionId && expectedSessionId !== session.sessionId) {
      throw modbusError('OPEN_CANCELLED', 'Modbus slave session has changed');
    }
    if (!session.dataStore) throw modbusError('IO_ERROR', 'Only a Modbus slave has a data map');
    if (!AREA_NAMES.has(request.area)) throw modbusError('IO_ERROR', 'Unknown Modbus data area');
    const values = normalizeAreaValues(request.area, request.values);
    const area = session.dataStore[request.area];
    const offset = Number(request.address) - area.start;
    if (!Number.isInteger(offset) || offset < 0 || offset + values.length > area.values.length) {
      throw modbusException(2, 'Address is outside the configured data area');
    }
    area.values.splice(offset, values.length, ...values);
    const transaction = transactionRecord(session, {
      functionCode: 0, unitId: session.config.unitId,
      address: Number(request.address), quantity: values.length, values,
    }, values, Date.now(), null, 'local');
    this.emitModbusEvent(transaction);
    return snapshotMap(session);
  }

  async cancelOpen(endpointId, { operationId } = {}) {
    requireId(operationId, 'operationId');
    const session = this.opening.get(endpointId) ?? this.sessions.get(endpointId) ?? this.closing.get(endpointId);
    if (!session || session.operationId !== operationId) return { endpointId, operationId, cancelled: false };
    if (this.opening.get(endpointId) === session) {
      session.cancelled = true;
      const retry = session.cleanupFailed === true;
      if (retry) { session.openCleanup = null; session.cleanupFailed = false; }
      const cleanup = releaseOpeningResource(session);
      session.rejectOpen(modbusError('OPEN_CANCELLED', 'Modbus open cancelled'));
      try { await cleanup; } catch (error) { session.cleanupFailed = true; throw error; }
      if (this.opening.get(endpointId) === session) this.opening.delete(endpointId);
      if (retry) this.emitStatus(session, 'closed', null, null);
    } else await this.close(endpointId);
    return { endpointId, operationId, cancelled: true };
  }

  async close(endpointId) {
    requireId(endpointId, 'endpointId');
    const opening = this.opening.get(endpointId);
    if (opening) await this.cancelOpen(endpointId, { operationId: opening.operationId });
    const session = this.closing.get(endpointId) ?? this.sessions.get(endpointId);
    if (!session) return { endpointId, closed: true };
    return this.closeSession(session);
  }

  closeSession(session, { drain = true, error = null } = {}) {
    if (session.closePromise) {
      if (!drain) session.releaseCloseDrain?.();
      return session.closePromise;
    }
    const endpointId = session.endpointId;
    if (this.sessions.get(endpointId) === session) this.sessions.delete(endpointId);
    // Keep ownership through native completion, including failures that need retry.
    this.closing.set(endpointId, session);
    session.closeError ??= error;
    this.emitStatus(session, 'closing', null, null);
    const forceDrain = new Promise(resolve => { session.releaseCloseDrain = resolve; });
    const attempt = Promise.resolve().then(async () => {
      if (drain) await Promise.race([session.queue.catch(() => {}), forceDrain]);
      await closeResource(session.resource);
      if (this.closing.get(endpointId) === session) this.closing.delete(endpointId);
      if (session.closeError) this.emitStatus(session, 'error', session.closeError, null);
      this.emitStatus(session, 'closed', session.closeError, null);
      return { endpointId, closed: true };
    }).catch(reason => {
      this.emitStatus(session, 'error', mapError(reason), null);
      throw reason;
    }).finally(() => {
      if (session.closePromise === attempt) {
        session.closePromise = null;
        session.releaseCloseDrain = null;
      }
    });
    session.closePromise = attempt;
    return attempt;
  }

  async closeAll() {
    const results = await Promise.allSettled([...new Set([...this.sessions.keys(), ...this.opening.keys(), ...this.closing.keys()])].map((id) => this.close(id)));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
  }

  async shutdown() {
    this.stopped = true;
    await this.closeAll();
  }

  async forceShutdown() {
    this.stopped = true;
    await Promise.allSettled([...this.opening.values()].map((session) =>
      this.cancelOpen(session.endpointId, { operationId: session.operationId })));
    const sessions = new Set([...this.sessions.values(), ...this.closing.values()]);
    await Promise.allSettled([...sessions].map(session => this.closeSession(session, { drain: false })));
    return [];
  }

  session(endpointId) {
    const session = this.sessions.get(endpointId);
    if (!session) throw modbusError('IO_ERROR', `Endpoint ${endpointId} is not open`);
    return session;
  }

  emitStatus(session, status, error, detail) {
    const createdAt = Date.now();
    const retainsSession = ['open', 'listening', 'closing', 'error'].includes(status);
    const wireError = error ? { code: error.code ?? 'IO_ERROR', message: error.message } : null;
    const level = status === 'error' ? 'error' : ['opening', 'closing'].includes(status) ? 'debug' : 'info';
    const log = status === 'closed' && error ? null : {
      level,
      source: 'modbus',
      code: wireError?.code ?? null,
      message: detail ? `Modbus ${status}: ${detail}` : `Modbus ${status}`,
      details: { transport: session.transport },
      createdAt,
    };
    this.emitTransportEvent('transport:status', {
      endpointId: session.endpointId,
      operationId: session.operationId,
      sessionId: retainsSession && status !== 'opening' ? session.sessionId : null,
      status,
      error: wireError,
      createdAt,
      log,
    });
  }

  emitRuntimeError(session, reason) {
    if (this.sessions.get(session.endpointId) !== session) return;
    const error = mapError(reason);
    this.emitStatus(session, 'error', error, null);
  }

  handleTerminalRuntimeError(session, reason) {
    const error = mapError(reason);
    session.runtimeError = error;
    if (this.sessions.get(session.endpointId) === session) {
      void this.retireFailedSession(session, error);
    }
  }

  async retireFailedSession(session, error) {
    if (this.sessions.get(session.endpointId) !== session) return;
    // An explicit close already waits for this request to settle. Joining it here
    // would make the request wait on its own queue and deadlock native cleanup.
    await this.closeSession(session, { drain: false, error }).catch(() => {});
  }
}

function createServerVector(session) {
  const get = (areaName, address) => {
    const area = session.dataStore[areaName];
    const offset = address - area.start;
    if (offset < 0 || offset >= area.values.length) throw modbusException(2, 'Illegal data address');
    return area.values[offset];
  };
  const set = (areaName, address, values) => {
    const area = session.dataStore[areaName];
    const normalized = normalizeAreaValues(areaName, values);
    const offset = address - area.start;
    if (offset < 0 || offset + normalized.length > area.values.length) {
      throw modbusException(2, 'Illegal data address');
    }
    area.values.splice(offset, normalized.length, ...normalized);
  };
  return {
    getCoil: (address) => get('coils', address),
    getDiscreteInput: (address) => get('discreteInputs', address),
    getHoldingRegister: (address) => get('holdingRegisters', address),
    getInputRegister: (address) => get('inputRegisters', address),
    setCoil: (address, value) => set('coils', address, [value]),
    setRegister: (address, value) => set('holdingRegisters', address, [value]),
    setCoilArray: (address, values) => set('coils', address, values),
    setRegisterArray: (address, values) => set('holdingRegisters', address, values),
  };
}

function captureTcpSlaveFrames(session, server, emit) {
  server?._server?.on('connection', (socket) => {
    let receiveBuffer = Buffer.alloc(0);
    const pending = new Map();
    const originalWrite = socket.write.bind(socket);
    socket.write = (chunk, ...args) => {
      if (Buffer.isBuffer(chunk)) {
        for (const responseFrame of splitTcpFrames(chunk)) {
          const transactionId = responseFrame.readUInt16BE(0);
          const queue = pending.get(transactionId);
          const request = queue?.shift();
          if (queue?.length === 0) pending.delete(transactionId);
          if (request) emitCapturedTransaction(
            session, request.frame, responseFrame, request.startedAt, emit,
          );
        }
      }
      return originalWrite(chunk, ...args);
    };
    socket.on('data', (chunk) => {
      receiveBuffer = Buffer.concat([receiveBuffer, chunk]);
      const parsed = takeTcpFrames(receiveBuffer);
      receiveBuffer = parsed.remaining;
      for (const frame of parsed.frames) {
        const transactionId = frame.readUInt16BE(0);
        const queue = pending.get(transactionId) ?? [];
        queue.push({ frame, startedAt: Date.now() });
        pending.set(transactionId, queue);
      }
    });
  });
}

function captureRtuSlaveFrames(session, server, emit) {
  if (!server?._server?.on || !server?._serverPath?.write) return;
  const pending = [];
  server._server.on('data', (frame) => {
    if (Buffer.isBuffer(frame)) pending.push({ frame: Buffer.from(frame), startedAt: Date.now() });
  });
  const originalWrite = server._serverPath.write.bind(server._serverPath);
  server._serverPath.write = (frame, ...args) => {
    if (Buffer.isBuffer(frame)) {
      const request = pending.shift();
      if (request) emitCapturedTransaction(session, request.frame, frame, request.startedAt, emit);
    }
    return originalWrite(frame, ...args);
  };
}

function takeTcpFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 6) {
    const bodyLength = buffer.readUInt16BE(offset + 4);
    const frameLength = 6 + bodyLength;
    if (bodyLength < 2 || bodyLength > 254) return { frames, remaining: Buffer.alloc(0) };
    if (buffer.length - offset < frameLength) break;
    frames.push(Buffer.from(buffer.subarray(offset, offset + frameLength)));
    offset += frameLength;
  }
  return { frames, remaining: Buffer.from(buffer.subarray(offset)) };
}

function emitCapturedTransaction(session, requestFrame, responseFrame, startedAt, emit) {
  try {
    emit(capturedSlaveTransaction(session, requestFrame, responseFrame, startedAt));
  } catch {
    // Frame diagnostics must never interrupt the underlying Modbus transport.
  }
}

function splitTcpFrames(buffer) {
  return takeTcpFrames(buffer).frames;
}

function capturedSlaveTransaction(session, requestFrame, responseFrame, startedAt) {
  const tcp = session.transport === 'modbus-tcp-slave';
  const requestPdu = requestFrame.subarray(tcp ? 7 : 1, tcp ? requestFrame.length : -2);
  const responsePdu = responseFrame.subarray(tcp ? 7 : 1, tcp ? responseFrame.length : -2);
  const operation = parseRequestPdu(requestPdu);
  const response = parseResponsePdu(responsePdu, operation);
  return {
    ...transactionRecord(
      session,
      { ...operation, unitId: tcp ? requestFrame[6] : requestFrame[0] },
      response.values,
      startedAt,
      response.exceptionCode === null ? null : {
        exceptionCode: response.exceptionCode,
        message: `Modbus exception 0x${response.exceptionCode.toString(16).padStart(2, '0').toUpperCase()}`,
      },
      'slave',
    ),
    transport: session.transport,
    requestFrame: [...requestFrame],
    responseFrame: [...responseFrame],
  };
}

function parseRequestPdu(pdu) {
  const functionCode = pdu[0];
  const address = pdu.readUInt16BE(1);
  if (functionCode <= 4) {
    return { functionCode, address, quantity: pdu.readUInt16BE(3), values: [] };
  }
  if (functionCode === 5) {
    return { functionCode, address, quantity: 1, values: [pdu.readUInt16BE(3) === 0xff00] };
  }
  if (functionCode === 6) {
    return { functionCode, address, quantity: 1, values: [pdu.readUInt16BE(3)] };
  }
  const quantity = pdu.readUInt16BE(3);
  if (functionCode === 15) {
    const values = Array.from({ length: quantity }, (_, index) => (
      (pdu[6 + Math.floor(index / 8)] & (1 << (index % 8))) !== 0
    ));
    return { functionCode, address, quantity, values };
  }
  const values = Array.from({ length: quantity }, (_, index) => pdu.readUInt16BE(6 + index * 2));
  return { functionCode, address, quantity, values };
}

function parseResponsePdu(pdu, operation) {
  if ((pdu[0] & 0x80) !== 0) return { values: [], exceptionCode: pdu[1] };
  if (operation.functionCode === 1 || operation.functionCode === 2) {
    return {
      values: Array.from({ length: operation.quantity }, (_, index) => (
        (pdu[2 + Math.floor(index / 8)] & (1 << (index % 8))) !== 0
      )),
      exceptionCode: null,
    };
  }
  if (operation.functionCode === 3 || operation.functionCode === 4) {
    return {
      values: Array.from({ length: operation.quantity }, (_, index) => pdu.readUInt16BE(2 + index * 2)),
      exceptionCode: null,
    };
  }
  return { values: [...operation.values], exceptionCode: null };
}

function createDataStore(dataAreas) {
  if (dataAreas !== undefined && !isPlainObject(dataAreas)) {
    throw modbusError('IO_ERROR', 'Modbus dataAreas must be an object');
  }
  const result = {};
  for (const areaName of AREA_NAMES) {
    const candidate = dataAreas?.[areaName];
    if (candidate !== undefined && !isPlainObject(candidate)) {
      throw modbusError('IO_ERROR', `${areaName} must be an object`);
    }
    const source = candidate ?? {};
    const count = configInteger(source, 'count', 1, 10_000, 100);
    const start = configInteger(source, 'start', 0, 65_535, 0);
    if (start + count > 65_536) {
      throw modbusError('IO_ERROR', 'Modbus data area range exceeds address 65535');
    }
    const initialValues = Array.isArray(source.values) ? source.values.slice(0, count) : [];
    result[areaName] = {
      start,
      values: initialValues.length > 0 ? normalizeAreaValues(areaName, initialValues) : [],
    };
    const fallback = areaName === 'coils' || areaName === 'discreteInputs' ? false : 0;
    while (result[areaName].values.length < count) result[areaName].values.push(fallback);
  }
  return result;
}

function snapshotMap(session) {
  return {
    endpointId: session.endpointId,
    unitId: session.config.unitId,
    areas: Object.fromEntries([...AREA_NAMES].map((key) => [key, {
      start: session.dataStore[key].start,
      count: session.dataStore[key].values.length,
      values: [...session.dataStore[key].values],
    }])),
  };
}

function normalizeConfig(endpoint) {
  if (endpoint.config !== undefined && !isPlainObject(endpoint.config)) {
    throw modbusError('IO_ERROR', 'Modbus config must be an object');
  }
  const config = endpoint.config ?? {};
  const value = {
    unitId: configInteger(config, 'unitId', 1, 247, 1),
    timeoutMs: configInteger(config, 'timeoutMs', 50, 60_000, 1000),
    host: configText(config, 'host', '127.0.0.1'),
    port: configInteger(config, 'port', 1, 65_535, 502),
    listenHost: configText(config, 'listenHost', '0.0.0.0'),
    listenPort: configInteger(config, 'listenPort', 1, 65_535, 502),
    path: configText(config, 'path', ''),
    baudRate: configInteger(config, 'baudRate', 1, 0xffff_ffff, 9600),
    dataBits: configChoice(config, 'dataBits', [5, 6, 7, 8], 8),
    parity: configChoice(config, 'parity', ['none', 'even', 'odd'], 'none'),
    stopBits: configChoice(config, 'stopBits', [1, 2], 1),
    flowControl: configChoice(config, 'flowControl', ['none', 'hardware', 'software'], 'none'),
    dataAreas: config.dataAreas,
  };
  if (endpoint.transport.startsWith('modbus-rtu-') && !value.path) {
    throw modbusError('PORT_NOT_FOUND', 'A serial port is required');
  }
  return value;
}

function normalizeOperation(request) {
  const functionCode = request.functionCode;
  if (![1, 2, 3, 4, 5, 6, 15, 16].includes(functionCode)) {
    throw modbusError('IO_ERROR', 'functionCode must be FC01, FC02, FC03, FC04, FC05, FC06, FC15, or FC16');
  }
  const address = integerInRange(request.address, 0, 65_535, -1);
  if (address < 0) throw modbusError('IO_ERROR', 'address must be between 0 and 65535');
  const unitId = integerInRange(request.unitId, 1, 247, -1);
  if (unitId < 0) throw modbusError('IO_ERROR', 'unitId must be between 1 and 247');
  const read = functionCode <= 4;
  const single = functionCode === 5 || functionCode === 6;
  const values = read ? [] : normalizeAreaValues(
    functionCode === 5 || functionCode === 15 ? 'coils' : 'holdingRegisters',
    Array.isArray(request.values) ? request.values : [request.value],
  );
  const quantity = read
    ? integerInRange(request.quantity, 1, functionCode <= 2 ? 2000 : 125, -1)
    : values.length;
  if (quantity < 1 || (single && quantity !== 1)
    || (functionCode === 15 && quantity > 1968) || (functionCode === 16 && quantity > 123)) {
    throw modbusError('IO_ERROR', 'Invalid quantity for the selected function code');
  }
  if (address + quantity > 65_536) throw modbusError('IO_ERROR', 'Requested address range exceeds 65535');
  const timeoutMs = optionalIntegerInRange(request, 'timeoutMs', 50, 60_000);
  const requestGroupId = optionalId(request, 'requestGroupId');
  const requestId = optionalId(request, 'requestId');
  const expectedSessionId = optionalId(request, 'expectedSessionId');
  return {
    functionCode, unitId, address, quantity, values,
    ...(timeoutMs === null ? {} : { timeoutMs }),
    ...(requestGroupId === null ? {} : { requestGroupId }),
    ...(requestId === null ? {} : { requestId }),
    ...(expectedSessionId === null ? {} : { expectedSessionId }),
  };
}

function transactionRecord(session, operation, values, startedAt, failure, origin) {
  const createdAt = Date.now();
  return {
    endpointId: session.endpointId,
    sessionId: session.sessionId,
    requestGroupId: operation.requestGroupId ?? null,
    requestId: operation.requestId ?? null,
    origin,
    unitId: operation.unitId,
    functionCode: operation.functionCode,
    address: operation.address,
    quantity: operation.quantity,
    requestValues: [...operation.values],
    values: [...values],
    success: failure === null,
    exceptionCode: failure?.exceptionCode ?? null,
    message: failure?.message ?? null,
    createdAt,
    durationMs: Math.max(0, createdAt - startedAt),
  };
}

function optionalIntegerInRange(source, key, minimum, maximum) {
  if (!Object.hasOwn(source, key) || source[key] === null || source[key] === undefined) return null;
  const value = integerInRange(source[key], minimum, maximum, -1);
  if (value < minimum) throw modbusError('IO_ERROR', `${key} must be between ${minimum} and ${maximum}`);
  return value;
}

function optionalId(source, key) {
  if (!Object.hasOwn(source, key) || source[key] === null || source[key] === undefined) return null;
  requireId(source[key], key);
  return source[key].trim();
}

function serialOptions(config) {
  return {
    baudRate: config.baudRate,
    dataBits: config.dataBits,
    parity: config.parity,
    stopBits: config.stopBits,
    rtscts: config.flowControl === 'hardware',
    xon: config.flowControl === 'software',
    xoff: config.flowControl === 'software',
    ...(process.platform === 'darwin' ? {
      vmin: 0, vtime: 1,
      binding: require('./darwinModbusBinding.cjs').getDarwinModbusBinding(),
    } : {}),
  };
}

function waitForTcpListening(server) {
  if (server?._server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const listening = () => { cleanup(); resolve(); };
    const failed = (error) => { cleanup(); reject(error); };
    const cleanup = () => {
      server?._server?.off('listening', listening);
      server?.off('socketError', failed);
      server?.off('serverError', failed);
    };
    server?._server?.once('listening', listening);
    server?.once('socketError', failed);
    server?.once('serverError', failed);
  });
}

function createSerialServer(ModbusRTU, vector, config, captureResource = () => {}) {
  return new Promise((resolve, reject) => {
    let server;
    const options = {
      path: config.path,
      baudRate: config.baudRate,
      parity: config.parity,
      unitID: config.unitId,
      openCallback(error) {
        if (error) reject(error);
      },
    };
    server = new ModbusRTU.ServerSerial(vector, options, serialOptions(config));
    captureResource(server);
    server.once('initialized', () => resolve(server));
    server.once('error', reject);
  });
}

function closeResource(resource) {
  if (!resource) return Promise.resolve();
  const serialPort = typeof resource.getPort === 'function' ? resource.getPort() : resource._port?._client;
  // ServerSerial and buffered RTU clients reject close on a failed native open.
  // Once opening has settled there is no descriptor to close in that case.
  if (serialPort?.isOpen === false && !serialPort.opening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve();
    };
    try {
      if (typeof resource.close === 'function') {
        const result = resource.close(finish);
        if (result?.then) result.then(() => finish(), finish);
        else if (resource.close.length === 0) finish();
      } else finish();
    } catch (error) { finish(error); }
  });
}

function releaseOpeningResource(session) {
  if (session.openCleanup) return session.openCleanup;
  // RTU native opening cannot be destroyed through modbus-serial. Retain its
  // reservation until it settles, then close the actual port before acknowledging.
  if (session.transport.includes('-rtu-')) {
    session.openCleanup = Promise.resolve(session.connecting).catch(() => {})
      .then(() => closeResource(session.resource));
  } else {
    session.openCleanup = typeof session.resource?.destroy === 'function'
      ? new Promise((resolve, reject) => session.resource.destroy((error) => error ? reject(error) : resolve()))
      : closeResource(session.resource);
  }
  return session.openCleanup;
}

function normalizeAreaValues(areaName, values) {
  if (!Array.isArray(values) || values.length === 0) throw modbusError('IO_ERROR', 'values must be a nonempty array');
  const bits = areaName === 'coils' || areaName === 'discreteInputs';
  return values.map((value) => {
    if (bits) {
      if (typeof value === 'boolean') return value;
      if (value === 0 || value === 1) return value === 1;
      throw modbusError('IO_ERROR', 'Coil values must be boolean, 0, or 1');
    }
    if (!Number.isInteger(value) || value < 0 || value > 65_535) {
      throw modbusError('IO_ERROR', 'Register values must be integers from 0 to 65535');
    }
    return value;
  });
}

function integerInRange(value, minimum, maximum, fallback) {
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function configInteger(source, key, minimum, maximum, fallback) {
  if (!Object.hasOwn(source, key)) return fallback;
  const value = source[key];
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw modbusError('IO_ERROR', `${key} is outside the allowed range`);
  }
  return value;
}

function configText(source, key, fallback) {
  if (!Object.hasOwn(source, key)) return fallback;
  const value = source[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw modbusError('IO_ERROR', `${key} must be a nonblank string`);
  }
  return value.trim();
}

function configChoice(source, key, choices, fallback) {
  if (!Object.hasOwn(source, key)) return fallback;
  if (!choices.includes(source[key])) throw modbusError('IO_ERROR', `${key} is unsupported`);
  return source[key];
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function modbusException(code, message) {
  const error = new Error(message);
  error.modbusErrorCode = code;
  error.modbusCode = code;
  return error;
}

function modbusError(code, message) {
  const error = new Error(message);
  error.name = 'ModbusError';
  error.code = code;
  return error;
}

function mapError(reason) {
  if (reason?.name === 'ModbusError') return reason;
  const message = errorMessage(reason);
  const lower = message.toLowerCase();
  if (lower.includes('not found') || lower.includes('no such file')) return modbusError('PORT_NOT_FOUND', message);
  if (lower.includes('busy') || lower.includes('in use') || lower.includes('eaddrinuse')) return modbusError('PORT_BUSY', message);
  if (lower.includes('permission') || lower.includes('access denied')) return modbusError('PERMISSION_DENIED', message);
  return modbusError('IO_ERROR', message);
}

function errorMessage(reason) {
  return typeof reason?.message === 'string' ? reason.message : String(reason);
}

function requireId(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be a nonblank string`);
}

module.exports = {
  ModbusService,
  captureRtuSlaveFrames,
  normalizeOperation,
  createDataStore,
  createSerialServer,
  serialOptions,
};
