import { OPCUA_SERVER_DEFAULT_CONFIG, opcuaExampleNodes, safeOpcuaServerConfig, safeOpcuaServerNodes, safeOpcuaServerProfiles, parseSimulatorValue } from './opcuaSimulatorConfig.js';
const copy = value => JSON.parse(JSON.stringify(value));
const newId = () => globalThis.crypto.randomUUID();

/** Each endpoint owns its native server and one serial snapshot loop. */
export function createOpcuaSimulator(runtime, { reactive = value => value, schedule = (fn, ms) => setTimeout(fn, ms), cancel = id => clearTimeout(id) } = {}) {
  const state = reactive({ name: '新 OPC UA 模拟服务端', profileId: '', profiles: [], config: { ...OPCUA_SERVER_DEFAULT_CONFIG }, nodes: opcuaExampleNodes(),
    connectionId: '', sessionId: null, status: 'disconnected', busy: '', error: '', feedback: '', statusMessage: '', endpointUrl: '', namespaceIndex: null, nodeIds: {}, values: {} });
  let disposed = false, revision = 0, timer = null, stopping = null;
  const starts = new Set();
  const execute = request => runtime.opcua.execute(copy(request));
  const isActive = () => !!state.sessionId || state.status === 'connecting';
  const stopPolling = () => { if (timer !== null) cancel(timer); timer = null; };
  const current = (generation, session) => !disposed && generation === revision && state.sessionId === session;
  const stopEvents = runtime.opcua.onEvent?.(event => {
    if (disposed || event?.type !== 'serverStatus' || event.connectionId !== state.connectionId || event.sessionId !== state.sessionId) return;
    if (['error', 'disconnected', 'stopped'].includes(event.status)) {
      ++revision; stopPolling();
      // An error reports failure, not confirmed cleanup. Keep the session so
      // Stop/Delete can retry even if native shutdown retained its listener.
      if (event.status !== 'error') state.sessionId = null;
      state.status = event.status === 'error' ? 'error' : 'disconnected'; state.error = event.message || '模拟服务端已停止';
    }
  });
  async function snapshot(generation, session) {
    try {
      const result = await execute({ action: 'serverSnapshot', connectionId: state.connectionId, sessionId: session });
      if (!current(generation, session)) return;
      const known = new Set(Object.values(state.nodeIds));
      state.values = Object.fromEntries((result.values ?? []).slice(0, 100).filter(row => known.has(row.nodeId)).map(row => [row.nodeId, copy(row)]));
    } catch (error) { if (current(generation, session)) state.error = error.message; }
    if (current(generation, session)) timer = schedule(() => { timer = null; return snapshot(generation, session); }, 1000);
  }
  function editable() {
    if (disposed || isActive() || state.busy) { state.error = '请先停止服务端并等待操作结束'; return false; }
    state.error = ''; return true;
  }
  async function operation(action) {
    if (disposed || state.busy) return false;
    state.error = ''; state.feedback = ''; state.busy = action;
    try { await actions[action](); return true; }
    catch (error) { state.error = error.message; return false; }
    finally { state.busy = ''; }
  }
  function applyInitialValues() {
    try {
      const nodes = safeOpcuaServerNodes(state.nodes.map(node => {
        const { initialText, ...config } = node;
        return initialText === undefined ? config : { ...config, value: parseSimulatorValue(node.dataType, node.arrayType, initialText) };
      }));
      nodes.forEach((node, i) => { state.nodes[i].value = node.value; delete state.nodes[i].initialText; });
      state.error = ''; return true;
    } catch (error) { state.error = error.message; return false; }
  }
  const actions = {
    async initialize() { state.profiles = safeOpcuaServerProfiles((await execute({ action: 'serverProfiles' })).profiles ?? []); },
    async saveProfile() {
      if (isActive()) throw new Error('请先停止服务端再保存配置');
      if (!applyInitialValues()) throw new Error(state.error);
      const profile = safeOpcuaServerProfiles([{ id: state.profileId || newId(), name: state.name, config: state.config, nodes: state.nodes }])[0];
      const latest = safeOpcuaServerProfiles((await execute({ action: 'serverProfiles' })).profiles ?? []);
      const profiles = safeOpcuaServerProfiles([...latest.filter(row => row.id !== profile.id), profile]);
      await execute({ action: 'saveServerProfiles', profiles }); state.profiles = profiles; state.profileId = profile.id; state.feedback = '初始节点配置已保存';
    },
  };
  const api = {
    state,
    applyInitialValues,
    initialize: () => operation('initialize'),
    selectProfile(id) {
      if (!editable()) return false;
      const p = state.profiles.find(p => p.id === id);
      if (id && !p) { state.error = '配置不存在'; return false; }
      state.profileId = p?.id ?? ''; state.name = p?.name ?? '新 OPC UA 模拟服务端'; state.config = copy(p?.config ?? OPCUA_SERVER_DEFAULT_CONFIG); state.nodes = copy(p?.nodes ?? opcuaExampleNodes());
      state.nodeIds = {}; state.values = {}; state.endpointUrl = ''; return true;
    },
    connect() {
      if (disposed || isActive() || state.busy) return Promise.resolve(false);
      if (!applyInitialValues()) return Promise.resolve(false);
      const generation = ++revision;
      state.error = ''; state.feedback = ''; state.status = 'connecting'; state.connectionId = newId();
      const connectionId = state.connectionId;
      const starting = (async () => {
        try {
          const config = safeOpcuaServerConfig(state.config), nodes = safeOpcuaServerNodes(state.nodes);
          const result = await execute({ action: 'startServer', connectionId, config, nodes });
          if (disposed || generation !== revision) {
            try {
              await execute({ action: 'stopServer', connectionId, sessionId: result.sessionId });
              if (!disposed && state.connectionId === connectionId && state.status === 'connecting') state.status = 'disconnected';
            } catch (error) {
              if (!disposed && state.connectionId === connectionId) {
                state.sessionId = result.sessionId; state.status = 'listening'; state.error = error.message;
              }
            }
            return false;
          }
          if (!result.sessionId) throw new Error('原生服务端未返回会话');
          state.sessionId = result.sessionId; state.status = 'listening'; state.endpointUrl = result.endpointUrl; state.namespaceIndex = result.namespaceIndex;
          state.nodeIds = Object.fromEntries((result.nodes ?? []).map(n => [n.id, n.nodeId])); state.values = {};
          await snapshot(generation, result.sessionId); return current(generation, result.sessionId);
        } catch (error) {
          if (!disposed && generation === revision) { state.status = 'error'; state.error = error.message; }
          return false;
        }
      })();
      starts.add(starting); void starting.finally(() => starts.delete(starting)); return starting;
    },
    disconnect() {
      if (stopping) return stopping;
      const generation = ++revision; stopPolling();
      const connectionId = state.connectionId, sessionId = state.sessionId;
      if (!isActive()) return Promise.resolve(true);
      // Invalidate incoming snapshots immediately, but retain native identity
      // until stop is confirmed so a failed request can be retried safely.
      state.sessionId = null; state.status = 'disconnected'; state.busy = 'disconnect';
      stopping = (async () => {
        try { await execute({ action: 'stopServer', connectionId, ...(sessionId ? { sessionId } : {}) }); return true; }
        catch (error) {
          state.error = error.message; state.sessionId = sessionId; state.status = sessionId ? 'listening' : 'connecting';
          if (sessionId && !disposed) void snapshot(generation, sessionId);
          return false;
        } finally { if (state.busy === 'disconnect') state.busy = ''; stopping = null; }
      })();
      return stopping;
    },
    saveProfile: () => operation('saveProfile'),
    loadExamples() { if (!editable()) return false; state.nodes = opcuaExampleNodes(); return true; },
    addNode() {
      if (!editable()) return false;
      if (state.nodes.length >= 100) { state.error = '最多 100 个节点'; return false; }
      let n = 1; while (state.nodes.some(row => row.id === `Node${n}`)) n++;
      state.nodes.push({ ...opcuaExampleNodes()[0], id: `Node${n}`, name: `节点 ${n}`, value: 0 }); return true;
    },
    removeNode(index) { if (!editable()) return false; if (state.nodes.length <= 1) { state.error = '至少保留一个节点'; return false; } state.nodes.splice(index, 1); return true; },
    async setValue(id, text) {
      if (disposed || !state.sessionId || state.busy) return false;
      const session = state.sessionId, generation = revision, node = state.nodes.find(row => row.id === id);
      state.error = ''; state.busy = 'setServerValue';
      try {
        if (!node || !state.nodeIds[id]) throw new Error('节点不存在');
        const value = parseSimulatorValue(node.dataType, node.arrayType, text);
        await execute({ action: 'setServerValue', connectionId: state.connectionId, sessionId: session, nodeId: state.nodeIds[id], value });
        if (current(generation, session)) state.feedback = '当前值已更新；下次启动初始值保持原配置'; return current(generation, session);
      } catch (error) { if (current(generation, session)) state.error = error.message; return false; }
      finally { if (state.busy === 'setServerValue') state.busy = ''; }
    },
    async importProfiles(text) {
      if (!editable()) return false;
      state.busy = 'importProfiles';
      try {
        if (typeof text !== 'string' || new TextEncoder().encode(text).length > 1048576) throw new Error('导入文件最多 1 MiB');
        const incoming = safeOpcuaServerProfiles(JSON.parse(text));
        const latest = safeOpcuaServerProfiles((await execute({ action: 'serverProfiles' })).profiles ?? []);
        const profiles = safeOpcuaServerProfiles([...new Map([...latest, ...incoming].map(p => [p.id, p])).values()]);
        await execute({ action: 'saveServerProfiles', profiles }); state.profiles = profiles; state.feedback = '模拟服务端配置已导入'; return true;
      } catch (error) { state.error = error.message; return false; }
      finally { state.busy = ''; }
    },
    async exportProfiles() {
      if (disposed || state.busy) return false;
      try {
        const profiles = safeOpcuaServerProfiles((await execute({ action: 'serverProfiles' })).profiles ?? []);
        const result = await execute({ action: 'export', fileName: 'opcua-server-profiles.json', content: JSON.stringify(profiles, null, 2) });
        state.feedback = result.saved ? '模拟服务端配置已导出' : '已取消导出'; return true;
      } catch (error) { state.error = error.message; return false; }
    },
    async dispose() { if (disposed) return; disposed = true; stopEvents?.(); const stopped = await api.disconnect(); await Promise.allSettled([...starts]); if (!stopped) throw new Error(state.error || '模拟服务端停止失败'); },
  };
  return api;
}
