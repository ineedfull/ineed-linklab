const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, X509Certificate } = require('node:crypto');
const { validateNodeId } = require('./opcuaValues.cjs');
const MAX_PROFILE_BYTES = 1024 * 1024;

function endpointUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('请输入有效的 opc.tcp 地址');
  let url; try { url = new URL(value); } catch { throw new Error('请输入有效的 opc.tcp 地址'); }
  if (url.protocol !== 'opc.tcp:' || !url.hostname || url.username || url.password || url.hash || url.search) throw new Error('服务器地址必须为 opc.tcp://主机:端口/路径，不含凭据');
  return value;
}
function normalizeConfig(input = {}, secrets = false) {
  const securityPolicy = input.securityPolicy ?? 'None'; const securityMode = input.securityMode ?? 'None';
  const authentication = input.authentication ?? 'anonymous';
  if (!['None', 'Basic256Sha256'].includes(securityPolicy) || !['None', 'Sign', 'SignAndEncrypt'].includes(securityMode)
    || (securityPolicy === 'None') !== (securityMode === 'None')) throw new Error('安全策略与消息安全模式不匹配');
  if (!['anonymous', 'username'].includes(authentication)) throw new Error('身份认证方式无效');
  const username = typeof input.username === 'string' ? input.username.slice(0, 256) : '';
  const result = { endpointUrl: endpointUrl(input.endpointUrl), securityPolicy, securityMode, authentication, username };
  if (secrets) {
    if (input.password !== undefined && typeof input.password !== 'string') throw new Error('密码格式无效');
    if ((input.password?.length ?? 0) > 4096) throw new Error('密码过长');
    result.password = input.password ?? '';
  }
  return result;
}
function normalizeProfiles(input) {
  if (!Array.isArray(input) || input.length > 50) throw new Error('连接配置最多 50 个');
  const ids = new Set();
  return input.map(profile => {
    if (!profile || typeof profile.id !== 'string' || !/^[\w-]{1,80}$/.test(profile.id) || ids.has(profile.id)) throw new Error('配置 ID 无效或重复');
    ids.add(profile.id);
    if (typeof profile.name !== 'string' || !profile.name.trim() || profile.name.length > 100) throw new Error('配置名称无效');
    const favorites = profile.favorites ?? [];
    if (!Array.isArray(favorites) || favorites.length > 100) throw new Error('收藏节点最多 100 项');
    return { id: profile.id, name: profile.name.trim(), config: normalizeConfig(profile.config), favorites: favorites.map(node => ({ nodeId: validateNodeId(node.nodeId), displayName: String(node.displayName ?? node.nodeId).slice(0, 256) })) };
  });
}
async function readProfiles(directory) {
  try {
    const target = path.join(directory, 'profiles.json');
    if ((await fs.stat(target)).size > MAX_PROFILE_BYTES) throw new Error('连接配置文件过大，最多 1 MiB');
    const data = await fs.readFile(target, 'utf8');
    if (Buffer.byteLength(data) > MAX_PROFILE_BYTES) throw new Error('连接配置文件过大');
    return normalizeProfiles(JSON.parse(data));
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function writeProfiles(directory, input) {
  const profiles = normalizeProfiles(input);
  const serialized = JSON.stringify(profiles, null, 2);
  if (Buffer.byteLength(serialized) > MAX_PROFILE_BYTES) throw new Error('连接配置文件过大，最多 1 MiB');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, 'profiles.json'); const temporary = `${target}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, serialized, { mode: 0o600 }); await fs.rename(temporary, target); }
  finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  return profiles;
}
function certificateInfo(buffer, trusted) {
  const certificate = new X509Certificate(buffer);
  return { fingerprint: certificate.fingerprint256.replaceAll(':', '').toLowerCase(), subject: certificate.subject,
    validFrom: new Date(certificate.validFrom).toISOString(), validTo: new Date(certificate.validTo).toISOString(),
    trusted, derBase64: certificate.raw.toString('base64') };
}
module.exports = { endpointUrl, normalizeConfig, normalizeProfiles, readProfiles, writeProfiles, certificateInfo };
