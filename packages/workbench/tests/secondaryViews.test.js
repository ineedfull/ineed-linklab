import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SETTINGS,
  createHistoryPayloadCache,
  createHistoryController,
  createStorageController,
  decodeBase64Bytes,
  formatByteSize,
  formatFramingLabel,
  formatHistoryPayload,
  formatTimestamp,
  normalizeSettings,
  parseHistoryLocation,
  validateWorkspaceDocument,
} from '../src/model/secondaryViews.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const endpointIdCases = JSON.parse(readFileSync(path.join(
  packageRoot, '..', 'runtime-contract', 'tests', 'historyEndpointIdCases.json',
), 'utf8'));

test('history location accepts only frames or logs and an optional safe endpoint ID', () => {
  assert.deepEqual(parseHistoryLocation('?view=history&kind=frames'), {
    kind: 'frames', endpointId: null,
  });
  assert.deepEqual(parseHistoryLocation('?view=history&kind=logs&endpointId=endpoint-01_TCP'), {
    kind: 'logs', endpointId: 'endpoint-01_TCP',
  });
  for (const search of [
    '?view=history&kind=other',
    '?view=history&kind=frames&endpointId=../settings',
    '?view=history&kind=logs&endpointId=x%2Fy',
  ]) {
    assert.throws(() => parseHistoryLocation(search), /history|endpoint/i);
  }
});

test('history location round-trips encoded endpoint punctuation and Unicode', () => {
  for (const endpointId of [
    'all', 'a.b', 'a_b', 'a:b', 'Unicode-中文', 'space value',
    'a&b', 'a?b', 'a#b', 'a%b',
  ]) {
    assert.deepEqual(
      parseHistoryLocation(`?view=history&kind=frames&endpointId=${encodeURIComponent(endpointId)}`),
      { kind: 'frames', endpointId },
    );
  }
});

test('shared history endpoint validation matches the cross-runtime cases', () => {
  for (const endpointId of endpointIdCases.accepted) {
    assert.equal(
      parseHistoryLocation(`?view=history&kind=logs&endpointId=${encodeURIComponent(endpointId)}`).endpointId,
      endpointId,
    );
  }
  for (const endpointId of endpointIdCases.rejected) {
    assert.throws(
      () => parseHistoryLocation(`?view=history&kind=logs&endpointId=${encodeURIComponent(endpointId)}`),
      /endpoint/i,
    );
  }
});

test('history filters remain draft state until explicit search', async () => {
  const calls = [];
  const runtime = {
    history: {
      queryFrames: async (query) => {
        calls.push(query);
        return { rows: [{ id: 1 }], total: 1, page: query.page, pageSize: query.pageSize };
      },
      queryLogs: async () => { throw new Error('wrong history kind'); },
    },
  };
  const controller = createHistoryController(runtime, { kind: 'frames', endpointId: 'ep-1' });

  controller.setDraft({ search: 'hello', direction: 'in' });
  controller.setDraft({ from: 1000, to: 2000 });
  assert.equal(calls.length, 0);

  await controller.search();
  assert.deepEqual(calls, [{
    endpointId: 'ep-1', search: 'hello', direction: 'in',
    level: '', source: '', from: 1000, to: 2000, page: 1, pageSize: 50,
  }]);
  assert.equal(controller.state.total, 1);
});

test('pager navigation and page-size changes explicitly query committed filters', async () => {
  const calls = [];
  const runtime = {
    history: {
      queryFrames: async (query) => {
        calls.push({ ...query });
        return { rows: [], total: 125, page: query.page, pageSize: query.pageSize };
      },
      queryLogs: async () => ({ rows: [], total: 0, page: 1, pageSize: 50 }),
    },
  };
  const controller = createHistoryController(runtime, { kind: 'frames' });
  controller.setDraft({ search: 'committed' });
  await controller.search();
  controller.setDraft({ search: 'not committed' });
  await controller.goToPage(2);
  await controller.setPageSize(100);

  assert.deepEqual(calls.map(({ search, page, pageSize }) => ({ search, page, pageSize })), [
    { search: 'committed', page: 1, pageSize: 50 },
    { search: 'committed', page: 2, pageSize: 50 },
    { search: 'committed', page: 1, pageSize: 100 },
  ]);
  assert.equal(controller.state.totalPages, 2);
});

