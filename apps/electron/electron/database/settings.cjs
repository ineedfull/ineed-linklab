// Persisted settings schema and protocol-specific settings validation.
const { cloneSerializable, assertJsonValue, isPlainObject } = require('./validation.cjs');
const { readFileSync } = require('node:fs');
const { contractAssetPath } = require('../contractAssets.cjs');

const SETTINGS_SCHEMA = JSON.parse(readFileSync(contractAssetPath(
  'runtime-contract', 'src', 'settingsSchema.json',
), 'utf8'));

const SETTINGS_RULES = SETTINGS_SCHEMA.settings;

const RETIRED_IMPORT_SETTING_KEYS = new Set(['timeDisplayMode']);

const DEFAULT_SETTINGS = Object.freeze(Object.fromEntries(
  Object.entries(SETTINGS_RULES).map(([key, rule]) => [key, rule.default]),
));

function normalizeImportedSettings(values) {
  if (!isPlainObject(values)) throw new TypeError('settings must be an object');
  const currentValues = Object.create(null);
  for (const [key, value] of Object.entries(values)) {
    if (!RETIRED_IMPORT_SETTING_KEYS.has(key)) currentValues[key] = value;
  }
  return normalizeSettings(currentValues);
}

function normalizeSettings(values) {
  if (!isPlainObject(values)) throw new TypeError('settings must be an object');
  const normalized = cloneSerializable(DEFAULT_SETTINGS);
  for (const [key, value] of Object.entries(values)) {
    validateSetting(key, value);
    normalized[key] = value;
  }
  return normalized;
}

function validateSetting(key, value) {
  const rule = SETTINGS_RULES[key];
  if (!rule) throw new TypeError(`unknown setting: ${key}`);
  assertJsonValue(value);
  if (rule.type === 'stomp-profiles') validateStompProfiles(value);
  if (rule.type === 'acceptance-document') validateAcceptanceDocument(value);
  if (rule.type === 'integer' && (
    !Number.isSafeInteger(value) || value < rule.minimum || value > rule.maximum
  )) throw new TypeError(`${key} must be an integer from ${rule.minimum} to ${rule.maximum}`);
  if (rule.type === 'boolean' && typeof value !== 'boolean') {
    throw new TypeError(`${key} must be boolean`);
  }
  if (rule.type === 'string' && typeof value !== 'string') {
    throw new TypeError(`${key} must be a string`);
  }
  if (rule.enum && !rule.enum.includes(value)) throw new TypeError(`${key} is invalid`);
}

function validateAcceptanceDocument(value) {
  const invalid = () => { throw new TypeError('acceptanceWorkspace must be a bounded version 1 JSON document'); };
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 2 * 1024 * 1024) invalid();
  let doc;
  try { doc = JSON.parse(value); } catch { invalid(); }
  if (!isPlainObject(doc) || Object.keys(doc).length !== (Object.hasOwn(doc, 'templates') ? 4 : 3) || doc.version !== 1
    || (Object.hasOwn(doc, 'templates') && (!Array.isArray(doc.templates) || doc.templates.length > 50))
    || !Array.isArray(doc.plans) || doc.plans.length > 50
    || !Array.isArray(doc.reports) || doc.reports.length > 20) invalid();
}

function validateStompProfiles(profiles) {
  const invalid = () => { throw new TypeError('stompProfiles must contain bounded safe STOMP profiles'); };
  const object = (value, keys) => {
    if (!isPlainObject(value) || Object.keys(value).length !== keys.length
      || keys.some(key => !Object.hasOwn(value, key))) invalid();
  };
  const text = (value, maximum) => typeof value === 'string' && value.length > 0
    && value.length <= maximum && !/[\0\r\n]/.test(value);
  if (!Array.isArray(profiles) || profiles.length > 50) invalid();
  const ids = new Set();
  for (const profile of profiles) {
    object(profile, ['id', 'name', 'mode', 'config', 'subscriptions']);
    if (typeof profile.id !== 'string' || !/^[\w-]{1,80}$/.test(profile.id) || ids.has(profile.id)
      || typeof profile.name !== 'string' || !profile.name.trim() || profile.name.length > 100
      || !['client', 'server'].includes(profile.mode)) invalid();
    ids.add(profile.id);
    const c = profile.config;
    object(c, ['url', 'host', 'autoReconnect', 'heartbeatOutgoing', 'heartbeatIncoming', 'listenHost', 'listenPort', 'path']);
    if (!text(c.url, 4096) || !text(c.host, 255) || !text(c.listenHost, 255)
      || !text(c.path, 1024) || !c.path.startsWith('/') || /[?#]/.test(c.path)
      || typeof c.autoReconnect !== 'boolean' || !Number.isInteger(c.listenPort) || c.listenPort < 1 || c.listenPort > 65535
      || ['heartbeatOutgoing', 'heartbeatIncoming'].some(key => !Number.isInteger(c[key]) || c[key] !== 0 && (c[key] < 1000 || c[key] > 60000))) invalid();
    let url; try { url = new URL(c.url); } catch { invalid(); }
    if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.username || url.password || /[?#]/.test(c.url)) invalid();
    if (!Array.isArray(profile.subscriptions) || profile.subscriptions.length > 100) invalid();
    const subscriptions = new Set();
    for (const subscription of profile.subscriptions) {
      object(subscription, ['id', 'destination', 'ack']);
      if (!text(subscription.id, 128) || subscriptions.has(subscription.id) || !text(subscription.destination, 1024)
        || !['auto', 'client', 'client-individual'].includes(subscription.ack)) invalid();
      subscriptions.add(subscription.id);
    }
  }
}

module.exports = {
  SETTINGS_RULES,
  DEFAULT_SETTINGS,
  normalizeImportedSettings,
  normalizeSettings,
  validateSetting,
};
