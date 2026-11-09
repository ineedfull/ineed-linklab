import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAcceptanceRunner,
  normalizeAcceptanceReport,
} from '../src/model/acceptanceRunner.js';
import { plan } from './acceptanceFixtures.js';
const target = {
  endpointId: 'e1',
  name: 'Local',
  protocol: 'modbus',
  identity: '127.0.0.1:502',
  sessionId: 's1',
  privateToken: 'never persist',
};
function fixture(options = {}) {
  return createAcceptanceRunner({
    captureTarget: () => target,
    isCurrent: () => true,
    read: async () => ({
      actual: [7],
      quality: 'Good',
      evidence: { functionCode: 3 },
    }),
    ...options,
  });
}
test('runner freezes plan and safe target snapshots, executes sequentially and generates independent reports', async () => {
  const p = plan();
  const runner = fixture();
  const one = await runner.run(p, 'e1');
  p.name = 'changed';
  assert.equal(one.status, 'passed');
  assert.equal(one.plan.name, 'Read only');
  assert.equal(one.target.privateToken, undefined);
  assert(Object.isFrozen(one.plan.checks));
  const two = await runner.run(p, 'e1');
  assert.notEqual(two.id, one.id);
});
test('missing/bad quality, missing response, oversized evidence and wrong values cannot pass', async () => {
  for (const response of [
    null,
    { actual: [7] },
    { actual: [7], quality: 'Bad' },
    { actual: ['7'], quality: 'Good' },
    { actual: [7], quality: 'Good', evidence: 'x'.repeat(13000) },
  ]) {
    const report = await fixture({ read: async () => response }).run(
      plan(),
      'e1',
    );
    assert.equal(report.status, 'failed');
    assert.equal(report.results[0].status, 'failed');
  }
});
test('stop finalizes synchronously, blocks second run until read settles and suppresses late passing data', async () => {
  let finish,
    reads = 0;
  const runner = fixture({
    read: () => {
      reads++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const p = plan();
  p.checks.push({ ...structuredClone(p.checks[0]), id: 'check-2' });
  const running = runner.run(p, 'e1');
  await Promise.resolve();
  runner.stop();
  assert.equal(runner.state.report.status, 'stopped');
  assert.equal(runner.state.running, true);
  await assert.rejects(runner.run(p, 'e1'), /running/);
  finish({ actual: [7], quality: 'Good' });
  const report = await running;
  assert.equal(reads, 1);
  assert.equal(report.status, 'stopped');
  assert.equal(report.results[0].status, 'failed');
  assert.equal(report.results[1].status, 'not-run');
});
test('session changes before/after requests invalidate the run and leave later checks unrun', async () => {
  let current = true;
  const p = plan();
  p.checks.push({ ...structuredClone(p.checks[0]), id: 'check-2' });
  const report = await fixture({
    isCurrent: () => current,
    read: async () => {
      current = false;
      return { actual: [7], quality: 'Good' };
    },
  }).run(p, 'e1');
  assert.equal(report.status, 'invalidated');
  assert.equal(report.results[0].status, 'failed');
  assert.equal(report.results[1].status, 'not-run');
  const before = await fixture({
    isCurrent: () => false,
    read: () => {
      throw Error('must not read');
    },
  }).run(plan(), 'e1');
  assert.equal(before.status, 'invalidated');
});
test('OPC UA accepts anchored native Good status only and keeps Int64 strings intact', async () => {
  const p = plan('opcua');
  p.checks[0].assertion.expected = '9223372036854775807';
  for (const quality of [
    'Good',
    'Good (0x00000000)',
    'Good but bad',
    'Good (0x80000000)',
  ]) {
    const runner = fixture({
      captureTarget: () => ({ ...target, protocol: 'opcua' }),
      read: async () => ({ actual: '9223372036854775807', quality }),
    });
    const report = await runner.run(p, 'e1');
    assert.equal(
      report.status,
      /^Good(?: \(0x00000000\))?$/.test(quality) ? 'passed' : 'failed',
    );
  }
});
test('malformed quality cannot enter persisted evidence, and exceptions from current-session guards invalidate', async () => {
  const runner = fixture({
    read: async () => ({ actual: [7], quality: { bad: true } }),
  });
  const report = await runner.run(plan(), 'e1');
  assert.equal(report.status, 'failed');
  assert.equal(report.results[0].quality, null);
  const invalid = await fixture({
    isCurrent: () => {
      throw Error('endpoint removed');
    },
  }).run(plan(), 'e1');
  assert.equal(invalid.status, 'invalidated');
});
test('private captured target fields cannot be changed during an in-flight read', async () => {
  let finish, observed;
  const original = { ...target, privateState: { generation: 1 } };
  const runner = fixture({
    captureTarget: () => original,
    read: (captured) => {
      observed = captured;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const run = runner.run(plan(), 'e1');
  original.privateState.generation = 2;
  assert.equal(observed.privateState.generation, 1);
  assert(Object.isFrozen(observed.privateState));
  finish({ actual: [7], quality: 'Good' });
  await run;
});

test('persisted passed Modbus scalar evidence is rejected while failed scalar evidence remains representable', async () => {
  const input = plan();
  input.checks[0].assertion.expected = 7;
  const failed = await fixture({
    read: async () => ({ actual: 7, quality: 'Good' }),
  }).run(input, 'e1');
  assert.equal(failed.status, 'failed');
  assert.equal(normalizeAcceptanceReport(failed).results[0].actual, 7);
  const forged = structuredClone(failed);
  forged.status = 'passed';
  forged.results[0].status = 'passed';
  forged.results[0].error = '';
  assert.throws(() => normalizeAcceptanceReport(forged), /Modbus|evidence/);
});
