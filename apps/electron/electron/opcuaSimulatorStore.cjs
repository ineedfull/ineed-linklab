const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validateWriteValue } = require('./opcuaValues.cjs');
const TYPES = new Set(['Boolean', 'Int16', 'UInt16', 'Int32', 'UInt32', 'Int64', 'UInt64', 'Float', 'Double', 'String', 'ByteString', 'DateTime']);
const INCREMENT_TYPES = new Set(['Int16', 'UInt16', 'Int32', 'UInt32', 'Float', 'Double']);
const MAX_BYTES = 1024 * 1024;
function object(input, label) { if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${label}必须为对象`); return input; }
function identifier(id, label = 'ID') { if (typeof id !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(id)) throw new Error(`${label}无效`); return id; }
function connectionId(id) { if (typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id)) throw new Error('连接 ID 无效'); return id; }
function name(value) { if (typeof value !== 'string' || !value.trim() || value.length > 100) throw new Error('名称必须为 1..100 字符'); return value.trim(); }
function size(input, max, message) { let json; try { json = JSON.stringify(input, null, 2); } catch { throw new Error(message); } if (!json || Buffer.byteLength(json) > max) throw new Error(message); }
function normalizeConfig(input = {}) {
  object(input, '监听配置');
  const { listenHost = '127.0.0.1', listenPort = 4840, path: resourcePath = '/LinkLab', namespaceUri = 'urn:ineedfull:linklab:simulator' } = input;
  if (!['127.0.0.1', '0.0.0.0'].includes(listenHost)) throw new Error('监听地址只能为 127.0.0.1 或 0.0.0.0');
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) throw new Error('监听端口必须为 1..65535 整数');
  if (typeof resourcePath !== 'string' || !/^\/[A-Za-z0-9/_-]{0,127}$/.test(resourcePath)) throw new Error('监听路径无效，最多 128 字符');
  if (typeof namespaceUri !== 'string' || !namespaceUri || namespaceUri.length > 256 || /\s/.test(namespaceUri) || [...namespaceUri].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw new Error('namespaceUri 无效');
  let uri; try { uri = new URL(namespaceUri); } catch { throw new Error('namespaceUri 必须为 urn 或 http(s) URI'); }
  if (!['urn:', 'http:', 'https:'].includes(uri.protocol) || (uri.protocol === 'urn:' && !uri.pathname)) throw new Error('namespaceUri 必须为 urn 或 http(s) URI');
  if (['http://opcfoundation.org/UA/', 'urn:ineedfull:linklab:simulator:server', 'urn:ineedfull:linklab:opcua:simulator'].includes(uri.href)) throw new Error('namespaceUri 不能使用 OPC UA 标准或服务端应用保留命名空间');
  return { listenHost, listenPort, path: resourcePath, namespaceUri };
}
function validateValue(dataType, arrayType, value) {
  if (!TYPES.has(dataType)) throw new Error('服务端节点数据类型无效');
  if (arrayType === 'Array' && (!Array.isArray(value) || value.length > 100)) throw new Error('节点数组最多 100 项');
  validateWriteValue(dataType, arrayType, value);
  for (const item of arrayType === 'Array' ? value : [value]) if (typeof item === 'string' && item.length > 4096) throw new Error('节点字符串最多 4096 字符');
  return value;
}
function normalizeSimulation(input = {}, dataType, arrayType) {
  object(input, '自动变化配置');
  const { mode = 'manual', intervalMs = 1000, min = 0, max = 100, step = 1 } = input;
  if (!['manual', 'toggle', 'increment'].includes(mode)) throw new Error('自动变化模式无效');
  if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 60000) throw new Error('自动变化间隔必须为 100..60000ms 整数');
  if (arrayType === 'Array' && mode !== 'manual') throw new Error('数组只支持手动更新');
  if (mode === 'toggle' && dataType !== 'Boolean') throw new Error('toggle 只支持 Boolean');
  if (mode === 'increment') {
    if (!INCREMENT_TYPES.has(dataType)) throw new Error('此类型不支持 increment');
    validateValue(dataType, 'Scalar', min); validateValue(dataType, 'Scalar', max); validateValue(dataType, 'Scalar', step);
    if (min > max || step <= 0) throw new Error('自动变化范围必须 min <= max，step > 0');
  } else if (![min, max, step].every(v => typeof v === 'number' && Number.isFinite(v))) throw new Error('自动变化数值必须有限');
  return { mode, intervalMs, min, max, step };
}
function normalizeNodes(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 100) throw new Error('需要 1..100 个服务端节点');
  size(input, 256 * 1024, '节点 JSON 整体最多 256 KiB');
  const ids = new Set();
  return input.map(raw => {
    object(raw, '节点'); const id = identifier(raw.id, '节点 ID');
    if (ids.has(id)) throw new Error('节点 ID 重复'); ids.add(id);
    const dataType = raw.dataType; const arrayType = raw.arrayType;
    validateValue(dataType, arrayType, raw.value);
    if (typeof raw.writable !== 'boolean') throw new Error('节点 writable 必须为 Boolean');
    return { id, name: name(raw.name), dataType, arrayType, value: structuredClone(raw.value), writable: raw.writable, simulation: normalizeSimulation(raw.simulation, dataType, arrayType) };
  });
}
function normalizeProfiles(input) {
  if (!Array.isArray(input) || input.length > 50) throw new Error('服务端配置最多 50 个');
  size(input, MAX_BYTES, '服务端配置整体最多 1 MiB'); const ids = new Set();
  return input.map(raw => {
    object(raw, '服务端配置'); const id = connectionId(raw.id);
    if (ids.has(id)) throw new Error('配置 ID 重复'); ids.add(id);
    return { id, name: name(raw.name), config: normalizeConfig(raw.config), nodes: normalizeNodes(raw.nodes) };
  });
}
async function readProfiles(directory) {
  const target = path.join(directory, 'server-profiles.json');
  try {
    if ((await fs.stat(target)).size > MAX_BYTES) throw new Error('服务端配置整体最多 1 MiB');
    const data = await fs.readFile(target, 'utf8');
    if (Buffer.byteLength(data) > MAX_BYTES) throw new Error('服务端配置整体最多 1 MiB');
    return normalizeProfiles(JSON.parse(data));
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function writeProfiles(directory, input) {
  const profiles = normalizeProfiles(input); const serialized = JSON.stringify(profiles, null, 2);
  size(profiles, MAX_BYTES, '服务端配置整体最多 1 MiB');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, 'server-profiles.json'); const temporary = `${target}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, serialized, { mode: 0o600 }); await fs.rename(temporary, target); }
  finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  return profiles;
}
module.exports = { normalizeConfig, normalizeNodes, validateValue, connectionId, readProfiles, writeProfiles };