test('history initial load runs once and stale completions cannot overwrite newer requests', async () => {
  const requests = [];
  const publications = [];
  const runtime = {
    history: {
      queryFrames(query) {
        const request = deferred();
        requests.push({ query, request });
        return request.promise;
      },
      queryLogs: async () => { throw new Error('wrong kind'); },
    },
  };
  const controller = createHistoryController(runtime, { kind: 'frames', endpointId: 'ep-1' });
  controller.subscribe(() => publications.push({ ...controller.state }));
  const initial = controller.load();
  assert.equal(controller.state.loading, true);
  assert.equal(requests.length, 1);
  assert.equal(controller.load(), initial);
  controller.setDraft({ search: 'new' });
  const latest = controller.search();
  requests[1].request.resolve({ rows: [{ id: 2 }], total: 1, page: 1, pageSize: 50 });
  await latest;
  requests[0].request.resolve({ rows: [{ id: 1 }], total: 1, page: 1, pageSize: 50 });
  await initial;
  assert.deepEqual(controller.state.rows, [{ id: 2 }]);
  assert.equal(controller.state.loading, false);
  assert.equal(publications[0].loading, true);
});

test('history dispose invalidates pending completion and zero results have zero pages', async () => {
  const request = deferred();
  const controller = createHistoryController({
    history: { queryFrames: () => request.promise, queryLogs: () => request.promise },
  }, { kind: 'frames' });
  const pending = controller.search();
  controller.dispose();
  request.resolve({ rows: [], total: 0, page: 1, pageSize: 50 });
  await pending;
  assert.equal(controller.state.loading, false);

  const empty = createHistoryController({
    history: {
      queryFrames: async () => ({ rows: [], total: 0, page: 1, pageSize: 50 }),
      queryLogs: async () => ({ rows: [], total: 0, page: 1, pageSize: 50 }),
    },
  }, { kind: 'frames' });
  await empty.search();
  assert.equal(empty.state.totalPages, 0);
});

test('timestamps use one local millisecond format and invalid values are explicit', () => {
  const timestamp = new Date(2024, 6, 3, 17, 46, 40, 123).getTime();
  assert.equal(formatTimestamp(timestamp), '2024-07-03 17:46:40.123');
  assert.equal(formatTimestamp(Number.NaN), '--');
  assert.equal(formatTimestamp('1720000000123'), '--');
  assert.equal(formatTimestamp(new Date(timestamp).toISOString()), '2024-07-03 17:46:40.123');
  assert.equal(formatTimestamp('2024-07-03T09:46:40.123+00:00'), formatTimestamp(Date.UTC(2024, 6, 3, 9, 46, 40, 123)));
  assert.equal(formatTimestamp('2024-07-03T17:46:40.123+08:00'), formatTimestamp(Date.UTC(2024, 6, 3, 9, 46, 40, 123)));
  assert.equal(formatTimestamp(0), formatTimestamp('1970-01-01T00:00:00Z'));
  assert.equal(formatTimestamp(new Date(2024, 11, 31, 23, 59, 59, 9).getTime()), '2024-12-31 23:59:59.009');
  for (const value of [null, undefined, '', 'bad', '2024-07-03', '2024-07-03T17:46:40', '2024-02-30T00:00:00Z', '2024-07-03T24:00:00Z', Infinity, -1, 0.5, 8.64e15 + 1]) {
    assert.equal(formatTimestamp(value), '--', String(value));
  }
});

test('disk byte sizes use binary units', () => {
  assert.equal(formatByteSize(0), '0 KB');
  assert.equal(formatByteSize(1536), '1.5 KB');
  assert.equal(formatByteSize(2 * 1024 * 1024), '2 MB');
  assert.equal(formatByteSize(3 * 1024 * 1024 * 1024), '3 GB');
});

test('history payload formatting preserves binary HEX bytes and decodes text and JSON as UTF-8', () => {
  assert.equal(formatHistoryPayload({ format: 'hex', payloadBase64: 'AID/' }), '00 80 FF');
  assert.equal(formatHistoryPayload({ format: 'text', payloadBase64: '5L2g5aW9' }), '你好');
  assert.equal(formatHistoryPayload({ format: 'json', payloadBase64: 'eyJiIjoyLCJhIjoxfQ==' }), '{\n  "b": 2,\n  "a": 1\n}');
  assert.equal(formatHistoryPayload({ format: 'json', payloadBase64: 'eyJhIjo=' }), '{"a":');
  assert.equal(formatHistoryPayload({ format: 'hex', payloadBase64: 'AID/' }, { byteLimit: 2 }), '00 80 ...（已截断）');
  assert.equal(formatHistoryPayload({ format: 'text', payloadBase64: '5L2g5aW9' }, { byteLimit: 4 }), '你 ...（已截断）');
});

