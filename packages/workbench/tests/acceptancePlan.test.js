import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeAcceptancePlan,
  evaluateAcceptanceAssertion,
} from '../src/model/acceptancePlan.js';
import { plan } from './acceptanceFixtures.js';
test('strict plans reject writes, excess keys, address overflow, invalid limits and non-JSON data', () => {
  for (const patch of [
    { functionCode: 6 },
    { address: 65535, quantity: 2 },
    { quantity: 126 },
    { timeoutMs: 99 },
    { unitId: '1' },
  ]) {
    const p = plan();
    Object.assign(p.checks[0].query, patch);
    assert.throws(() => normalizeAcceptancePlan(p));
  }
  for (const change of [
    (p) => {
      p.secret = 'no';
    },
    (p) => {
      p.checks[0].assertion.expected = NaN;
    },
    (p) => {
      p.checks = [];
    },
    (p) => {
      p.checks = Array.from({ length: 26 }, (_, i) => ({
        ...p.checks[0],
        id: `c${i}`,
      }));
    },
  ]) {
    const p = plan();
    change(p);
    assert.throws(() => normalizeAcceptancePlan(p));
  }
  const p = plan();
  const copy = normalizeAcceptancePlan(p);
  p.checks[0].assertion.expected[0] = 8;
  assert.deepEqual(copy.checks[0].assertion.expected, [7]);
});
test('assertions retain JSON types and ranges accept finite numbers only, including one Modbus register', () => {
  assert.equal(
    evaluateAcceptanceAssertion(
      { kind: 'equals', expected: { a: [true, '7'] } },
      { a: [true, '7'] },
    ),
    true,
  );
  assert.equal(
    evaluateAcceptanceAssertion({ kind: 'equals', expected: [7] }, ['7']),
    false,
  );
  const range = { kind: 'range', minimum: 1, maximum: 7 };
  for (const value of ['7', true, null, NaN, Infinity, [1, 7]])
    assert.equal(evaluateAcceptanceAssertion(range, value, 'modbus'), false);
  assert.equal(evaluateAcceptanceAssertion(range, [7], 'modbus'), true);
  assert.equal(evaluateAcceptanceAssertion(range, [7], 'opcua'), false);
  assert.equal(evaluateAcceptanceAssertion(range, 1), true);
  const p = plan();
  p.checks[0].assertion = { ...range, minimum: '1' };
  assert.throws(() => normalizeAcceptancePlan(p));
});

test('object assertions preserve arbitrary JSON keys used in industrial values', () => {
  const input = plan('opcua');
  input.checks[0].assertion.expected = {
    token: 'device-counter',
    secret: false,
  };
  const normalized = normalizeAcceptancePlan(input);
  assert.deepEqual(
    normalized.checks[0].assertion.expected,
    input.checks[0].assertion.expected,
  );
});
