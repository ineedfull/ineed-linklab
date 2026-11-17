import * as files from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAcceptanceWorkspace,
  formatAcceptanceReport,
  normalizeAcceptanceDocument,
  ACCEPTANCE_SETTING_KEY,
} from '../src/model/acceptanceWorkspace.js';
import { createAcceptanceRunner } from '../src/model/acceptanceRunner.js';
import { createUiPreferences } from '../src/model/uiPreferences.js';
import { plan } from './acceptanceFixtures.js';
import {
  normalizeAcceptancePlan,
  jsonBytes,
  ACCEPTANCE_LIMITS,
} from '../src/model/acceptancePlan.js';
import { createOpcuaExporter } from '../../../apps/electron/electron/opcuaExport.cjs';
function runtimeFixture() {
  let stored = {};
  let fail = false;
  return {
    settings: {
      getAll: async () => structuredClone(stored),
      saveAll: async (value) => {
        if (fail) throw Error('disk full');
        stored = structuredClone(value);
      },
    },
    get stored() {
      return stored;
    },
    set stored(value) {
      stored = value;
    },
    set fail(value) {
      fail = value;
    },
  };
}
function runnerFixture(read = async () => ({ actual: [7], quality: 'Good' })) {
  return createAcceptanceRunner({
    captureTarget: () => ({
      endpointId: 'e1',
      name: 'Local',
      protocol: 'modbus',
      identity: 'localhost',
      sessionId: 's1',
    }),
    isCurrent: () => true,
    read,
  });
}
test('save/import are atomic on validation failure; imports receive new IDs; roundtrip is strict', async () => {
  const runtime = runtimeFixture();
  const ws = createAcceptanceWorkspace(runtime, { runner: runnerFixture() });
  await ws.load();
  await ws.savePlan(plan());
  const original = structuredClone(ws.state.plans);
  await assert.rejects(ws.importPlan('{"bad":true}'));
  assert.deepEqual(ws.state.plans, original);
  const imported = await ws.importPlan(ws.exportPlan(plan()));
  assert.notEqual(imported.id, original[0].id);
  assert.equal(ws.state.plans.length, 2);
  const loaded = createAcceptanceWorkspace(runtime, {
    runner: runnerFixture(),
  });
  await loaded.load();
  assert.deepEqual(loaded.state.plans, ws.state.plans);
});
test('failed saves keep plans/reports in memory and flush retries; report Markdown contains evidence and complete local timestamps', async () => {
  const runtime = runtimeFixture(),
    ws = createAcceptanceWorkspace(runtime, { runner: runnerFixture() });
  await ws.load();
  runtime.fail = true;
  await assert.rejects(ws.savePlan(plan()), /disk full/);
  assert.equal(ws.state.plans.length, 1);
  await assert.rejects(ws.run(plan(), 'e1'), /disk full/);
  assert.equal(ws.state.reports.length, 1);
  runtime.fail = false;
  await ws.flush();
  assert.equal(
    JSON.parse(runtime.stored[ACCEPTANCE_SETTING_KEY]).reports.length,
    1,
  );
  const md = formatAcceptanceReport(ws.state.reports[0], 'markdown');
  assert.match(md, /\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}/);
  assert.match(md, /Good/);
});
test('corrupt documents fail visibly and prevent overwrites even after an appearance change', async () => {
  const runtime = runtimeFixture();
  runtime.stored = {
    acceptanceWorkspace: '{"version":1,"plans":[{}],"reports":[]}',
  };
  const ws = createAcceptanceWorkspace(runtime, { runner: runnerFixture() });
  await assert.rejects(ws.load());
  assert(ws.state.error);
  await assert.rejects(ws.savePlan(plan()));
  assert.throws(() =>
    normalizeAcceptanceDocument(runtime.stored.acceptanceWorkspace),
  );
  assert.equal(
    runtime.stored.acceptanceWorkspace,
    '{"version":1,"plans":[{}],"reports":[]}',
  );
});
test('report retention keeps newest twenty and plan count, plan bytes and workspace bytes are bounded', async () => {
  const runtime = runtimeFixture(),
    ws = createAcceptanceWorkspace(runtime, { runner: runnerFixture() });
  await ws.load();
  for (let i = 0; i < 22; i++) await ws.run(plan(), 'e1');
  assert.equal(ws.state.reports.length, 20);
  const first = ws.state.reports[0].id;
  await ws.run(plan(), 'e1');
  assert.notEqual(ws.state.reports[0].id, first);
  assert.throws(() =>
    normalizeAcceptanceDocument(
      JSON.stringify({
        version: 1,
        plans: Array.from({ length: 51 }, (_, i) => ({
          ...plan(),
          id: `p${i}`,
        })),
        reports: [],
      }),
    ),
  );
  const large = plan();
  large.checks[0].assertion.expected = 'x'.repeat(65536);
  await assert.rejects(ws.savePlan(large));
});
test('shutdown stop snapshot flush does not wait for a pending native read', async () => {
  let finish;
  const runtime = runtimeFixture(),
    runner = runnerFixture(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  const ws = createAcceptanceWorkspace(runtime, { runner });
  await ws.load();
  const run = ws.run(plan(), 'e1');
  await Promise.resolve();
  await ws.stop();
  await ws.flush();
  assert.equal(
    JSON.parse(runtime.stored.acceptanceWorkspace).reports[0].status,
    'stopped',
  );
  finish({ actual: [7], quality: 'Good' });
  await run;
});
test('appearance save and acceptance writes share the queue and stale appearance values cannot erase evidence', async () => {
  const runtime = runtimeFixture(),
    ws = createAcceptanceWorkspace(runtime, { runner: runnerFixture() });
  await ws.load();
  const root = {
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
  };
  const prefs = createUiPreferences(runtime, { root, matchMedia: () => null });
  await prefs.load();
  await Promise.all([
    ws.savePlan(plan()),
    prefs.save({ ...prefs.state.values, theme: 'dark' }),
  ]);
  assert.equal(JSON.parse(runtime.stored.acceptanceWorkspace).plans.length, 1);
  assert.equal(runtime.stored.theme, 'dark');
  prefs.dispose();
});
test('reload invalidates an old run so late native responses cannot overwrite imported evidence', async () => {
  let finish;
  const runtime = runtimeFixture(),
    ws = createAcceptanceWorkspace(runtime, {
      runner: runnerFixture(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    });
  await ws.load();
  const run = ws.run(plan(), 'e1');
  await Promise.resolve();
  await ws.stop();
  await ws.flush();
  runtime.stored = {
    acceptanceWorkspace: '{"version":1,"plans":[],"reports":[]}',
  };
  await ws.reload();
  finish({ actual: [7], quality: 'Good' });
  await run;
  assert.equal(ws.state.reports.length, 0);
  assert.equal(
    JSON.parse(runtime.stored.acceptanceWorkspace).reports.length,
    0,
  );
});
test('saved reports reject malformed evidence and enforce per-report and total retention bounds', async () => {
  const runtime = runtimeFixture(),
    ws = createAcceptanceWorkspace(runtime, { runner: runnerFixture() });
  await ws.load();
  const base = await ws.run(plan(), 'e1');
  for (const patch of [
    (r) => {
      r.results[0].quality = 'Bad';
    },
    (r) => {
      r.results[0].checkId = 'wrong';
    },
    (r) => {
      r.plan.checks[0].query.functionCode = 6;
    },
    (r) => {
      r.results[0].actual = 'x'.repeat(530000);
    },
  ]) {
    const report = structuredClone(base);
    patch(report);
    assert.throws(() =>
      normalizeAcceptanceDocument(
        JSON.stringify({ version: 1, plans: [], reports: [report] }),
      ),
    );
  }
  const large = plan();
  large.checks = Array.from({ length: 25 }, (_, i) => ({
    ...structuredClone(large.checks[0]),
    id: `c${i}`,
  }));
  const hefty = createAcceptanceWorkspace(runtime, {
    runner: runnerFixture(async () => ({
      actual: [7],
      quality: 'Good',
      evidence: 'x'.repeat(11000),
    })),
  });
  await hefty.load();
  for (let i = 0; i < 9; i++) await hefty.run(large, 'e1');
  assert(hefty.state.reports.length < 9);
  assert(hefty.state.reports.length > 1);
  assert(
    new TextEncoder().encode(runtime.stored.acceptanceWorkspace).length <=
      2097152,
  );
});
test('appearance cannot rewrite an opaque native-valid but domain-corrupt acceptance document', async () => {
  const runtime = runtimeFixture();
  const corrupt = '{"version":1,"plans":[{}],"reports":[]}';
  runtime.stored = { acceptanceWorkspace: corrupt };
  const prefs = createUiPreferences(runtime, {
    root: { dataset: {}, classList: { add() {}, remove() {}, toggle() {} } },
    matchMedia: () => null,
  });
  await assert.rejects(prefs.save({ theme: 'dark' }));
  assert.equal(runtime.stored.acceptanceWorkspace, corrupt);
  assert.equal(runtime.stored.theme, undefined);
  prefs.dispose();
});
test('when plans plus latest report cannot fit, keep the report in memory and retry after freeing plan space', async () => {
  const runtime = runtimeFixture();
  const plans = Array.from({ length: 32 }, (_, index) => {
    const value = plan();
    value.id = `large-${index}`;
    value.checks[0].assertion.expected = 'x'.repeat(60000);
    return value;
  });
  runtime.stored = {
    acceptanceWorkspace: JSON.stringify({ version: 1, plans, reports: [] }),
  };
  const large = plan();
  large.checks = Array.from({ length: 25 }, (_, index) => ({
    ...structuredClone(large.checks[0]),
    id: `c${index}`,
  }));
  const ws = createAcceptanceWorkspace(runtime, {
    runner: runnerFixture(async () => ({
      actual: [7],
      quality: 'Good',
      evidence: 'x'.repeat(11000),
    })),
  });
  await ws.load();
  await assert.rejects(ws.run(large, 'e1'));
  assert.equal(ws.state.reports.length, 1);
  assert(ws.state.dirty);
  await assert.rejects(ws.deletePlan('large-0'));
  await ws.deletePlan('large-1');
  await ws.flush();
  assert.equal(
    JSON.parse(runtime.stored.acceptanceWorkspace).reports.length,
    1,
  );
});
for (const action of ['stop', 'dispose']) {
  test(`${action} after reload does not restore a completed report from the previous workspace generation`, async () => {
    const runtime = runtimeFixture();
    const ws = createAcceptanceWorkspace(runtime, { runner: runnerFixture() });
    await ws.load();
    await ws.run(plan(), 'e1');
    runtime.stored = {
      acceptanceWorkspace: '{"version":1,"plans":[],"reports":[]}',
    };
    await ws.reload();
    await ws[action]();
    assert.equal(ws.state.reports.length, 0);
    assert.equal(
      JSON.parse(runtime.stored.acceptanceWorkspace).reports.length,
      0,
    );
  });
}
test('valid nested OPC UA plans execute, save, reload, retry and export without envelope depth mismatches', async () => {
  let value = 7;
  for (let depth = 0; depth < 28; depth++) value = { a: value };
  const input = plan('opcua');
  input.checks[0].assertion.expected = value;
  const runtime = runtimeFixture();
  const runner = createAcceptanceRunner({
    captureTarget: () => ({
      endpointId: 'e1',
      name: 'Local',
      protocol: 'opcua',
      identity: 'localhost',
      sessionId: 's1',
    }),
    isCurrent: () => true,
    read: async () => ({ actual: value, quality: 'Good' }),
  });
  const ws = createAcceptanceWorkspace(runtime, { runner });
  await ws.load();
  await ws.savePlan(input);
  runtime.fail = true;
  await assert.rejects(ws.run(input, 'e1'), /disk full/);
  assert.equal(ws.state.reports[0].status, 'passed');
  assert(ws.state.dirty);
  runtime.fail = false;
  await ws.flush();
  await ws.reload();
  assert.equal(ws.state.reports.length, 1);
  assert.equal(
    JSON.parse(formatAcceptanceReport(ws.state.reports[0], 'json')).status,
    'passed',
  );
  assert.match(
    formatAcceptanceReport(ws.state.reports[0], 'markdown'),
    /passed/,
  );
});
test('unexpected finalized report validation errors retain a visible pending snapshot and retry on flush', async () => {
  const runtime = runtimeFixture();
  const report = structuredClone(await runnerFixture().run(plan(), 'e1'));
  report.endedAt = null;
  const runner = {
    state: { report: null },
    stop() {
      return this.state.report;
    },
    async run() {
      this.state.report = report;
      return report;
    },
  };
  const ws = createAcceptanceWorkspace(runtime, { runner });
  await ws.load();
  await assert.rejects(ws.run(plan(), 'e1'), /report status or time/);
  assert.equal(ws.state.pendingReport.id, report.id);
  assert(ws.state.dirty);
  assert.match(ws.state.error, /report status or time/);
  await assert.rejects(ws.flush(), /report status or time/);
  assert.equal(ws.state.pendingReport.id, report.id);
});

test('exported array plans round-trip through the 64 KiB import boundary without losing expected values', async () => {
  const input = plan('opcua');
  input.checks[0].assertion.expected = Array(10000).fill(0);
  const ws = createAcceptanceWorkspace(runtimeFixture(), {
    runner: runnerFixture(),
  });
  await ws.load();
  const normalized = normalizeAcceptancePlan(input);
  const text = ws.exportPlan(normalized);
  assert(Buffer.byteLength(text, 'utf8') <= ACCEPTANCE_LIMITS.planBytes);
  assert.deepEqual(JSON.parse(text), normalized);
  const imported = await ws.importPlan(text);
  assert.notEqual(imported.id, input.id);
  assert.deepEqual({ ...imported, id: input.id }, normalized);
});
test('a plan exactly at 64 KiB round-trips with a new ID and preserves every expected byte', async () => {
  const input = plan('opcua');
  input.id = 'p';
  input.checks[0].assertion.expected = '';
  input.checks[0].assertion.expected = 'x'.repeat(
    ACCEPTANCE_LIMITS.planBytes - jsonBytes(input),
  );
  assert.equal(jsonBytes(input), ACCEPTANCE_LIMITS.planBytes);
  const ws = createAcceptanceWorkspace(runtimeFixture(), {
    runner: runnerFixture(),
  });
  await ws.load();
  await ws.savePlan(input);
  for (const id of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    .replace('p', '')
    .slice(0, 48)) {
    await ws.savePlan({ ...plan('opcua'), id });
  }
  const imported = await ws.importPlan(JSON.stringify(input));
  const text = ws.exportPlan(input);
  assert(Buffer.byteLength(text, 'utf8') <= ACCEPTANCE_LIMITS.planBytes);
  assert.equal(ws.state.plans.length, 50);
  assert.equal(new Set(ws.state.plans.map((value) => value.id)).size, 50);
  assert.notEqual(imported.id, input.id);
  assert.deepEqual({ ...imported, id: input.id }, input);
  assert(jsonBytes(imported) <= ACCEPTANCE_LIMITS.planBytes);
});

function markdownEvidence(text) {
  const lines = text.split('\n');
  const payloads = [];
  for (let index = 0; index < lines.length; index++) {
    if (lines[index] !== '```json') continue;
    const closing = lines.indexOf('```', index + 1);
    assert(closing > index, 'JSON evidence has a closing Markdown fence');
    payloads.push(JSON.parse(lines.slice(index + 1, closing).join('\n')));
    index = closing;
  }
  return payloads;
}
async function exportThroughNativeBoundary(fileName, content) {
  const root = await files.mkdtemp(join(tmpdir(), 'acceptance-native-export-'));
  const selected = join(root, 'report');
  try {
    const exporter = createOpcuaExporter({
      getWindow: () => ({ isDestroyed: () => false }),
      dialog: { showSaveDialog: async () => ({ canceled: false, filePath: selected }) },
      files,
    });
    assert.deepEqual(await exporter({ fileName, content }), { saved: true });
    assert.equal(await files.readFile(selected, 'utf8'), content);
    await assert.rejects(exporter({ fileName, content: 'x'.repeat(1024 * 1024 + 1) }), /1 MiB/);
    assert.equal(await files.readFile(selected, 'utf8'), content, 'oversized export preserves the previous file');
  } finally {
    await files.rm(root, { recursive: true, force: true });
  }
}
for (const scenario of ['array', 'nested-array', 'backticks']) {
  test(`large ${scenario} JSON and Markdown reports preserve complete evidence and pass the actual Electron export boundary`, async () => {
    let actual =
      scenario === 'array' ? Array(5000).fill(0) : Array(4000).fill(0);
    if (scenario === 'nested-array') {
      for (let depth = 0; depth < 20; depth++) actual = { a: actual };
    }
    if (scenario === 'backticks')
      actual = '`'.repeat(11900) + '\n```json\nmalicious close\n```\n~~~';
    const input = plan('opcua');
    input.checks = Array.from({ length: 25 }, (_, index) => ({
      id: `c${index}`,
      name: `Check ${index}`,
      query: { nodeId: 'i=1' },
      assertion: { kind: 'range', minimum: 0, maximum: 1 },
    }));
    const runner = createAcceptanceRunner({
      captureTarget: () => ({
        endpointId: 'e',
        name: 'E',
        protocol: 'opcua',
        identity: 'localhost',
        sessionId: 's',
      }),
      isCurrent: () => true,
      read: async () => ({ actual, quality: 'Good', evidence: null }),
    });
    const report = await runner.run(input, 'e');
    assert(jsonBytes(report) <= ACCEPTANCE_LIMITS.reportBytes);
    assert(
      report.results.every((result) => result.actual !== null),
      'the complete actual data was retained',
    );
    const json = formatAcceptanceReport(report, 'json');
    await exportThroughNativeBoundary('linklab-acceptance-report.json', json);
    assert.deepEqual(JSON.parse(json), report);
    const markdown = formatAcceptanceReport(report, 'markdown');
    await exportThroughNativeBoundary('linklab-acceptance-report.md', markdown);
    const payloads = markdownEvidence(markdown);
    assert.equal(payloads.length, report.results.length);
    payloads.forEach((payload, index) =>
      assert.deepEqual(payload, {
        query: report.plan.checks[index].query,
        assertion: report.plan.checks[index].assertion,
        actual: report.results[index].actual,
        quality: report.results[index].quality,
        evidence: report.results[index].evidence,
        error: report.results[index].error,
      }),
    );
  });
}

test('clock rollback report persists and does not block flush or subsequent plan saves', async () => {
  const runtime = runtimeFixture();
  const times = [1000, 2000, 2001, 1500];
  const runner = createAcceptanceRunner({
    captureTarget: () => ({ endpointId: 'e1', name: 'Local', protocol: 'modbus', identity: 'localhost', sessionId: 's1' }),
    isCurrent: () => true,
    now: () => times.shift() ?? 1500,
    read: async () => ({ actual: [7], quality: 'Good' }),
  });
  const ws = createAcceptanceWorkspace(runtime, { runner });
  await ws.load();
  await ws.run(plan(), 'e1');
  await ws.flush();
  await ws.savePlan(plan());
  const restored = createAcceptanceWorkspace(runtime, { runner: runnerFixture() });
  await restored.load();
  assert.equal(restored.state.reports.length, 1);
  assert.equal(restored.state.reports[0].endedAt, 2001);
  assert.deepEqual(restored.state.reports[0].results[0].actual, [7]);
  assert.equal(restored.state.plans.length, 1);
});
