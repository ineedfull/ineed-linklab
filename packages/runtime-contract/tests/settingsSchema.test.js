import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('shared settings schema defines exact keys, defaults, types, enums, and ranges', async () => {
  const schema = JSON.parse(await readFile(path.join(root, 'src', 'settingsSchema.json'), 'utf8'));
  assert.equal(schema.schemaVersion, 1);
  assert.deepEqual(Object.keys(schema.settings), [
    'logLevel', 'realtimeFrameLimit', 'realtimeLogLimit', 'previewByteLimit',
    'defaultFraming', 'autoScroll', 'theme', 'largeFont', 'modbusPointHistoryRetention', 'stompProfiles', 'acceptanceWorkspace',
  ]);
  assert.deepEqual(Object.fromEntries(
    Object.entries(schema.settings).map(([key, rule]) => [key, rule.default]),
  ), {
    logLevel: 'info', realtimeFrameLimit: 2000, realtimeLogLimit: 1000,
    previewByteLimit: 4096, defaultFraming: 'none',
    autoScroll: true, theme: 'system', largeFont: false,
    modbusPointHistoryRetention: '30-days', stompProfiles: [], acceptanceWorkspace: '{"version":1,"plans":[],"reports":[]}',
  });
  assert.deepEqual(schema.settings.acceptanceWorkspace, { type: 'acceptance-document', maximumBytes: 2097152, default: '{"version":1,"plans":[],"reports":[]}' });
  assert.deepEqual(schema.settings.stompProfiles, { type: 'stomp-profiles', maxItems: 50, maxSubscriptions: 100, default: [] });
  assert.deepEqual(schema.settings.logLevel.enum, ['debug', 'info', 'warn', 'error']);
  assert.deepEqual(schema.settings.defaultFraming.enum, ['none', 'line', 'length-prefix']);
  assert.deepEqual(schema.settings.theme.enum, ['system', 'light', 'dark']);
  assert.deepEqual(
    schema.settings.modbusPointHistoryRetention.enum,
    ['7-days', '30-days', '90-days', 'forever'],
  );
  for (const key of ['realtimeFrameLimit', 'realtimeLogLimit', 'previewByteLimit']) {
    assert.equal(schema.settings[key].type, 'integer');
    assert.equal(schema.settings[key].minimum, 1);
    assert.equal(Number.isSafeInteger(schema.settings[key].maximum), true);
  }
});
