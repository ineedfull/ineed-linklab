import { createOpcuaSimulator } from './opcuaSimulator.js';
import { OPCUA_SERVER_DEFAULT_CONFIG, opcuaExampleNodes, safeOpcuaServerProfiles } from './opcuaSimulatorConfig.js';
import { createOpcuaWorkbench, safeOpcuaProfiles } from './opcuaWorkbench.js';
import { createStompWorkbench, safeStompProfiles, STOMP_DEFAULT_CONFIG } from './stompWorkbench.js';
import { mutateSettings } from './settingsMutation.js';

const copy = value => JSON.parse(JSON.stringify(value));
const keyFor = (kind, id) => `protocol:${kind}:${id}`;
const kindFor = transport => transport === 'opcua-client' ? 'opcua' : transport === 'opcua-server' ? 'opcua-server' : ['stomp-client', 'stomp-server'].includes(transport) ? 'stomp' : null;
const active = api => Boolean(api.state.sessionId) || ['connecting', 'connected', 'reconnecting', 'listening'].includes(api.state.status);
const kinds = ['opcua', 'opcua-server', 'stomp'];
const normalize = (kind, profiles) => kind === 'opcua' ? safeOpcuaProfiles(profiles) : kind === 'opcua-server' ? safeOpcuaServerProfiles(profiles) : safeStompProfiles(profiles);
const profileExtras = (kind, source) => kind === 'opcua' ? { favorites: copy(source.favorites) } : kind === 'opcua-server' ? { nodes: copy(source.nodes) } : { subscriptions: copy(source.subscriptions) };

