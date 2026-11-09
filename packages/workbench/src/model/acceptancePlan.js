import {
  validateEngineeringCheck,
  engineeringAssertion,
  validEngineeringRange,
} from './engineeringAcceptance.js';
export const ACCEPTANCE_LIMITS = Object.freeze({
  plans: 50,
  checks: 25,
  planBytes: 64 * 1024,
  reports: 20,
  reportBytes: 512 * 1024,
  workspaceBytes: 2 * 1024 * 1024,
  resultBytes: 12 * 1024,
  valueDepth: 32,
});
const encoder = new TextEncoder();
export const jsonBytes = (value) =>
  encoder.encode(JSON.stringify(value)).length;
export function requireShape(value, keys, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new TypeError(`${label} has invalid or unknown fields`);
}
export function boundedText(value, label, maximum = 100) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximum ||
    /\p{Cc}/u.test(value)
  )
    throw new TypeError(`${label} must be bounded nonblank text`);
  return value;
}
export function jsonClone(
  value,
  maxBytes = ACCEPTANCE_LIMITS.workspaceBytes,
  maximumDepth = ACCEPTANCE_LIMITS.valueDepth,
) {
  const active = new Set();
  function visit(item, depth) {
    if (depth > maximumDepth)
      throw new TypeError(`JSON nesting exceeds ${maximumDepth} levels`);
    if (item === null || typeof item === 'string' || typeof item === 'boolean')
      return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (!item || typeof item !== 'object' || active.has(item))
      throw new TypeError('value must be finite JSON');
    if (
      !Array.isArray(item) &&
      ![Object.prototype, null].includes(Object.getPrototypeOf(item))
    )
      throw new TypeError('value must be plain JSON');
    active.add(item);
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) {
        if (!Object.hasOwn(item, i))
          throw new TypeError('sparse arrays are not JSON');
        visit(item[i], depth + 1);
      }
    } else {
      for (const entry of Object.values(item)) {
        visit(entry, depth + 1);
      }
    }
    active.delete(item);
  }
  visit(value, 0);
  if (jsonBytes(value) > maxBytes)
    throw new RangeError(`JSON exceeds ${maxBytes} bytes`);
  return JSON.parse(JSON.stringify(value));
}
function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new TypeError(
      `${label} must be an integer from ${minimum} to ${maximum}`,
    );
}
export function normalizeAcceptancePlan(input) {
  const plan = jsonClone(
    input,
    ACCEPTANCE_LIMITS.planBytes,
    ACCEPTANCE_LIMITS.valueDepth + 4,
  );
  requireShape(plan, ['id', 'name', 'protocol', 'checks'], 'plan');
  boundedText(plan.id, 'plan id', 80);
  boundedText(plan.name, 'plan name');
  if (!['modbus', 'opcua'].includes(plan.protocol))
    throw new TypeError('protocol must be modbus or opcua');
  if (
    !Array.isArray(plan.checks) ||
    !plan.checks.length ||
    plan.checks.length > ACCEPTANCE_LIMITS.checks
  )
    throw new RangeError('plan must have 1 to 25 checks');
  const ids = new Set();
  for (const check of plan.checks) {
    requireShape(
      check,
      [
        'id',
        'name',
        'query',
        'assertion',
        ...(Object.hasOwn(check, 'engineering') ? ['engineering'] : []),
      ],
      'check',
    );
    if (Object.hasOwn(check, 'engineering') && plan.protocol !== 'modbus')
      throw new TypeError('Engineering checks require Modbus');
    boundedText(check.id, 'check id', 80);
    boundedText(check.name, 'check name');
    if (ids.has(check.id)) throw new TypeError('duplicate check id');
    ids.add(check.id);
    if (plan.protocol === 'modbus') {
      requireShape(
        check.query,
        ['unitId', 'functionCode', 'address', 'quantity', 'timeoutMs'],
        'Modbus query',
      );
      const q = check.query;
      integer(q.unitId, 1, 247, 'unitId');
      if (![1, 2, 3, 4].includes(q.functionCode))
        throw new TypeError('only read function codes 1/2/3/4 are allowed');
      integer(q.address, 0, 65535, 'address');
      integer(q.quantity, 1, q.functionCode <= 2 ? 2000 : 125, 'quantity');
      if (q.address + q.quantity > 65536)
        throw new RangeError('Modbus address range exceeds 65535');
      integer(q.timeoutMs, 100, 30000, 'timeoutMs');
    } else {
      requireShape(check.query, ['nodeId'], 'OPC UA query');
      boundedText(check.query.nodeId, 'nodeId', 4096);
    }
    if (Object.hasOwn(check, 'engineering')) validateEngineeringCheck(check);
    const a = check.assertion;
    if (a?.kind === 'equals') {
      requireShape(a, ['kind', 'expected'], 'equals assertion');
      jsonClone(a.expected, ACCEPTANCE_LIMITS.planBytes);
    } else if (a?.kind === 'range') {
      requireShape(a, ['kind', 'minimum', 'maximum'], 'range assertion');
      if (
        check.engineering
          ? !validEngineeringRange(a)
          : typeof a.minimum !== 'number' ||
            !Number.isFinite(a.minimum) ||
            typeof a.maximum !== 'number' ||
            !Number.isFinite(a.maximum) ||
            a.minimum > a.maximum
      )
        throw new TypeError('range requires finite ordered numbers');
    } else throw new TypeError('assertion kind must be equals or range');
  }
  return plan;
}
export function evaluateAcceptanceAssertion(
  assertion,
  actual,
  protocol,
  engineering = false,
) {
  if (engineering) return engineeringAssertion(assertion, actual);
  if (assertion.kind === 'range') {
    const value =
      protocol === 'modbus' && Array.isArray(actual) && actual.length === 1
        ? actual[0]
        : actual;
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= assertion.minimum &&
      value <= assertion.maximum
    );
  }
  return equalJson(assertion.expected, actual);
}
function equalJson(a, b) {
  if (a === b) return true;
  if (
    a === null ||
    b === null ||
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && equalJson(a[key], b[key]))
  );
}
export function freezeJson(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeJson);
    Object.freeze(value);
  }
  return value;
}
export function acceptanceId() {
  return globalThis.crypto.randomUUID();
}
