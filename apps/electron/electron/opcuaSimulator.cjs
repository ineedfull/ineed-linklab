const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { normalizeConfig, normalizeNodes, validateValue, connectionId, readProfiles, writeProfiles } = require('./opcuaSimulatorStore.cjs');
const { decodeValue, wireDataValue, encodeValue } = require('./opcuaValues.cjs');
const ACTIONS = new Set(['serverProfiles', 'saveServerProfiles', 'startServer', 'stopServer', 'serverSnapshot', 'setServerValue']);

class OpcuaSimulator {
  constructor({ directory, emitEvent = () => {} }) {
    this.directory = directory; this.emitEvent = emitEvent; this.records = new Map(); this.closed = false; this.ready = null;
  }
  async initialize() {
    if (!this.ready) this.ready = (async () => {
      this.ua = require('node-opcua');
      await fs.mkdir(path.join(this.directory, 'server-pki'), { recursive: true, mode: 0o700 });
    })();
    await this.ready;
    if (this.closed) throw new Error('OPC UA 服务端已关闭');
  }
  current(record) {
    if (this.closed || record.cancelled || this.records.get(record.id) !== record) throw new Error('OPC UA 服务端会话已结束 session closed，启动已取消');
  }
  session(request) {
    const record = this.records.get(connectionId(request.connectionId));
    if (!record || !record.running || record.sessionId !== request.sessionId) throw new Error('OPC UA 服务端会话已失效 session expired');
    this.current(record); return record;
  }
  async execute(request) {
    if (this.closed) throw new Error('OPC UA 服务端已关闭');
    switch (request.action) {
      case 'serverProfiles': return { profiles: await readProfiles(this.directory) };
      case 'saveServerProfiles': return { profiles: await writeProfiles(this.directory, request.profiles) };
      case 'startServer': return this.start(request);
      case 'stopServer': return this.stop(request);
      case 'serverSnapshot': {
        const record = this.session(request);
        return { values: [...record.variables.values()].map(({ variable }) => wireDataValue(variable.nodeId.toString(), variable.readValue(), this.ua)) };
      }
      case 'setServerValue': {
        const record = this.session(request); const item = record.variables.get(request.nodeId);
        if (!item) throw new Error('服务端节点不存在');
        this.setValue(item, request.value); return { updated: true };
      }
      default: throw new Error('未知 OPC UA 服务端操作');
    }
  }
  async start(request) {
    const id = connectionId(request.connectionId); const config = normalizeConfig(request.config); const nodes = normalizeNodes(request.nodes);
    if (this.records.has(id)) throw new Error('此 OPC UA 服务端已经启动或正在停止');
    if (this.records.size >= 4) throw new Error('同时最多启动 4 个 OPC UA 服务端（含启动中）');
    const occupied = new Set([...this.records.values()].map(record => record.slot));
    const slot = [0, 1, 2, 3].find(candidate => !occupied.has(candidate));
    const record = { id, slot, sessionId: randomUUID(), config, nodes, variables: new Map(), running: false, cancelled: false, server: null, timer: null };
    this.records.set(id, record);
    record.opening = this.open(record);
    return record.opening;
  }
  async open(record) {
    try {
      await this.initialize(); this.current(record);
      const ua = this.ua; const config = record.config;
      // UI connection IDs change on each start; four stable slots also bound PKI
      // storage while each running SDK server owns its own certificate manager.
      const directory = path.join(this.directory, 'server-pki', `slot-${record.slot}`);
      record.manager = new ua.OPCUACertificateManager({ rootFolder: directory, automaticallyAcceptUnknownCertificate: false });
      record.userManager = new ua.OPCUACertificateManager({ rootFolder: path.join(directory, 'users'), automaticallyAcceptUnknownCertificate: false });
      await record.manager.initialize(); this.current(record);
      const certificateFile = path.join(directory, 'simulator.pem');
      try { await fs.access(certificateFile); }
      catch { await record.manager.createSelfSignedCertificate({ applicationUri: 'urn:ineedfull:linklab:opcua:simulator', subject: '/CN=Ineed LinkLab Simulator', dns: ['localhost', ua.getFullyQualifiedDomainName()], ip: ['127.0.0.1'], validity: 365, outputFile: certificateFile }); }
      this.current(record);
      const server = new ua.OPCUAServer({ port: config.listenPort, host: config.listenHost, hostname: '127.0.0.1', alternateHostname: ['localhost'], resourcePath: config.path,
        // Bound incomplete HEL/OPN peers just as the Rust SDK does; the SDK's
        // three-minute default otherwise holds scarce channel slots until then.
        timeout: 5000,
        serverCertificateManager: record.manager, userCertificateManager: record.userManager, certificateFile,
        serverInfo: { applicationUri: 'urn:ineedfull:linklab:opcua:simulator', productUri: 'urn:ineedfull:linklab:opcua:simulator', applicationName: { text: 'Ineed LinkLab Simulator' } },
        securityPolicies: [ua.SecurityPolicy.None], securityModes: [ua.MessageSecurityMode.None], allowAnonymous: true,
        userManager: { isValidUser: () => false }, registerServerMethod: ua.RegisterServerMethod.HIDDEN,
        serverCapabilities: { maxSessions: 16, maxSubscriptions: 32, maxMonitoredItems: 3200, operationLimits: { maxNodesPerRead: 100, maxNodesPerWrite: 100, maxNodesPerBrowse: 100 } } });
      record.server = server;
      const failed = error => this.fail(record, error);
      server.on('error', failed);
      await server.initialize(); this.current(record);
      const namespace = server.engine.addressSpace.registerNamespace(config.namespaceUri);
      const folder = namespace.addObject({ organizedBy: server.engine.addressSpace.rootFolder.objects, browseName: 'LinkLab' });
      for (const definition of record.nodes) {
        const item = { definition, currentValue: this.variant(definition, definition.value), variable: null, nextTick: 0 };
        const variable = namespace.addVariable({ componentOf: folder, nodeId: `ns=${namespace.index};s=${definition.id}`, browseName: definition.name,
          dataType: definition.dataType, valueRank: definition.arrayType === 'Array' ? 1 : -1, arrayDimensions: definition.arrayType === 'Array' ? [0] : null,
          minimumSamplingInterval: 50, accessLevel: definition.writable ? 'CurrentRead | CurrentWrite' : 'CurrentRead',
          userAccessLevel: definition.writable ? 'CurrentRead | CurrentWrite' : 'CurrentRead',
          value: { get: () => item.currentValue, set: variant => {
            try {
              this.current(record);
              if (!definition.writable) return ua.StatusCodes.BadNotWritable;
              if (variant.dataType !== ua.DataType[definition.dataType] || variant.arrayType !== ua.VariantArrayType[definition.arrayType]) return ua.StatusCodes.BadTypeMismatch;
              const value = encodeValue(definition.dataType, variant.value, definition.arrayType);
              validateValue(definition.dataType, definition.arrayType, value);
              item.currentValue = variant.clone(); return ua.StatusCodes.Good;
            } catch { return ua.StatusCodes.BadOutOfRange; }
          } } });
        item.variable = variable; record.variables.set(variable.nodeId.toString(), item);
      }
      await server.start(); this.current(record);
      record.running = true;
      for (const item of record.variables.values()) item.nextTick = Date.now() + item.definition.simulation.intervalMs;
      if (record.nodes.some(n => n.simulation.mode !== 'manual')) record.timer = setInterval(() => {
        try { this.tick(record); } catch (error) { this.fail(record, error); }
      }, 50);
      return { sessionId: record.sessionId, endpointUrl: `opc.tcp://${config.listenHost === '0.0.0.0' ? '127.0.0.1' : config.listenHost}:${config.listenPort}${config.path}`, namespaceIndex: namespace.index,
        nodes: [...record.variables.values()].map(({ definition, variable }) => ({ id: definition.id, nodeId: variable.nodeId.toString() })) };
    } catch (error) {
      record.cancelled = true;
      try { await this.close(record); }
      finally { if (record.cleanupComplete && this.records.get(record.id) === record) this.records.delete(record.id); }
      throw error;
    }
  }
  variant(definition, value) {
    return new this.ua.Variant({ dataType: this.ua.DataType[definition.dataType], arrayType: this.ua.VariantArrayType[definition.arrayType], value: decodeValue(definition.dataType, definition.arrayType, value, this.ua) });
  }
  setValue(item, value) {
    const { definition, variable } = item;
    validateValue(definition.dataType, definition.arrayType, value);
    item.currentValue = this.variant(definition, value);
    variable.setValueFromSource(item.currentValue, this.ua.StatusCodes.Good, new Date());
  }
  tick(record) {
    this.current(record); const now = Date.now();
    for (const item of record.variables.values()) {
      const simulation = item.definition.simulation;
      if (simulation.mode === 'manual' || item.nextTick > now) continue;
      // One bounded pass: a sleeping computer never queues a burst of missed updates.
      item.nextTick = now + simulation.intervalMs;
      const previous = item.variable.readValue().value.value;
      let next;
      if (simulation.mode === 'toggle') next = !previous;
      else {
        const value = previous + simulation.step;
        next = !Number.isFinite(value) || value < simulation.min || value > simulation.max ? simulation.min : value;
      }
      this.setValue(item, next);
    }
  }
  fail(record, error) {
    if (this.records.get(record.id) !== record || record.cancelled || this.closed) return;
    try { this.emitEvent({ type: 'serverStatus', connectionId: record.id, sessionId: record.sessionId, status: 'error', message: String(error?.message ?? error) }); } catch { /* A closed renderer cannot interrupt cleanup. */ }
    void this.stop({ connectionId: record.id, sessionId: record.sessionId }).catch(() => {});
  }
  async close(record) {
    clearInterval(record.timer); record.timer = null; record.running = false;
    if (!record.closing) record.closing = (async () => {
      const server = record.server;
      let shutdownError;
      try { if (server) await server.shutdown(0); }
      catch (error) {
        // dispose() only drops SDK references; it does not close listeners. Keep
        // the server, managers and slot if shutdown failed before disposal, so
        // a later stop/shutdown can retry without losing socket ownership.
        if (server?.endpoints?.length) throw error;
        shutdownError = error;
      }
      // Failed initialization can leave a constructed SDK server whose shutdown
      // succeeds as a no-op. It has no listening socket, but still owns registry
      // and address-space resources which need disposal.
      if (server?.endpoints?.length) server.dispose();
      record.server = null; record.variables.clear();
      await Promise.allSettled([record.manager?.dispose(), record.userManager?.dispose()]);
      record.cleanupComplete = true;
      if (shutdownError) throw shutdownError;
    })();
    const closing = record.closing;
    try { return await closing; }
    finally { if (!record.cleanupComplete && record.closing === closing) record.closing = null; }
  }
  async stop(request) {
    const record = this.records.get(connectionId(request.connectionId));
    if (!record || (request.sessionId !== undefined && request.sessionId !== record.sessionId)) return { stopped: true };
    record.cancelled = true; clearInterval(record.timer); record.timer = null;
    try { await record.opening.catch(() => {}); await this.close(record); }
    finally { if (record.cleanupComplete && this.records.get(record.id) === record) this.records.delete(record.id); }
    return { stopped: true };
  }
  async shutdown() {
    if (this.shuttingDown) return this.shuttingDown;
    this.closed = true;
    this.shuttingDown = (async () => {
      const results = await Promise.allSettled([...this.records.values()].map(record => this.stop({ connectionId: record.id })));
      if (this.ready) await this.ready.catch(() => {});
      if (this.records.size) throw new AggregateError(results.filter(result => result.status === 'rejected').map(result => result.reason), 'OPC UA 服务端关闭失败，请重试');
    })();
    try { return await this.shuttingDown; }
    finally { if (this.records.size) this.shuttingDown = null; }
  }
}
module.exports = { OpcuaSimulator, ACTIONS };
