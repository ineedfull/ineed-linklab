import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractDeviceTemplate,
  normalizeDeviceTemplate,
  instantiateDeviceTemplate,
  deviceTemplatePlan,
} from '../src/model/deviceTemplates.js';
import {
  createAcceptanceRunner,
  normalizeAcceptanceReport,
} from '../src/model/acceptanceRunner.js';
import {
  createAcceptanceWorkspace,
  normalizeAcceptanceDocument,
} from '../src/model/acceptanceWorkspace.js';

export const endpoint = () => ({
  id: 'original',
  name: 'Boiler',
  transport: 'modbus-tcp-master',
  config: {
    host: 'secret-site',
    password: 'secret',
    unitId: 8,
    requestGroups: [
      {
        id: 'g',
        name: 'Read',
        unitId: 8,
        password: 'nested-secret',
        requests: [
          {
            id: 'r',
            name: 'Temperature',
            functionCode: 3,
            startAddress: 10,
            quantity: 1,
            dataPoints: [
              {
                id: 'p',
                key: 'temperature',
                name: '温度',
                dataType: 'uint16',
                scale: 0.1,
                unit: '℃',
                minimum: 20,
                maximum: 30,
              },
            ],
          },
        ],
      },
    ],
  },
});
const target = {
  endpointId: 'new',
  name: 'New',
  protocol: 'modbus',
  sessionId: 'session',
  identity: 'localhost:502',
};
const runner = (actual = [253], quality = 'Good') =>
  createAcceptanceRunner({
    captureTarget: () => target,
    isCurrent: () => true,
    read: async () => ({
      actual,
      quality,
      evidence: {
        functionCode: 3,
        address: 10,
        unitId: 2,
        quantity: actual.length,
      },
    }),
  });
