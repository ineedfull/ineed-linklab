import { parseOpcuaInput } from './opcuaWorkbench.js';

export const OPCUA_SERVER_DEFAULT_CONFIG = Object.freeze({ listenHost: '127.0.0.1', listenPort: 4840, path: '/LinkLab', namespaceUri: 'urn:ineedfull:linklab:simulator' });
export const OPCUA_SERVER_TYPES = Object.freeze(['Boolean', 'Int16', 'UInt16', 'Int32', 'UInt32', 'Int64', 'UInt64', 'Float', 'Double', 'String', 'ByteString', 'DateTime']);
const defaults = Object.freeze({ mode: 'manual', intervalMs: 1000, min: 0, max: 100, step: 1 });
const incremental = ['Int16', 'UInt16', 'Int32', 'UInt32', 'Float', 'Double'];
const copy = value => JSON.parse(JSON.stringify(value));
const size = value => new TextEncoder().encode(JSON.stringify(value, null, 2)).byteLength;
const fail = message => { throw new Error(message); };

export function safeOpcuaServerConfig(source) {
  if (!source || typeof source !== 'object') fail('服务端配置无效');
  const config = Object.fromEntries(Object.keys(OPCUA_SERVER_DEFAULT_CONFIG).map(key => [key, source[key] ?? OPCUA_SERVER_DEFAULT_CONFIG[key]]));
  if (!['127.0.0.1', '0.0.0.0'].includes(config.listenHost)) fail('监听地址仅支持 127.0.0.1 或 0.0.0.0');
  if (!Number.isInteger(config.listenPort) || config.listenPort < 1 || config.listenPort > 65535) fail('监听端口必须为 1 到 65535 的整数');
  if (typeof config.path !== 'string' || !/^\/[A-Za-z0-9/_-]{0,127}$/.test(config.path)) fail('路径必须以 / 开头，最多 128 个字母、数字、/、_ 或 -');
  if (typeof config.namespaceUri !== 'string' || config.namespaceUri.length > 256 || [...config.namespaceUri].some(char => /\s/.test(char) || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) fail('命名空间 URI 无效');
  let uri; try { uri = new URL(config.namespaceUri); } catch { fail('命名空间必须为 urn 或 http(s) URI'); }
  if (!['urn:', 'http:', 'https:'].includes(uri.protocol) || uri.protocol === 'urn:' && !uri.pathname || ['http:', 'https:'].includes(uri.protocol) && !uri.hostname) fail('命名空间必须为非空 urn 或 http(s) URI');
  if (['http://opcfoundation.org/UA/', 'urn:ineedfull:linklab:simulator:server', 'urn:ineedfull:linklab:opcua:simulator'].includes(config.namespaceUri)) fail('此命名空间 URI 为内置服务保留，请使用独立 URI');
  return config;
}

function validScalar(type, value) {
  // Reuse the client codec for integer precision/ranges; add simulator bounds.
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (typeof text !== 'string') fail('节点值无效');
  if (['String', 'ByteString', 'DateTime', 'Int64', 'UInt64'].includes(type) && typeof value !== 'string') fail(`${type} 必须使用字符串`);
  const parsed = parseOpcuaInput(type, 'Scalar', text);
  if (typeof parsed !== typeof value || parsed !== value) fail(`${type} 节点值类型无效`);
  if (typeof value === 'string' && value.length > 4096) fail('每个字符串最多 4096 个字符');
  if (type === 'ByteString' && (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) || btoa(atob(value)) !== value)) fail('ByteString 必须为 base64');
  if (type === 'DateTime') {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)) || Date.parse(value) < Date.UTC(1601, 0, 1)) fail('DateTime 必须为不早于 1601 年且带时区的 ISO 时间');
    const day = value.slice(0, 10); if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) fail('DateTime 日期无效');
  }
  return value;
}
export function validateSimulatorValue(type, arrayType, value) {
  if (!OPCUA_SERVER_TYPES.includes(type) || !['Scalar', 'Array'].includes(arrayType)) fail('请选择支持的节点类型与结构');
  if (arrayType === 'Array') {
    if (!Array.isArray(value) || value.length > 100) fail('节点数组最多 100 项');
    return value.map(item => validScalar(type, item));
  }
  return validScalar(type, value);
}
export function parseSimulatorValue(type, arrayType, text) {
  return validateSimulatorValue(type, arrayType, parseOpcuaInput(type, arrayType, text));
}
export function safeOpcuaServerNodes(input) {
  if (!Array.isArray(input) || !input.length || input.length > 100) fail('模拟节点必须为数组，数量为 1 到 100');
  if (size(input) > 256 * 1024) fail('节点配置最多 256 KiB');
  const ids = new Set();
  return input.map(node => {
    if (!node || typeof node.id !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(node.id) || ids.has(node.id)) fail('节点 ID 无效或重复');
    if (typeof node.name !== 'string' || !node.name.trim() || node.name.length > 100 || typeof node.writable !== 'boolean') fail('节点名称或读写属性无效');
    ids.add(node.id);
    const value = validateSimulatorValue(node.dataType, node.arrayType, node.value);
    if (node.simulation !== undefined && (!node.simulation || typeof node.simulation !== 'object' || Array.isArray(node.simulation))) fail('节点变化配置必须为对象');
    const simulation = { ...defaults, ...Object.fromEntries(Object.keys(defaults).filter(key => node.simulation?.[key] !== undefined).map(key => [key, node.simulation[key]])) };
    if (!['manual', 'toggle', 'increment'].includes(simulation.mode)) fail('节点变化方式无效');
    if (!Number.isInteger(simulation.intervalMs) || simulation.intervalMs < 100 || simulation.intervalMs > 60000) fail('变化间隔必须为 100 到 60000 毫秒的整数');
    if (simulation.mode !== 'manual' && node.arrayType !== 'Scalar') fail('数组仅支持手动更新');
    if (simulation.mode === 'toggle' && node.dataType !== 'Boolean') fail('翻转仅支持 Boolean 标量');
    if (simulation.mode === 'increment') {
      if (!incremental.includes(node.dataType)) fail('此类型仅支持手动更新');
      for (const key of ['min', 'max', 'step']) validScalar(node.dataType, simulation[key]);
      if (simulation.min > simulation.max || simulation.step <= 0) fail('增量范围必须 min ≤ max 且 step > 0');
    } else if (![simulation.min, simulation.max, simulation.step].every(value => typeof value === 'number' && Number.isFinite(value))) fail('节点变化数值必须有限');
    return { id: node.id, name: node.name.trim(), dataType: node.dataType, arrayType: node.arrayType, value: copy(value), writable: node.writable, simulation };
  });
}
export function safeOpcuaServerProfiles(input) {
  if (!Array.isArray(input) || input.length > 50) fail('模拟服务端配置最多 50 个');
  const ids = new Set();
  const profiles = input.map(p => {
    if (!p || typeof p.id !== 'string' || !/^[\w-]{1,80}$/.test(p.id) || ids.has(p.id) || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 100) fail('服务端配置 ID 或名称无效/重复');
    ids.add(p.id);
    return { id: p.id, name: p.name.trim(), config: safeOpcuaServerConfig(p.config), nodes: safeOpcuaServerNodes(p.nodes) };
  });
  if (size(profiles) > 1024 * 1024) fail('服务端配置文件最多 1 MiB');
  return profiles;
}
export function opcuaExampleNodes() {
  return [
    { id: 'Temperature', name: '温度', dataType: 'Double', arrayType: 'Scalar', value: 23.5, writable: true, simulation: { ...defaults } },
    { id: 'Running', name: '运行状态', dataType: 'Boolean', arrayType: 'Scalar', value: true, writable: false, simulation: { ...defaults, mode: 'toggle' } },
    { id: 'Counter', name: '计数器', dataType: 'UInt32', arrayType: 'Scalar', value: 0, writable: true, simulation: { ...defaults, mode: 'increment' } },
    { id: 'DeviceName', name: '设备名称', dataType: 'String', arrayType: 'Scalar', value: 'LinkLab Simulator', writable: true, simulation: { ...defaults } },
  ];
}
