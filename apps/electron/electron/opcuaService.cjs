const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { endpointUrl, normalizeConfig, readProfiles, writeProfiles, certificateInfo } = require('./opcuaStore.cjs');
const { validateNodeId, decodeValue, wireDataValue } = require('./opcuaValues.cjs');
const { OpcuaSimulator, ACTIONS: SERVER_ACTIONS } = require('./opcuaSimulator.cjs');

function bounded(operation, milliseconds = 10000, onTimeout = () => {}) {
  let timer;
  return Promise.race([Promise.resolve(operation), new Promise((_, reject) => {
    timer = setTimeout(() => { onTimeout(); reject(new Error(`OPC UA 操作超时 (${milliseconds}ms)`)); }, milliseconds);
  })]).finally(() => clearTimeout(timer));
}
function nodeIds(input) {
  if (!Array.isArray(input) || !input.length || input.length > 100) throw new Error('每次需要 1..100 个节点');
  return [...new Set(input.map(validateNodeId))];
}
function connectionId(id) {
  if (typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id)) throw new Error('连接 ID 无效');
  return id;
}

class OpcuaService {
  constructor({ directory, emitEvent = () => {} }) {
    this.directory = directory; this.emitEvent = emitEvent; this.connections = new Map();
    this.simulator = new OpcuaSimulator({ directory, emitEvent });
    this.discoveryClients = new Set(); this.knownCertificates = new Map(); this.closed = false; this.ready = null;
  }
  async initialize() {
    if (!this.ready) this.ready = (async () => {
      this.ua = require('node-opcua');
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      this.certificateManager = new this.ua.OPCUACertificateManager({ rootFolder: path.join(this.directory, 'pki'), automaticallyAcceptUnknownCertificate: false });
      await this.certificateManager.initialize();
    })().catch(error => { this.ready = null; throw error; });
    await this.ready;
    if (this.closed) throw new Error('OPC UA 服务已关闭');
  }
  emit(record, event) {
    if (this.connections.get(record.id) !== record || this.closed) return;
    try { this.emitEvent({ connectionId: record.id, sessionId: record.sessionId, ...event }); } catch { /* A closed renderer must not crash a native subscription. */ }
  }
  current(record) {
    if (this.closed || this.connections.get(record.id) !== record) throw new Error('OPC UA 会话已结束 session closed');
  }
  client(config = {}) {
    return this.ua.OPCUAClient.create({ applicationName: 'Ineed LinkLab', applicationUri: 'urn:ineedfull:linklab:opcua:client',
      clientCertificateManager: this.certificateManager,
      securityPolicy: this.ua.SecurityPolicy[config.securityPolicy ?? 'None'],
      securityMode: this.ua.MessageSecurityMode[config.securityMode ?? 'None'],
      connectionStrategy: { initialDelay: 300, maxDelay: 2000, maxRetry: 3 },
      endpointMustExist: true, keepSessionAlive: true, requestedSessionTimeout: 60000, transportTimeout: 10000,
      defaultTransactionTimeout: 10000 });
  }
  rememberCertificate(bytes, trusted = false) {
    if (!bytes?.length || bytes.length > 65536) return null;
    const info = certificateInfo(bytes, trusted);
    if (this.knownCertificates.size >= 128 && !this.knownCertificates.has(info.fingerprint)) this.knownCertificates.delete(this.knownCertificates.keys().next().value);
    this.knownCertificates.set(info.fingerprint, { bytes: Buffer.from(info.derBase64, 'base64'), info });
    return info;
  }
  async discover(url) {
    endpointUrl(url); await this.initialize();
    const client = this.client();
    const pending = { client, canceled: false }; this.discoveryClients.add(pending);
    const check = () => { if (pending.canceled || this.closed) throw new Error('OPC UA 发现已取消'); };
    try {
      return await bounded((async () => {
        await client.connect(url); check();
        const endpoints = await client.getEndpoints(); check();
        return { endpoints: endpoints.slice(0, 100).map(endpoint => ({
          endpointUrl: endpoint.endpointUrl,
          securityPolicy: String(endpoint.securityPolicyUri).split('#').pop(),
          securityMode: this.ua.MessageSecurityMode[endpoint.securityMode],
          authentication: [...new Set(endpoint.userIdentityTokens.map(t => t.tokenType === this.ua.UserTokenType.Anonymous ? 'anonymous' : t.tokenType === this.ua.UserTokenType.UserName ? 'username' : null).filter(Boolean))],
          serverCertificate: this.rememberCertificate(endpoint.serverCertificate),
        })) };
      })().finally(() => client.disconnect().catch(() => {})), 10000, () => { pending.canceled = true; void client.disconnect().catch(() => {}); });
    } finally { pending.canceled = true; this.discoveryClients.delete(pending); await client.disconnect().catch(() => {}); }
  }
  async connect(id, input) {
    connectionId(id); const config = normalizeConfig(input, true);
    const previous = this.connections.get(id);
    const record = { id, sessionId: randomUUID(), client: null, session: null, subscription: null, continuation: new Set() };
    if (this.connections.size >= 8) throw new Error('同时最多连接 8 个 OPC UA 服务器');
    this.connections.set(id, record);
    if (previous) await this.closeRecord(previous);
    const close = () => { if (this.connections.get(id) === record) this.connections.delete(id); void this.closeRecord(record); };
    try {
      return await bounded((async () => {
        this.current(record); await this.initialize(); this.current(record);
        if (config.securityPolicy !== 'None') {
          const discovery = await this.discover(config.endpointUrl); this.current(record);
          const endpoint = discovery.endpoints.find(e => e.securityPolicy === config.securityPolicy && e.securityMode === config.securityMode);
          if (!endpoint?.serverCertificate) throw new Error('服务器没有提供所选安全端点的证书');
          const bytes = Buffer.from(endpoint.serverCertificate.derBase64, 'base64');
          const result = await this.certificateManager.checkCertificate(bytes); this.current(record);
          if (!result.isGood()) throw new Error(`服务器证书未受信任或无效：${endpoint.serverCertificate.fingerprint} (${result.toString()})；核对证书后明确信任，再重连。`);
        }
        record.client = this.client(config);
        record.client.on('start_reconnection', () => this.emit(record, { type: 'status', status: 'reconnecting', message: '连接中断，正在恢复会话与订阅' }));
        record.client.on('after_reconnection', () => this.emit(record, { type: 'status', status: 'connected', message: '会话已恢复' }));
        record.client.on('connection_lost', () => this.emit(record, { type: 'status', status: 'reconnecting', message: '服务器连接中断' }));
        record.client.on('close', error => {
          if (this.connections.get(id) !== record) return;
          this.emit(record, { type: 'status', status: 'disconnected', message: error?.message ?? '连接已关闭' });
          if (this.connections.get(id) === record) this.connections.delete(id);
          void this.closeRecord(record);
        });
        await record.client.connect(config.endpointUrl); this.current(record);
        const identity = config.authentication === 'username'
          ? { type: this.ua.UserTokenType.UserName, userName: config.username, password: config.password }
          : { type: this.ua.UserTokenType.Anonymous };
        record.session = await record.client.createSession(identity); this.current(record);
        record.session.requestedMaxReferencesPerNode = 100;
        this.emit(record, { type: 'status', status: 'connected', message: '已连接' });
        return { sessionId: record.sessionId };
      })().catch(async error => { await this.closeRecord(record); throw error; }), 15000, close);
    } catch (error) { close(); throw error; }
  }
  async closeRecord(record) {
    // Take ownership before awaiting: close events can re-enter cleanup, and a
    // cancelled createSession may still return a new resource that needs its
    // own later cleanup pass.
    const { subscription, session, client } = record;
    record.subscription = null; record.session = null; record.client = null;
    await bounded(subscription?.terminate?.(), 1500).catch(() => {});
    await bounded(session?.close?.(), 1500).catch(() => {});
    await bounded(client?.disconnect?.(), 2000).catch(() => {});
  }
  async disconnect(id) {
    connectionId(id);
    const record = this.connections.get(id);
    this.connections.delete(id);
    if (record) await this.closeRecord(record);
    return { disconnected: true };
  }
  session(request) {
    if (this.closed) throw new Error('OPC UA 服务已关闭');
    const record = this.connections.get(connectionId(request.connectionId));
    if (!record?.session || record.sessionId !== request.sessionId) throw new Error('OPC UA 会话已失效 session expired，请重新连接');
    return record;
  }
  async certificates() {
    await this.initialize();
    for (const [folder, trusted] of [[this.certificateManager.rejectedFolder, false], [this.certificateManager.trustedFolder, true]]) {
      for (const name of (await fs.readdir(folder).catch(() => [])).slice(0, 128)) {
        try { this.rememberCertificate(await fs.readFile(path.join(folder, name)), trusted); } catch { /* Ignore non-certificate bookkeeping files. */ }
      }
    }
    return { certificates: [...this.knownCertificates.values()].map(item => item.info) };
  }
  async execute(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('OPC UA 请求无效');
    if (this.closed) throw new Error('OPC UA 服务已关闭');
    if (SERVER_ACTIONS.has(request.action)) return this.simulator.execute(request);
    switch (request.action) {
      case 'profiles': return { profiles: await readProfiles(this.directory) };
      case 'saveProfiles': return { profiles: await writeProfiles(this.directory, request.profiles) };
      case 'discover': return this.discover(request.endpointUrl);
      case 'connect': return this.connect(request.connectionId, request.config);
      case 'disconnect': return this.disconnect(request.connectionId);
      case 'certificates': return this.certificates();
      case 'trust': {
        await this.certificates();
        const item = this.knownCertificates.get(request.fingerprint);
        if (!item) throw new Error('未发现此指纹的服务器证书，请先发现端点');
        await this.certificateManager.trustCertificate(item.bytes); item.info.trusted = true;
        return { trusted: true };
      }
      default: return this.executeSession(request);
    }
  }
  async executeSession(request) {
    const record = this.session(request); const session = record.session;
    const operation = async () => {
      this.current(record);
      switch (request.action) {
        case 'releaseBrowse': {
          const cp = request.continuationPoint;
          if (typeof cp !== 'string' || !record.continuation.has(cp)) throw new Error('浏览分页标记已失效');
          // A release response may have no results. The SDK browseNext wrapper
          // asserts results[0], so use its transaction API for this request.
          const response = await new Promise((resolve, reject) => session.performMessageTransaction(
            new this.ua.BrowseNextRequest({ continuationPoints: [Buffer.from(cp, 'base64')], releaseContinuationPoints: true }),
            (error, result) => error ? reject(error) : resolve(result),
          ));
          this.current(record);
          if (!response?.responseHeader?.serviceResult?.isGood()) throw new Error(response?.responseHeader?.serviceResult?.toString() ?? '分页释放响应无效');
          for (const result of response.results ?? []) {
            if (!result.statusCode.isGood()) throw new Error(result.statusCode.toString());
          }
          record.continuation.delete(cp);
          return { released: true };
        }
        case 'browse': {
          let result;
          if (request.continuationPoint) {
            if (!record.continuation.delete(request.continuationPoint)) throw new Error('浏览分页标记已失效');
            result = await session.browseNext(Buffer.from(request.continuationPoint, 'base64'), false);
          } else {
            const nodeId = validateNodeId(request.nodeId ?? 'i=85');
            result = await session.browse({ nodeId, browseDirection: this.ua.BrowseDirection.Forward, includeSubtypes: true, nodeClassMask: 0, resultMask: 63 });
          }
          this.current(record);
          if (!result.statusCode.isGood()) throw new Error(result.statusCode.toString());
          const continuationPoint = result.continuationPoint?.length ? result.continuationPoint.toString('base64') : null;
          if (continuationPoint) record.continuation.add(continuationPoint);
          return { nodes: (result.references ?? []).map(node => ({ nodeId: node.nodeId.toString(), browseName: node.browseName.toString(), displayName: node.displayName.text ?? node.browseName.toString(), nodeClass: this.ua.NodeClass[node.nodeClass] })), continuationPoint };
        }
        case 'read': {
          const ids = nodeIds(request.nodeIds);
          const values = await session.read(ids.map(nodeId => ({ nodeId, attributeId: this.ua.AttributeIds.Value })), 0);
          this.current(record);
          return { values: values.map((value, i) => wireDataValue(ids[i], value, this.ua)) };
        }
        case 'write': {
          validateNodeId(request.nodeId);
          const value = decodeValue(request.dataType, request.arrayType ?? 'Scalar', request.value, this.ua);
          const status = await session.write({ nodeId: request.nodeId, attributeId: this.ua.AttributeIds.Value,
            value: { value: new this.ua.Variant({ dataType: this.ua.DataType[request.dataType], arrayType: this.ua.VariantArrayType[request.arrayType ?? 'Scalar'], value }) } });
          this.current(record);
          if (!status.isGood()) throw new Error(`写入失败：${status.toString()}`);
          return { statusCode: status.toString() };
        }
        case 'unsubscribe': {
          const previous = record.subscription; record.subscription = null;
          await previous?.terminate(); this.current(record); return { unsubscribed: true };
        }
        case 'subscribe': {
          const ids = nodeIds(request.nodeIds); const interval = request.intervalMs ?? 1000;
          if (!Number.isInteger(interval) || interval < 100 || interval > 60000) throw new Error('采样间隔必须为 100..60000ms');
          const previous = record.subscription; record.subscription = null;
          await previous?.terminate(); this.current(record);
          const subscription = await session.createSubscription2({ requestedPublishingInterval: interval, requestedLifetimeCount: 100, requestedMaxKeepAliveCount: 10, maxNotificationsPerPublish: 100, publishingEnabled: true, priority: 1 });
          if (this.connections.get(record.id) !== record) { await subscription.terminate(); this.current(record); }
          record.subscription = subscription;
          try {
          const group = await subscription.monitorItems(ids.map(nodeId => ({ nodeId, attributeId: this.ua.AttributeIds.Value })), { samplingInterval: interval, discardOldest: true, queueSize: 1 }, this.ua.TimestampsToReturn.Both);
          if (this.connections.get(record.id) !== record) { await subscription.terminate(); this.current(record); }
          const items = group.monitoredItems ?? [];
          const failures = ids.flatMap((id, index) => !items[index]?.statusCode?.isGood?.() ? [`${id}: ${items[index]?.statusCode?.toString?.() ?? 'Missing monitored item status'}`] : []);
          if (failures.length) throw new Error(`监视节点创建失败：${failures.join('; ')}`);
          group.on('changed', (item, value, index) => {
            if (record.subscription !== subscription) return;
            this.emit(record, { type: 'data', values: [wireDataValue(ids[index] ?? item.itemToMonitor.nodeId.toString(), value, this.ua)] });
          });
          group.on('err', error => this.emit(record, { type: 'status', status: 'error', message: String(error.message ?? error) }));
          return { subscriptionId: String(subscription.subscriptionId) };
          } catch (error) {
            if (record.subscription === subscription) record.subscription = null;
            await bounded(subscription.terminate(), 1500).catch(() => {});
            throw error;
          }
        }
        default: throw new Error('未知 OPC UA 操作');
      }
    };
    const perform = () => bounded(operation(), 10000, () => {
      if (this.connections.get(record.id) === record) {
        this.emit(record, { type: 'status', status: 'disconnected', message: `OPC UA ${request.action} 操作超时，会话已关闭，请重新连接` });
        this.connections.delete(record.id);
      }
      void this.closeRecord(record);
    });
    if (['subscribe', 'unsubscribe'].includes(request.action)) {
      const next = (record.subscriptionQueue ?? Promise.resolve()).catch(() => {}).then(perform);
      record.subscriptionQueue = next;
      return next;
    }
    return perform();
  }
  async shutdown() {
    this.closed = true;
    const records = [...this.connections.values()]; this.connections.clear();
    for (const pending of this.discoveryClients) pending.canceled = true;
    // Every resource group must attempt cleanup even if a simulator retained its
    // failed listener for retry. Certificates remain alive until clients finish.
    const operations = [() => this.simulator.shutdown(), ...records.map(record => () => this.closeRecord(record)),
      ...[...this.discoveryClients].map(pending => () => pending.client.disconnect())];
    const results = await Promise.allSettled(operations.map(operation => Promise.resolve().then(operation)));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (this.ready) await this.ready.catch(error => { errors.push(error); });
    try { await this.certificateManager?.dispose(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'OPC UA 资源关闭失败，请重试');
  }
}
module.exports = { OpcuaService, bounded };
