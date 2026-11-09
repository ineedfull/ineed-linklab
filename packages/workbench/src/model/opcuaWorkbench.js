export const OPCUA_DEFAULT_CONFIG = Object.freeze({ endpointUrl: 'opc.tcp://127.0.0.1:4840', securityPolicy: 'None', securityMode: 'None', authentication: 'anonymous', username: '', password: '' });
const DEFAULT_CONFIG = OPCUA_DEFAULT_CONFIG;
export const OPCUA_WRITE_TYPES = Object.freeze(['Boolean', 'SByte', 'Byte', 'Int16', 'UInt16', 'Int32', 'UInt32', 'Int64', 'UInt64', 'Float', 'Double', 'String', 'DateTime', 'ByteString', 'NodeId']);
const ranges = { SByte: [-128n, 127n], Byte: [0n, 255n], Int16: [-32768n, 32767n], UInt16: [0n, 65535n], Int32: [-2147483648n, 2147483647n], UInt32: [0n, 4294967295n], Int64: [-(1n << 63n), (1n << 63n) - 1n], UInt64: [0n, (1n << 64n) - 1n] };
const copy = value => JSON.parse(JSON.stringify(value));
const newId = () => globalThis.crypto?.randomUUID?.() ?? `ua-${Date.now()}-${Math.random().toString(16).slice(2)}`;
export function parseOpcuaInput(type, arrayType, text) {
  if (!OPCUA_WRITE_TYPES.includes(type)) throw new Error('此类型仅支持读取');
  if (!['Scalar', 'Array'].includes(arrayType)) throw new Error('仅支持标量和一维数组写入');
  let value;
  if (arrayType === 'Array') {
    try { value = JSON.parse(text); } catch { throw new Error('请输入有效的 JSON 数组'); }
    if (!Array.isArray(value) || value.length > 4096) throw new Error('JSON 数组最多 4096 项');
  } else if (type === 'Boolean') {
    if (!['true', 'false'].includes(text.trim())) throw new Error('布尔值请输入 true 或 false');
    value = text.trim() === 'true';
  } else if (ranges[type] && !type.endsWith('64')) {
    if (!/^-?\d+$/.test(text.trim())) throw new Error('请输入十进制整数');
    value = Number(text);
  } else if (type === 'Float' || type === 'Double') {
    if (!text.trim()) throw new Error('请输入数值');
    value = Number(text);
  } else value = type.endsWith('64') ? text.trim() : text;
  for (const item of arrayType === 'Array' ? value : [value]) {
    if (ranges[type]) {
      if (type.endsWith('64') ? typeof item !== 'string' || !/^-?\d+$/.test(item) : !Number.isSafeInteger(item)) throw new Error('整数格式无效；64 位整数必须使用十进制字符串以保持精度');
      const n = BigInt(item); if (n < ranges[type][0] || n > ranges[type][1]) throw new Error(`${type} 超出范围`);
    } else if (type === 'Boolean') {
      if (typeof item !== 'boolean') throw new Error('数组项必须是 true 或 false');
    } else if (['Float', 'Double'].includes(type)) {
      if (typeof item !== 'number' || !Number.isFinite(item) || type === 'Float' && !Number.isFinite(Math.fround(item))) throw new Error('请输入有限数值');
    } else if (typeof item !== 'string') throw new Error(`${type} 必须使用字符串`);
  }
  return value;
}
export function safeOpcuaProfiles(input) {
  if (!Array.isArray(input) || input.length > 50) throw new Error('连接配置必须为数组，最多 50 个');
  const ids = new Set();
  const profiles = input.map(item => {
    if (!item || typeof item.id !== 'string' || !/^[\w-]{1,80}$/.test(item.id) || ids.has(item.id) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100) throw new Error('连接配置 ID 或名称无效/重复');
    ids.add(item.id);
    const source = item.config;
    let url; try { url = new URL(source?.endpointUrl); } catch { throw new Error('连接地址无效'); }
    if (url.protocol !== 'opc.tcp:' || !url.hostname || url.username || url.password || url.hash || url.search) throw new Error('连接地址必须为不含凭据的 opc.tcp 地址');
    const config = Object.fromEntries(Object.keys(DEFAULT_CONFIG).filter(k => k !== 'password').map(k => [k, source[k] ?? DEFAULT_CONFIG[k]]));
    const favorites = item.favorites ?? [];
    if (!Array.isArray(favorites) || favorites.length > 100) throw new Error('收藏节点最多 100 个');
    return { id: item.id, name: item.name.trim(), config, favorites: favorites.map(n => {
      if (typeof n.nodeId !== 'string' || n.nodeId.length > 1024) throw new Error('收藏节点无效');
      return { nodeId: n.nodeId, displayName: String(n.displayName ?? n.nodeId).slice(0, 256) };
    }) };
  });
  if (new TextEncoder().encode(JSON.stringify(profiles, null, 2)).byteLength > 1024 * 1024) throw new Error('连接配置文件最多 1 MiB');
  return profiles;
}
function csvCell(input) {
  let text = input === null || input === undefined ? '' : typeof input === 'object' ? JSON.stringify(input) : String(input);
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function opcuaCsv(rows) {
  const keys = ['nodeId', 'dataType', 'arrayType', 'value', 'statusCode', 'sourceTimestamp', 'serverTimestamp'];
  return '\uFEFF' + [keys.map(csvCell).join(','), ...rows.map(row => keys.map(key => csvCell(row[key])).join(','))].join('\r\n');
}
export function opcuaDisplayValue(value) { return value === null || value === undefined ? '—' : typeof value === 'string' ? value : JSON.stringify(value); }

export function createOpcuaWorkbench(runtime, { reactive = v => v, now = () => new Date().toISOString(), schedule = (fn, delay) => setTimeout(fn, delay), cancel = timer => clearTimeout(timer) } = {}) {
  const state = reactive({ config: { ...DEFAULT_CONFIG }, name: '新 OPC UA 连接', profileId: '', profiles: [], favorites: [], endpoints: [], certificates: [],
    sessionId: null, connectionId: '', status: 'disconnected', statusMessage: '', busy: '', error: '', feedback: '',
    nodeId: 'i=85', nodes: [], breadcrumbs: [{ nodeId: 'i=85', displayName: 'Objects' }], continuationPoint: null,
    values: {}, records: [], monitored: [], subscriptionId: null });
  let revision = 0; let disposed = false; let stop;
  // Native subscriptions may deliver one event per node. Keep ingestion outside
  // Vue, and publish at most one bounded snapshot per 50ms instead of shifting
  // 1000 reactive history entries for every incoming value.
  const latestValues = new Map();
  let records = new Array(1000); let recordStart = 0; let recordCount = 0;
  let publication = null; let dirty = false;
  function cancelPublication() {
    const current = publication; publication = null;
    if (current) cancel(current.timer);
  }
  function flushValues() {
    cancelPublication();
    if (!dirty) return;
    dirty = false;
    state.values = Object.fromEntries(latestValues);
    state.records = Array.from({ length: recordCount }, (_, index) => records[(recordStart + index) % 1000]);
  }
  function clearBufferedRecords() { records = new Array(1000); recordStart = 0; recordCount = 0; }
  function clearValues() { cancelPublication(); dirty = false; latestValues.clear(); clearBufferedRecords(); state.values = {}; state.records = []; }
  const execute = request => {
    if (!runtime?.opcua?.execute) return Promise.reject(new Error('当前运行环境不支持 OPC UA，请使用新版桌面应用'));
    return runtime.opcua.execute(copy(request));
  };
  const ignoreFailure = promise => Promise.resolve(promise).catch(() => {});
  function acceptValues(values) {
    for (const row of values.slice(0, 100)) {
      if (!row || typeof row.nodeId !== 'string') continue;
      const snapshot = copy(row);
      latestValues.set(row.nodeId, snapshot);
      if (latestValues.size > 500) latestValues.delete(latestValues.keys().next().value);
      const index = (recordStart + recordCount) % 1000;
      records[index] = { ...snapshot, receivedAt: now() };
      if (recordCount < 1000) recordCount++;
      else recordStart = (recordStart + 1) % 1000;
      dirty = true;
    }
    if (dirty && !publication) {
      const current = {}; publication = current;
      current.timer = schedule(() => { if (!disposed && publication === current) flushValues(); }, 50);
    }
  }
  stop = runtime?.opcua?.onEvent?.(event => {
    if (disposed || !state.sessionId || event?.connectionId !== state.connectionId || event.sessionId !== state.sessionId) return;
    if (event.type === 'data' && Array.isArray(event.values)) acceptValues(event.values);
    if (event.type === 'status') {
      const message = String(event.message ?? '');
      if (event.status === 'disconnected') { revision++; resetSession(); state.busy = ''; state.error = message; }
      state.status = event.status; state.statusMessage = message;
    }
  });
  async function run(name, operation) {
    if (disposed || state.busy) return false;
    const token = ++revision; state.busy = name; state.error = ''; state.feedback = '';
    const active = () => !disposed && token === revision;
    try { return await operation(active); }
    catch (error) { if (active()) state.error = error.message || String(error); return false; }
    finally { if (active()) state.busy = ''; }
  }
  const request = (action, body = {}) => execute({ action, connectionId: state.connectionId, sessionId: state.sessionId, ...body });
  function resetSession() { flushValues(); state.connectionId = ''; state.sessionId = null; state.subscriptionId = null; state.continuationPoint = null; state.status = 'disconnected'; state.statusMessage = ''; state.monitored = []; }
  const api = {
    state,
    async initialize() { return run('profiles', async active => { const data = await execute({ action: 'profiles' }); if (active()) state.profiles = safeOpcuaProfiles(data.profiles); }); },
    async discover() { return run('discover', async active => { const url = state.config.endpointUrl; const data = await execute({ action: 'discover', endpointUrl: url }); if (active() && url === state.config.endpointUrl) { state.endpoints = data.endpoints; state.feedback = `发现 ${data.endpoints.length} 个端点`; } }); },
    chooseEndpoint(index) {
      if (state.sessionId || state.busy) return;
      const endpoint = state.endpoints[Number(index)]; if (!endpoint) return;
      Object.assign(state.config, { endpointUrl: endpoint.endpointUrl, securityPolicy: endpoint.securityPolicy, securityMode: endpoint.securityMode });
      if (!endpoint.authentication.includes(state.config.authentication)) state.config.authentication = endpoint.authentication[0] ?? 'anonymous';
    },
    async connect() {
      if (state.sessionId || ['connecting', 'connected', 'reconnecting'].includes(state.status)) return false;
      return run('connect', async active => {
        const id = newId(); state.connectionId = id; state.status = 'connecting';
        const config = copy(state.config);
        try {
          const result = await execute({ action: 'connect', connectionId: id, config });
          if (!active()) { await ignoreFailure(execute({ action: 'disconnect', connectionId: id })); return false; }
          state.sessionId = result.sessionId; state.status = 'connected'; state.statusMessage = '已连接'; state.feedback = '连接成功';
          clearValues(); state.nodes = []; state.continuationPoint = null; state.breadcrumbs = [{ nodeId: 'i=85', displayName: 'Objects' }]; state.nodeId = 'i=85';
          return true;
        } catch (error) { if (active()) resetSession(); throw error; }
      });
    },
    async disconnect() {
      const id = state.connectionId; const token = ++revision; state.busy = 'disconnect'; resetSession(); state.error = '';
      try { if (id) await execute({ action: 'disconnect', connectionId: id }); if (token === revision && !disposed) state.feedback = '已断开'; }
      catch (error) { if (token === revision && !disposed) state.error = error.message; }
      finally { if (token === revision && !disposed) state.busy = ''; }
    },
    async browse(node = { nodeId: state.nodeId, displayName: state.nodeId }, more = false) {
      if (!state.sessionId) { state.error = '请先连接服务器'; return false; }
      return run('browse', async active => {
        // Keep ownership until release succeeds, so failure can be retried.
        const session = { connectionId: state.connectionId, sessionId: state.sessionId };
        const release = async () => {
          if (!state.continuationPoint) return;
          await execute({ action: 'releaseBrowse', ...session, continuationPoint: state.continuationPoint });
          if (active()) state.continuationPoint = null;
        };
        if (!more || state.nodes.length >= 2000) await release();
        if (!active() || more && (state.nodes.length >= 2000 || !state.continuationPoint)) return;
        const data = await execute({ action: 'browse', ...session, nodeId: node.nodeId, ...(more ? { continuationPoint: state.continuationPoint } : {}) });
        if (!active()) return;
        state.nodes = more ? [...state.nodes, ...data.nodes].slice(0, 2000) : data.nodes;
        state.continuationPoint = data.continuationPoint;
        if (state.nodes.length >= 2000) await release();
        if (!active()) return;
        if (!more) {
          const index = state.breadcrumbs.findIndex(n => n.nodeId === node.nodeId);
          state.breadcrumbs = index >= 0 ? state.breadcrumbs.slice(0, index + 1) : [...state.breadcrumbs, node].slice(-30);
          state.nodeId = node.nodeId;
        }
      });
    },
    async read(ids) { return run('read', async active => { const data = await request('read', { nodeIds: ids }); if (active()) { acceptValues(data.values); flushValues(); } }); },
    async write({ nodeId, dataType, arrayType = 'Scalar', text }) {
      return run('write', async active => {
        const value = parseOpcuaInput(dataType, arrayType, text); const data = await request('write', { nodeId, dataType, arrayType, value });
        if (!String(data.statusCode).startsWith('Good')) throw new Error(`写入失败：${data.statusCode}`);
        if (active()) state.feedback = `写入成功：${nodeId}`;
      });
    },
    async subscribe(ids, intervalMs = 1000) {
      return run('subscribe', async active => {
        if (!Array.isArray(ids) || !ids.length || ids.length > 100) throw new Error('每次需要 1..100 个节点');
        if (ids.some(id => typeof id !== 'string' || id.length > 1024 || !/^(?:ns=\d+;)?(?:i=\d+|s=.+|g=[0-9a-fA-F-]{36}|b=[A-Za-z0-9+/=]*)$/.test(id))) throw new Error('NodeId 格式无效，例如 ns=2;s=Temperature');
        if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 60000) throw new Error('采样间隔必须为 100..60000ms');
        state.subscriptionId = null; state.monitored = [];
        const data = await request('subscribe', { nodeIds: ids, intervalMs });
        if (active()) { state.subscriptionId = data.subscriptionId; state.monitored = [...ids]; state.feedback = `正在监视 ${ids.length} 个节点`; }
      });
    },
    async unsubscribe() { return run('unsubscribe', async active => { await request('unsubscribe'); if (active()) { state.subscriptionId = null; state.monitored = []; state.feedback = '监视已停止'; } }); },
    async loadCertificates() { return run('certificates', async active => { const data = await execute({ action: 'certificates' }); if (active()) state.certificates = data.certificates; }); },
    async trust(fingerprint) { return run('trust', async active => { await execute({ action: 'trust', fingerprint }); const data = await execute({ action: 'certificates' }); if (active()) { state.certificates = data.certificates; state.feedback = '证书已信任，请重新连接'; } }); },
    selectProfile(id) {
      if (state.sessionId || state.busy) return;
      const profile = state.profiles.find(p => p.id === id);
      state.profileId = id; state.endpoints = []; state.nodes = []; clearValues();
      state.nodeId = 'i=85'; state.breadcrumbs = [{ nodeId: 'i=85', displayName: 'Objects' }]; state.continuationPoint = null; state.error = ''; state.feedback = '';
      state.name = profile?.name ?? '新 OPC UA 连接'; state.config = { ...DEFAULT_CONFIG, ...copy(profile?.config ?? {}) }; state.favorites = copy(profile?.favorites ?? []);
    },
    async saveProfile() {
      return run('saveProfiles', async active => {
        const id = state.profileId || newId();
        const profile = { id, name: state.name, config: state.config, favorites: state.favorites };
        const list = state.profiles.filter(p => p.id !== id); list.push(profile);
        const data = await execute({ action: 'saveProfiles', profiles: safeOpcuaProfiles(list) });
        if (active()) { state.profiles = safeOpcuaProfiles(data.profiles); state.profileId = id; state.feedback = '连接与收藏已保存，密码不落盘'; }
      });
    },
    async deleteProfile() {
      return run('saveProfiles', async active => {
        const data = await execute({ action: 'saveProfiles', profiles: state.profiles.filter(p => p.id !== state.profileId) });
        if (active()) { state.profiles = safeOpcuaProfiles(data.profiles); state.profileId = ''; state.feedback = '连接配置已删除'; }
      });
    },
    async importProfiles(text) {
      return run('import', async active => {
        if (new TextEncoder().encode(text).byteLength > 1024 * 1024) throw new Error('导入文件最多 1 MiB');
        const incoming = safeOpcuaProfiles(JSON.parse(text));
        const merged = new Map(state.profiles.map(p => [p.id, p]));
        for (const profile of incoming) merged.set(profile.id, profile);
        const data = await execute({ action: 'saveProfiles', profiles: [...merged.values()] });
        if (active()) { state.profiles = safeOpcuaProfiles(data.profiles); state.feedback = '连接配置已合并导入，密码需重新填写'; }
      });
    },
    toggleFavorite(node) {
      const index = state.favorites.findIndex(n => n.nodeId === node.nodeId);
      if (index >= 0) state.favorites.splice(index, 1);
      else if (state.favorites.length < 100) state.favorites.push({ nodeId: node.nodeId, displayName: node.displayName ?? node.nodeId });
      else state.error = '最多收藏 100 个节点';
    },
    clearRecords() { clearBufferedRecords(); state.records = []; },
    async exportData() { return run('export', async active => { flushValues(); const result = await execute({ action: 'export', fileName: 'opcua-values.csv', content: opcuaCsv(state.records) }); if (active()) state.feedback = result.saved ? '变化记录已导出' : '已取消导出'; }); },
    async exportProfiles() { return run('export', async active => { const result = await execute({ action: 'export', fileName: 'opcua-profiles.json', content: JSON.stringify(safeOpcuaProfiles(state.profiles), null, 2) }); if (active()) state.feedback = result.saved ? '连接配置已导出（不含密码）' : '已取消导出'; }); },
    async dispose() { if (disposed) return; disposed = true; revision++; const id = state.connectionId; resetSession(); await stop?.(); if (id) await ignoreFailure(execute({ action: 'disconnect', connectionId: id })); },
  };
  return api;
}