test('history payload Base64 decoding accepts canonical input only', () => {
  assert.deepEqual([...decodeBase64Bytes('TQ==')], [0x4d]);
  for (const payloadBase64 of ['TQ', 'A A', 'TQ=', 'TQ===', 'TR==', 'TWF=', 'not base64']) {
    assert.throws(() => decodeBase64Bytes(payloadBase64));
    assert.equal(formatHistoryPayload({ format: 'text', payloadBase64 }), payloadBase64);
  }
});

test('history previews decode only the Base64 quanta needed for their byte limit', () => {
  const payloadBase64 = btoa('A'.repeat(30_000));
  const nativeAtob = globalThis.atob;
  const calls = [];
  globalThis.atob = (value) => {
    calls.push(value.length);
    return nativeAtob(value);
  };
  try {
    assert.equal(formatHistoryPayload({ format: 'text', payloadBase64 }, { byteLimit: 8 }), 'AAAAAAAA ...（已截断）');
    assert.equal(calls.at(-1), 12);
    assert.equal(formatHistoryPayload({ format: 'text', payloadBase64 }), 'A'.repeat(30_000));
    assert.equal(calls.at(-1), payloadBase64.length);
  } finally {
    globalThis.atob = nativeAtob;
  }
});

test('history payload text decoding rejects invalid UTF-8 without replacement characters', () => {
  for (const format of ['text', 'json']) {
    assert.equal(formatHistoryPayload({ format, payloadBase64: 'gP8=' }), 'gP8=');
  }
});

test('history payload cache formats a bounded preview once per current row set and keeps details full', () => {
  let calls = 0;
  const cache = createHistoryPayloadCache((row, options) => {
    calls += 1;
    return `${row.id}:${options.byteLimit ?? 'full'}`;
  });
  const rows = [{ id: 1 }, { id: 2 }];

  assert.deepEqual(cache.previews(rows, 2), ['1:2', '2:2']);
  assert.deepEqual(cache.previews(rows, 2), ['1:2', '2:2']);
  assert.equal(calls, 2);
  assert.equal(cache.detail(rows, rows[0]), '1:full');
  assert.equal(cache.detail(rows, rows[0]), '1:full');
  assert.equal(calls, 3);

  const replacementRows = [{ id: 3 }];
  assert.deepEqual(cache.previews(replacementRows, 2), ['3:2']);
  assert.equal(cache.detail(replacementRows, replacementRows[0]), '3:full');
  assert.equal(calls, 5);
});

test('history framing labels include serial receive framing and send framing modes', () => {
  assert.deepEqual(Object.fromEntries([
    'raw', 'delimiter', 'fixed', 'idle', 'none', 'line', 'length-prefix',
  ].map((value) => [value, formatFramingLabel(value)])), {
    raw: '原始数据',
    delimiter: '分隔符',
    fixed: '固定长度',
    idle: '空闲超时',
    none: '无',
    line: '按行',
    'length-prefix': '长度前缀',
  });
});

test('settings are typed, complete, and normalized without browser storage', () => {
  assert.deepEqual(Object.keys(DEFAULT_SETTINGS), [
    'logLevel', 'realtimeFrameLimit', 'realtimeLogLimit', 'previewByteLimit',
    'defaultFraming', 'autoScroll', 'theme', 'largeFont', 'modbusPointHistoryRetention', 'stompProfiles', 'acceptanceWorkspace',
  ]);
  assert.equal(DEFAULT_SETTINGS.modbusPointHistoryRetention, '30-days');
  assert.deepEqual(normalizeSettings({ theme: 'dark', autoScroll: false }), {
    ...DEFAULT_SETTINGS,
    theme: 'dark',
    autoScroll: false,
  });
  assert.throws(() => normalizeSettings({ realtimeFrameLimit: 'many' }), /realtimeFrameLimit/);
  assert.throws(() => normalizeSettings({ theme: 'purple' }), /theme/);
  assert.throws(() => normalizeSettings({ modbusPointHistoryRetention: '14-days' }), /Retention/);
});