test('extracts safe normalized decoding and readonly conditions without site or unknown secrets', () => {
  const value = extractDeviceTemplate(endpoint(), 'Boiler T');
  assert.equal(value.version, 1);
  assert.equal(value.conditions.length, 1);
  assert.equal(value.groups[0].requests[0].dataPoints[0].scale, 0.1);
  assert.doesNotMatch(JSON.stringify(value), /secret|password|host/);
  assert.deepEqual(normalizeDeviceTemplate(value), value);
  assert.throws(() => normalizeDeviceTemplate({ ...value, password: 'bad' }));
  const invalid = structuredClone(value);
  invalid.groups[0].requests[0].functionCode = 6;
  assert.throws(() => normalizeDeviceTemplate(invalid));
});
test('instantiates distinct new TCP and RTU endpoints with explicit site and unit overrides', () => {
  const template = extractDeviceTemplate(endpoint(), 'Boiler');
  const a = instantiateDeviceTemplate(template, {
    name: 'A',
    transport: 'modbus-tcp-master',
    host: '127.0.0.1',
    port: 1502,
    unitId: 2,
  });
  const b = instantiateDeviceTemplate(template, {
    name: 'B',
    transport: 'modbus-rtu-master',
    path: '/tmp/tty-test',
    baudRate: 19200,
    parity: 'even',
    unitId: 3,
  });
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.id, 'original');
  assert.equal(a.config.requestGroups[0].unitId, 2);
  assert.equal(b.config.requestGroups[0].unitId, 3);
  assert.equal(b.config.baudRate, 19200);
  assert.equal(a.config.scheduler.autoStart, false);
  assert.throws(() =>
    instantiateDeviceTemplate(template, {
      name: 'bad',
      transport: 'tcp-client',
      unitId: 0,
    }),
  );
});
test('fresh raw 253 becomes 25.3 with raw/config/unit/version evidence and immutable plan', async () => {
  const template = extractDeviceTemplate(endpoint(), 'Boiler');
  const plan = deviceTemplatePlan(template, 2);
  const report = await runner().run(plan, 'new');
  assert.equal(report.status, 'passed');
  assert.equal(report.results[0].actual, 25.3);
  assert.deepEqual(report.results[0].evidence.engineering.raw, [253]);
  assert.equal(report.results[0].evidence.engineering.point.unit, '℃');
  assert.equal(report.plan.checks[0].engineering.template.version, 1);
  template.groups[0].requests[0].dataPoints[0].scale = 1;
  assert.equal(report.plan.checks[0].engineering.point.scale, 0.1);
  assert.deepEqual(normalizeAcceptanceReport(report), report);
  const forged = structuredClone(report);
  forged.results[0].evidence.engineering.raw = [99];
  assert.throws(() => normalizeAcceptanceReport(forged));
});
test('out of range, bad transport quality and imprecise scaled 64-bit values cannot pass', async () => {
  const template = extractDeviceTemplate(endpoint(), 'Boiler');
  assert.equal(
    (await runner([350]).run(deviceTemplatePlan(template, 2), 'new')).status,
    'failed',
  );
  assert.equal(
    (await runner([253], 'Bad').run(deviceTemplatePlan(template, 2), 'new'))
      .status,
    'failed',
  );
  const source = endpoint();
  const request = source.config.requestGroups[0].requests[0];
  request.quantity = 4;
  Object.assign(request.dataPoints[0], {
    dataType: 'uint64',
    scale: 0.1,
    minimum: null,
    maximum: null,
  });
  const wide = extractDeviceTemplate(source, 'Wide');
  wide.conditions = [
    {
      groupId: 'g',
      requestId: 'r',
      pointId: 'p',
      assertion: { kind: 'range', minimum: 0, maximum: 1e30 },
    },
  ];
  const report = await runner([65535, 65535, 65535, 65535]).run(
    deviceTemplatePlan(wide, 2),
    'new',
  );
  assert.equal(report.status, 'failed');
  assert.match(report.results[0].quality, /uncertain/);
});
test('library appends revisions, survives reload and preserves old reports and old documents', async () => {
  let saved = {};
  const runtime = {
    settings: {
      getAll: async () => saved,
      saveAll: async (v) => {
        saved = structuredClone(v);
      },
    },
  };
  const workspace = createAcceptanceWorkspace(runtime, { runner: runner() });
  await workspace.load();
  const template = extractDeviceTemplate(endpoint(), 'Boiler');
  await workspace.saveTemplate(template);
  await workspace.run(deviceTemplatePlan(template, 2), 'new');
  template.groups[0].requests[0].dataPoints[0].scale = 0.2;
  const next = await workspace.saveTemplate(template);
  assert.equal(next.version, 2);
  assert.equal(workspace.state.templates.length, 2);
  await workspace.reload();
  assert.equal(
    workspace.state.templates[0].groups[0].requests[0].dataPoints[0].scale,
    0.1,
  );
  assert.equal(workspace.state.reports[0].results[0].actual, 25.3);
  assert.equal(
    normalizeAcceptanceDocument('{"version":1,"plans":[],"reports":[]}').plans
      .length,
    0,
  );
});
test('malformed raw values cannot be decoded into a passing engineering measurement', async () => {
  const template = extractDeviceTemplate(endpoint(), 'Boiler');
  for (const raw of [['253'], [65536 + 253], [-65283], [253, 1]]) {
    const report = await runner(raw).run(
      deviceTemplatePlan(template, 2),
      'new',
    );
    assert.equal(report.status, 'failed', JSON.stringify(raw));
  }
});
test('exact 64-bit equality and ordered JSON import preserve precision and meaning', async () => {
  const source = endpoint();
  const request = source.config.requestGroups[0].requests[0];
  request.quantity = 4;
  Object.assign(request.dataPoints[0], {
    dataType: 'uint64',
    scale: 1,
    minimum: null,
    maximum: null,
  });
  const template = extractDeviceTemplate(source, 'Exact');
  template.conditions = [
    {
      groupId: 'g',
      requestId: 'r',
      pointId: 'p',
      assertion: { kind: 'equals', expected: '18446744073709551615' },
    },
  ];
  assert.equal(
    (
      await runner([65535, 65535, 65535, 65535]).run(
        deviceTemplatePlan(template, 2),
        'new',
      )
    ).status,
    'passed',
  );
  const group = template.groups[0];
  template.groups[0] = Object.fromEntries(Object.entries(group).reverse());
  assert.equal(normalizeDeviceTemplate(template).groups[0].id, 'g');
});
test('64-bit reasonable bounds become exact decimal range conditions without Number rounding', async () => {
  const source = endpoint();
  const request = source.config.requestGroups[0].requests[0];
  request.quantity = 4;
  Object.assign(request.dataPoints[0], {
    dataType: 'uint64',
    scale: 1,
    minimum: '18446744073709551614',
    maximum: '18446744073709551615',
  });
  const template = extractDeviceTemplate(source, 'Exact range');
  assert.equal(
    template.conditions[0].assertion.minimum,
    '18446744073709551614',
  );
  const plan = deviceTemplatePlan(template, 2);
  assert.equal(
    (await runner([65535, 65535, 65535, 65535]).run(plan, 'new')).status,
    'passed',
  );
  assert.equal(
    (await runner([65535, 65535, 65535, 65533]).run(plan, 'new')).status,
    'failed',
  );
});
test('engineering evidence retains native transport quality and rejects ranges over text points', async () => {
  const template = extractDeviceTemplate(endpoint(), 'Quality');
  const report = await runner([253], 'Bad').run(
    deviceTemplatePlan(template, 2),
    'new',
  );
  assert.equal(report.results[0].evidence.engineering.transportQuality, 'Bad');
  const text = structuredClone(template);
  text.groups[0].requests[0].dataPoints[0].dataType = 'string';
  assert.throws(() => normalizeDeviceTemplate(text));
});
test('template validation failures and corrupt libraries do not overwrite persisted data', async () => {
  let stored = {};
  let fail = false;
  const runtime = {
    settings: {
      getAll: async () => stored,
      saveAll: async (value) => {
        if (fail) throw Error('disk full');
        stored = structuredClone(value);
      },
    },
  };
  const workspace = createAcceptanceWorkspace(runtime, { runner: runner() });
  await workspace.load();
  const template = extractDeviceTemplate(endpoint(), 'Retained');
  fail = true;
  await assert.rejects(workspace.saveTemplate(template), /disk full/);
  assert.equal(workspace.state.dirty, true);
  assert.equal(workspace.state.templates.length, 1);
  fail = false;
  await workspace.flush();
  assert.equal(JSON.parse(stored.acceptanceWorkspace).templates.length, 1);
  const before = structuredClone(stored);
  await assert.rejects(
    workspace.saveTemplate({
      ...template,
      conditions: [
        {
          groupId: 'no',
          requestId: 'no',
          pointId: 'no',
          assertion: { kind: 'equals', expected: 1 },
        },
      ],
    }),
  );
  assert.deepEqual(stored, before);
  stored.acceptanceWorkspace =
    '{"version":1,"plans":[],"reports":[],"templates":[{}]}';
  await assert.rejects(workspace.reload());
  assert.equal(workspace.state.loaded, false);
  await assert.rejects(workspace.saveTemplate(template));
  assert.equal(
    stored.acceptanceWorkspace,
    '{"version":1,"plans":[],"reports":[],"templates":[{}]}',
  );
});
test('a session change while an engineering read is pending invalidates the report', async () => {
  let current = true;
  const execution = createAcceptanceRunner({ captureTarget: () => target, isCurrent: () => current, read: async () => { current = false; return { actual: [253], quality: 'Good', evidence: {} }; } });
  const report = await execution.run(deviceTemplatePlan(extractDeviceTemplate(endpoint(), 'Session'), 2), 'new');
  assert.equal(report.status, 'invalidated'); assert.equal(report.results[0].status, 'failed'); assert.equal(report.results[0].actual, null);
});