/** One profile writer per protocol and one independently owned controller per endpoint. */
export function createProtocolEndpointCatalog(runtime, { reactive = value => value } = {}) {
  const state = reactive({ loading: false, error: '', busy: 0, profiles: { opcua: [], 'opcua-server': [], stomp: [] }, instances: new Map() });
  const queues = new Map(), blocked = new Map();
  let disposed = false;

  // Edits, imports and queued deletions may overlap. Each operation releases
  // only its own hold; completing an edit must not unlock a pending deletion.
  function block(id) { blocked.set(id, (blocked.get(id) ?? 0) + 1); }
  function unblock(id) {
    const remaining = (blocked.get(id) ?? 0) - 1;
    if (remaining > 0) blocked.set(id, remaining); else blocked.delete(id);
  }
  function endpoints() {
    return kinds.flatMap(kind => state.profiles[kind].map(profile => ({
      id: keyFor(kind, profile.id), profileId: profile.id, name: profile.name,
      transport: kind === 'opcua' ? 'opcua-client' : kind === 'opcua-server' ? 'opcua-server' : `stomp-${profile.mode}`,
      config: { ...copy(profile.config), ...profileExtras(kind, profile) },
    })));
  }
  function find(id) {
    const endpoint = endpoints().find(row => row.id === id);
    if (!endpoint) throw new Error('该协议端点不存在或已删除');
    return { endpoint, kind: kindFor(endpoint.transport) };
  }
  function updateProfiles(kind, profiles) {
    state.profiles[kind] = normalize(kind, profiles);
    for (const [id, api] of state.instances) {
      if (id.startsWith(`protocol:${kind}:`)) api.state.profiles = copy(state.profiles[kind]);
    }
  }
  async function readProfiles(kind) {
    if (kind === 'opcua-server') return safeOpcuaServerProfiles((await runtime.opcua.execute({ action: 'serverProfiles' })).profiles ?? []);
    if (kind === 'opcua') return safeOpcuaProfiles((await runtime.opcua.execute({ action: 'profiles' })).profiles);
    return safeStompProfiles((await runtime.settings.getAll()).stompProfiles ?? []);
  }
  function serial(kind, operation) {
    if (disposed) return Promise.reject(new Error('端点目录已关闭'));
    state.busy++;
    const result = (queues.get(kind) ?? Promise.resolve()).catch(() => {}).then(() => {
      if (disposed) throw new Error('端点目录已关闭');
      return kind === 'stomp' ? mutateSettings(runtime, operation) : operation();
    });
    const settled = result.catch(() => {}); queues.set(kind, settled);
    return result.finally(() => { state.busy--; if (queues.get(kind) === settled) queues.delete(kind); });
  }
  async function persist(kind, change) {
    const latest = await readProfiles(kind);
    const profiles = normalize(kind, change(latest));
    if (kind !== 'stomp') await runtime.opcua.execute({ action: kind === 'opcua' ? 'saveProfiles' : 'saveServerProfiles', profiles: copy(profiles) });
    else await runtime.settings.save('stompProfiles', copy(profiles));
    updateProfiles(kind, profiles);
    return profiles;
  }
  async function result(operation) {
    state.error = '';
    try { return { ok: true, value: await operation() }; }
    catch (reason) { const error = reason instanceof Error ? reason : new Error(String(reason)); state.error = error.message; return { ok: false, error }; }
  }
  function profileFromDraft(draft, previous) {
    const kind = kindFor(draft.transport);
    if (!kind) throw new Error('请选择 OPC UA 或 STOMP 端点类型');
    const id = previous?.profileId ?? globalThis.crypto.randomUUID();
    const config = { ...(kind === 'stomp' ? STOMP_DEFAULT_CONFIG : kind === 'opcua-server' ? OPCUA_SERVER_DEFAULT_CONFIG : { endpointUrl: 'opc.tcp://127.0.0.1:4840' }), ...previous?.config, ...draft.config };
    const profile = { id, name: draft.name, config };
    if (kind === 'opcua') profile.favorites = config.favorites ?? [];
    else if (kind === 'opcua-server') profile.nodes = config.nodes ?? opcuaExampleNodes();
    else { profile.mode = draft.transport === 'stomp-server' ? 'server' : 'client'; profile.subscriptions = config.subscriptions ?? []; }
    return { kind, profile: normalize(kind, [profile])[0] };
  }
  function profileFromController(id, api) {
    const { endpoint } = find(id);
    return profileFromDraft({ ...endpoint, name: api.state.name,
      config: { ...api.state.config, ...profileExtras(kindFor(endpoint.transport), api.state) } }, endpoint);
  }
  async function saveCurrent(id, api) {
    if (blocked.has(id) || api.state.busy) return false;
    const kind = find(id).kind;
    if (kind !== 'opcua' && active(api)) { api.state.error = '请先断开再保存连接配置'; return false; }
    if (api.applyInitialValues && !api.applyInitialValues()) return false;
    api.state.busy = 'saveProfiles'; api.state.error = '';
    try {
      const snapshot = profileFromController(id, api).profile;
      await serial(kind, () => persist(kind, rows => {
        if (!rows.some(row => row.id === snapshot.id)) throw new Error('该端点已删除，无法保存');
        return [...rows.filter(row => row.id !== snapshot.id), snapshot];
      }));
      api.state.feedback = kind === 'opcua-server' ? '服务端初始配置已保存' : '端点配置已保存，临时凭据不会保存'; return true;
    } catch (error) { api.state.error = error.message; state.error = error.message; return false; }
    finally { api.state.busy = ''; }
  }
  function get(id) {
    if (disposed) throw new Error('端点目录已关闭');
    if (state.instances.has(id)) return state.instances.get(id);
    const { endpoint, kind } = find(id);
    const controller = kind === 'opcua' ? createOpcuaWorkbench(runtime, { reactive }) : kind === 'opcua-server' ? createOpcuaSimulator(runtime, { reactive }) : createStompWorkbench(runtime, { reactive });
    controller.state.profiles = copy(state.profiles[kind]); controller.selectProfile(endpoint.profileId);
    const bound = {
      ...controller,
      connect: () => disposed || blocked.has(id) ? Promise.resolve(false) : controller.connect(),
      saveProfile: () => saveCurrent(id, bound),
      async importProfiles(text) {
        const response = await result(() => serial(kind, async () => {
          if (typeof text !== 'string' || new TextEncoder().encode(text).length > 1024 * 1024) throw new Error('导入文件最多 1 MiB');
          const incoming = normalize(kind, JSON.parse(text));
          for (const row of incoming) {
            const existing = state.instances.get(keyFor(kind, row.id));
            if (existing && (active(existing) || existing.state.busy)) throw new Error('请先断开并等待端点操作结束再导入');
          }
          const ids = incoming.map(row => keyFor(kind, row.id));
          for (const key of ids) { block(key); const api = state.instances.get(key); if (api) api.state.busy = 'importProfiles'; }
          try {
            await persist(kind, rows => [...new Map([...rows, ...incoming].map(row => [row.id, row])).values()]);
            for (const row of incoming) { const api = state.instances.get(keyFor(kind, row.id)); if (api) { api.state.busy = ''; api.selectProfile(row.id); } }
          } finally {
            for (const key of ids) { unblock(key); const api = state.instances.get(key); if (api?.state.busy === 'importProfiles') api.state.busy = ''; }
          }
        }));
        if (!response.ok) bound.state.error = response.error.message;
        else bound.state.feedback = '配置已导入端点列表，临时凭据需重新填写';
        return response.ok;
      },
      async exportProfiles() {
        try {
          const profiles = await readProfiles(kind);
          const response = await runtime.opcua.execute({ action: 'export', fileName: `${kind}-profiles.json`, content: JSON.stringify(profiles, null, 2) });
          bound.state.feedback = response.saved ? '连接配置已导出' : '已取消导出'; return true;
        } catch (error) { bound.state.error = error.message; return false; }
      },
      deleteProfile: () => catalog.remove(id),
    };
    state.instances.set(id, bound);
    return state.instances.get(id);
  }
  const catalog = {
    state,
    get endpoints() { return endpoints(); },
    has: id => endpoints().some(row => row.id === id),
    get,
    async initialize() {
      if (disposed || state.loading) return;
      state.loading = true; state.error = '';
      try {
        // Loading participates in the same source queue as writes. A late
        // startup snapshot must not replace profiles successfully saved meanwhile.
        const loaded = await Promise.allSettled(kinds.map(kind => serial(kind, async () => {
          const profiles = await readProfiles(kind); updateProfiles(kind, profiles);
        })));
        const errors = [];
        for (const [index, kind] of kinds.entries()) {
          const outcome = loaded[index];
          if (outcome.status === 'rejected') errors.push(`${kind}: ${outcome.reason.message}`);
        }
        state.error = errors.join('；');
      } finally { state.loading = false; }
    },
    saveEndpoint(draft) {
      return result(async () => {
        const previous = catalog.has(draft.id) ? find(draft.id).endpoint : null;
        if (previous && previous.transport !== draft.transport) throw new Error('编辑端点不能改变协议角色');
        const { kind, profile } = profileFromDraft(draft, previous);
        return serial(kind, async () => {
          if (previous && !catalog.has(previous.id)) throw new Error('该端点已删除，无法保存');
          const api = previous ? state.instances.get(previous.id) : null;
          const sameConfig = previous && JSON.stringify({ ...previous.config }) === JSON.stringify({ ...profile.config, ...profileExtras(kind, profile) });
          if (api && active(api) && !sameConfig) throw new Error('请先断开再修改连接参数');
          if (api?.state.busy || previous && blocked.has(previous.id)) throw new Error('该端点正在处理操作，请稍后重试');
          if (previous) block(previous.id);
          if (api) api.state.busy = 'saveProfiles';
          try {
            await persist(kind, rows => {
              if (previous && !rows.some(row => row.id === profile.id)) throw new Error('该端点已删除，无法保存');
              return [...rows.filter(row => row.id !== profile.id), profile];
            });
            const id = keyFor(kind, profile.id);
            // A first visit may lazily create this controller while persistence
            // is pending. Keep it blocked and hydrate that current instance too.
            const current = state.instances.get(id);
            if (current) { current.state.busy = ''; if (sameConfig) current.state.name = profile.name; else current.selectProfile(profile.id); }
            return endpoints().find(row => row.id === id);
          } finally {
            if (previous) unblock(previous.id);
            if (api?.state.busy === 'saveProfiles') api.state.busy = '';
          }
        });
      });
    },
    remove(id) {
      return result(async () => {
        const { kind, endpoint } = find(id); block(id);
        try {
          return await serial(kind, async () => {
            const api = state.instances.get(id); if (api) {
              const stopped = await api.disconnect();
              if (stopped === false) throw new Error(api.state.error || '端点停止失败，请重试后再删除');
              api.state.busy = 'deleteProfile';
            }
            try {
              await persist(kind, rows => rows.filter(row => row.id !== endpoint.profileId));
              const current = state.instances.get(id);
              if (current) await current.dispose(); state.instances.delete(id); return { id };
            } finally { if (api?.state.busy === 'deleteProfile') api.state.busy = ''; }
          });
        } finally { unblock(id); }
      });
    },
    async connect(id) { if (blocked.has(id)) return false; const api = get(id); if (active(api) || api.state.busy) return false; return api.connect(); },
    async disconnect(id) { const api = state.instances.get(id); if (api) return api.disconnect(); },
    async dispose() {
      if (disposed) return; disposed = true;
      await Promise.allSettled([...queues.values()]);
      const outcomes = await Promise.allSettled([...state.instances.values()].map(api => api.dispose())); state.instances.clear();
      const failure = outcomes.find(row => row.status === 'rejected'); if (failure) throw failure.reason;
    },
  };
  return catalog;
}