test('settings preserve only safe STOMP profiles and allocate independent defaults', () => {
  assert.throws(() => normalizeSettings({ stompProfiles: { passcode: 'private' } }), /STOMP|配置/);
  const profile = { id: 'stomp-test', name: 'test', mode: 'client', config: { url: 'ws://localhost:61614/stomp' }, subscriptions: [], credentials: { passcode: 'private' } };
  const normalized = normalizeSettings({ stompProfiles: [profile] });
  assert.equal(normalized.stompProfiles[0].config.url, profile.config.url);
  assert(!JSON.stringify(normalized).includes('private'));
  const first = normalizeSettings(); first.stompProfiles.push(profile);
  assert.deepEqual(normalizeSettings().stompProfiles, []);
});

test('workspace schema version is checked before a mutation can run', () => {
  let mutations = 0;
  assert.throws(
    () => validateWorkspaceDocument({ schemaVersion: 2 }, 1, () => { mutations += 1; }),
    /schema version/i,
  );
  assert.equal(mutations, 0);
  const document = { schemaVersion: 1, endpointProfiles: [], settings: {}, sendTemplates: [] };
  assert.equal(validateWorkspaceDocument(document, 1, () => { mutations += 1; }), document);
  assert.equal(mutations, 1);
});

test('storage clear flushes pending persistence before native clear and refreshes stats', async () => {
  const calls = [];
  const runtime = {
    persistence: { flush: async () => { calls.push('flush'); } },
    storage: {
      clearHistory: async () => { calls.push('clear'); return { cleared: true }; },
      stats: async () => {
        calls.push('stats');
        return { frameCount: 0, logCount: 0, sendHistoryCount: 0, totalCount: 0, diskBytes: 4096 };
      },
    },
  };
  const controller = createStorageController(runtime);
  await controller.clearHistory();
  assert.deepEqual(calls, ['flush', 'clear', 'stats']);
  assert.equal(controller.state.stats.diskBytes, 4096);
});

test('storage controller publishes busy state, deduplicates actions, and ignores stale completion', async () => {
  const first = deferred();
  const second = deferred();
  let statsCalls = 0;
  let clearCalls = 0;
  const controller = createStorageController({
    storage: {
      stats() { statsCalls += 1; return statsCalls === 1 ? first.promise : second.promise; },
      async clearHistory() { clearCalls += 1; return { cleared: true, reclaimed: true }; },
    },
  });
  const publications = [];
  controller.subscribe(() => publications.push(controller.state.loading));
  const refresh = controller.refresh();
  assert.equal(controller.refresh(), refresh);
  assert.equal(controller.state.loading, true);
  assert.equal(publications[0], true);
  assert.equal(controller.clearHistory(), refresh);
  assert.equal(clearCalls, 0);
  first.resolve({ totalCount: 4 });
  await refresh;
  const clear = controller.clearHistory();
  assert.equal(controller.clearHistory(), clear);
  await Promise.resolve();
  assert.equal(clearCalls, 1);
  second.resolve({ totalCount: 0 });
  await clear;
  assert.equal(controller.state.stats.totalCount, 0);
  controller.dispose();
});

test('storage dispose prevents pending refresh and clear from mutating state or continuing', async () => {
  const refreshGate = deferred();
  const refreshController = createStorageController({
    storage: { stats: () => refreshGate.promise, clearHistory: async () => ({}) },
  });
  const refresh = refreshController.refresh();
  refreshController.dispose();
  refreshGate.resolve({ totalCount: 9 });
  await refresh;
  assert.equal(refreshController.state.stats, null);

  const clearGate = deferred();
  let statsCalls = 0;
  const clearController = createStorageController({
    storage: {
      clearHistory: () => clearGate.promise,
      stats: async () => { statsCalls += 1; return { totalCount: 0 }; },
    },
  });
  const clear = clearController.clearHistory();
  clearController.dispose();
  clearGate.resolve({ cleared: true, reclaimed: true });
  await clear;
  assert.equal(clearController.state.clearResult, null);
  assert.equal(clearController.state.stats, null);
  assert.equal(statsCalls, 0);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}
