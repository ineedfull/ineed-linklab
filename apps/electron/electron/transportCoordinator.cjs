class TransportCoordinator {
  constructor({ serialService, tcpService = null, udpService = null, websocketService = null, modbusService = null, database, persistence = null } = {}) {
    if (!serialService || typeof serialService !== 'object') {
      throw new TypeError('serialService is required');
    }
    if (tcpService !== null && typeof tcpService !== 'object') {
      throw new TypeError('tcpService must be an object');
    }
    if (udpService !== null && typeof udpService !== 'object') {
      throw new TypeError('udpService must be an object');
    }
    if (modbusService !== null && typeof modbusService !== 'object') {
      throw new TypeError('modbusService must be an object');
    }
    if (!database || typeof database.listEndpoints !== 'function') {
      throw new TypeError('database.listEndpoints is required');
    }
    this.serialService = serialService;
    this.tcpService = tcpService;
    this.udpService = udpService;
    this.websocketService = websocketService;
    this.modbusService = modbusService;
    this.database = database;
    if (persistence !== null && typeof persistence?.flush !== 'function') {
      throw new TypeError('persistence.flush must be a function');
    }
    this.persistence = persistence;
    this.shutdownPromise = null;
    this.forceShutdownPromise = null;
    this.persistenceDisposePromise = null;
    this.forceShutdownStarted = false;
  }

  scanSerialPorts() {
    return this.serialService.scan();
  }

  serviceFor(endpoint) {
    if (endpoint.transport === 'serial' || endpoint.transport === 'dlt645-master'
      || endpoint.transport === 'dlt645-slave') {
      return this.serialService;
    }
    if (endpoint.transport === 'tcp-client' || endpoint.transport === 'tcp-server') {
      if (!this.tcpService) throw serialError('IO_ERROR', 'TCP transport is unavailable');
      return this.tcpService;
    }
    if (endpoint.transport === 'udp-client' || endpoint.transport === 'udp-server') {
      if (!this.udpService) throw serialError('IO_ERROR', 'UDP transport is unavailable');
      return this.udpService;
    }
    if (endpoint.transport === 'websocket-client' || endpoint.transport === 'websocket-server') {
      if (!this.websocketService) throw serialError('IO_ERROR', 'WebSocket transport is unavailable');
      return this.websocketService;
    }
    if (endpoint.transport.startsWith('modbus-')) {
      if (!this.modbusService) throw serialError('IO_ERROR', 'Modbus transport is unavailable');
      return this.modbusService;
    }
    throw serialError('IO_ERROR', `${endpoint.transport} transport is unavailable`);
  }

  endpointFor(endpointId) {
    return this.database.listEndpoints().find(({ id }) => id === endpointId) ?? null;
  }

  async open(endpointId, options) {
    const endpoint = this.endpointFor(endpointId);
    if (!endpoint) throw serialError('PORT_NOT_FOUND', `Endpoint ${endpointId} was not found`);
    const service = this.serviceFor(endpoint);
    const runtimeEndpoint = service === this.serialService
      ? serialRuntimeEndpoint(endpoint)
      : endpoint;
    return service.open(runtimeEndpoint, options);
  }

  cancelOpen(endpointId, options) {
    const endpoint = this.endpointFor(endpointId);
    if (!endpoint) return { endpointId, operationId: options?.operationId, cancelled: false };
    return this.serviceFor(endpoint).cancelOpen(endpointId, options);
  }

  close(endpointId) {
    const endpoint = this.endpointFor(endpointId);
    if (!endpoint) return this.closeUnknownEndpoint(endpointId);
    return this.serviceFor(endpoint).close(endpointId);
  }

  async closeEndpoint(endpointId) {
    const result = await this.close(endpointId);
    await this.flushPersistence();
    return result;
  }

  send(request) {
    const endpointId = request?.endpointId;
    const endpoint = this.endpointFor(endpointId);
    if (!endpoint) throw serialError('PORT_NOT_FOUND', `Endpoint ${endpointId} was not found`);
    return this.serviceFor(endpoint).send(request);
  }

  disconnectPeer(request) {
    const endpointId = request?.endpointId;
    const peerId = request?.peerId ?? request?.target?.peerId;
    const endpoint = this.endpointFor(endpointId);
    if (!endpoint) throw serialError('PORT_NOT_FOUND', `Endpoint ${endpointId} was not found`);
    const service = this.serviceFor(endpoint);
    if (typeof service.disconnectPeer !== 'function') {
      throw serialError('IO_ERROR', `${endpoint.transport} peer disconnect is unavailable`);
    }
    return service.disconnectPeer(endpointId, peerId);
  }

  executeModbus(request) {
    if (!this.modbusService) throw serialError('IO_ERROR', 'Modbus transport is unavailable');
    return this.modbusService.execute(request);
  }

  readModbusMap(endpointId) {
    if (!this.modbusService) throw serialError('IO_ERROR', 'Modbus transport is unavailable');
    return this.modbusService.readMap(endpointId);
  }

  writeModbusMap(request) {
    if (!this.modbusService) throw serialError('IO_ERROR', 'Modbus transport is unavailable');
    return this.modbusService.writeMap(request);
  }

  async closeAll() {
    let firstError = null;
    firstError = await continueAfterError(() => this.serialService.closeAll(), firstError);
    if (this.tcpService) {
      firstError = await continueAfterError(() => this.tcpService.closeAll(), firstError);
    }
    if (this.udpService) {
      firstError = await continueAfterError(() => this.udpService.closeAll(), firstError);
    }
    if (this.websocketService) firstError = await continueAfterError(() => this.websocketService.closeAll(), firstError);
    if (this.modbusService) {
      firstError = await continueAfterError(() => this.modbusService.closeAll(), firstError);
    }
    if (firstError) throw firstError;
  }

  flushPersistence() {
    return this.persistence?.flush() ?? Promise.resolve();
  }

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    const attempt = (async () => {
      let firstError = null;
      firstError = await continueAfterError(() => this.serialService.shutdown(), firstError);
      if (this.tcpService) {
        firstError = await continueAfterError(() => this.tcpService.shutdown(), firstError);
      }
      if (this.udpService) {
        firstError = await continueAfterError(() => this.udpService.shutdown(), firstError);
      }
      if (this.websocketService) firstError = await continueAfterError(() => this.websocketService.shutdown(), firstError);
      if (this.modbusService) {
        firstError = await continueAfterError(() => this.modbusService.shutdown(), firstError);
      }
      if (this.forceShutdownStarted) return;
      firstError = await continueAfterError(() => this.flushPersistence(), firstError);
      if (this.forceShutdownStarted) return;
      firstError = await continueAfterError(() => this.disposePersistence(), firstError);
      if (firstError) throw firstError;
    })();
    this.shutdownPromise = attempt;
    attempt.catch(() => {
      if (this.shutdownPromise === attempt) this.shutdownPromise = null;
    });
    return attempt;
  }

  async forceShutdown() {
    if (this.forceShutdownPromise) return this.forceShutdownPromise;
    this.forceShutdownStarted = true;
    this.forceShutdownPromise = (async () => {
      let result;
      try {
        result = await this.serialService.forceShutdown();
      } catch {
        // Forced cleanup continues through persistence flush and disposal.
      }
      if (this.tcpService) {
        try {
          await this.tcpService.forceShutdown();
        } catch {
          // Forced cleanup continues through persistence flush and disposal.
        }
      }
      if (this.udpService) {
        try {
          await this.udpService.forceShutdown();
        } catch {
          // Forced cleanup continues through persistence flush and disposal.
        }
      }
      if (this.modbusService) {
        try {
          await this.modbusService.forceShutdown();
        } catch {
          // Forced cleanup continues through persistence flush and disposal.
        }
      }
      if (this.websocketService) {
        try { await this.websocketService.forceShutdown(); } catch { /* Continue persistence cleanup. */ }
      }
      await this.flushPersistence().catch(() => {});
      await this.disposePersistence().catch(() => {});
      return result;
    })();
    return this.forceShutdownPromise;
  }

  disposePersistence() {
    if (!this.persistence?.dispose) return Promise.resolve();
    if (!this.persistenceDisposePromise) {
      this.persistenceDisposePromise = Promise.resolve().then(() => this.persistence.dispose());
    }
    return this.persistenceDisposePromise;
  }

  async closeUnknownEndpoint(endpointId) {
    let serialResult = null;
    let tcpResult = null;
    let firstError = null;
    try {
      serialResult = await this.serialService.close(endpointId);
    } catch (error) {
      firstError = error;
    }
    if (this.tcpService) {
      try {
        tcpResult = await this.tcpService.close(endpointId);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (this.udpService) {
      try {
        const udpResult = await this.udpService.close(endpointId);
        tcpResult ??= udpResult;
      } catch (error) {
        firstError ??= error;
      }
    }
    if (this.modbusService) {
      try {
        const modbusResult = await this.modbusService.close(endpointId);
        tcpResult ??= modbusResult;
      } catch (error) {
        firstError ??= error;
      }
    }
    if (this.websocketService) {
      try { const result = await this.websocketService.close(endpointId); tcpResult ??= result; } catch (error) { firstError ??= error; }
    }
    if (firstError) throw firstError;
    return serialResult ?? tcpResult;
  }
}

function serialRuntimeEndpoint(endpoint) {
  if (endpoint.transport === 'serial') return endpoint;
  return { ...endpoint, transport: 'serial' };
}

async function continueAfterError(operation, firstError) {
  try {
    await operation();
  } catch (error) {
    return firstError ?? error;
  }
  return firstError;
}

function serialError(code, message) {
  const error = new Error(message);
  error.name = 'SerialError';
  error.code = code;
  return error;
}

module.exports = { TransportCoordinator };
