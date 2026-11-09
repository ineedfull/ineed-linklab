import {
  normalizeModbusRequest,
  validateModbusRequestGroups,
} from './modbusMasterConfig.js';
import { decodeModbusMasterPoint } from './modbusMasterDataPoints.js';
import {
  compareDecimalFractions,
  parseDecimalFraction,
} from './modbusDecimal.js';

export function sameJson(left, right) {
  if (left === right) return true;
  if (
    !left ||
    !right ||
    typeof left !== 'object' ||
    typeof right !== 'object' ||
    Array.isArray(left) !== Array.isArray(right)
  )
    return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]),
    )
  );
}
export function validateEngineeringCheck(check) {
  const e = check.engineering;
  if (
    !e ||
    typeof e !== 'object' ||
    Object.keys(e).sort().join() !== 'point,template'
  )
    throw new TypeError('Invalid engineering configuration');
  const t = e.template;
  if (
    !t ||
    Object.keys(t).sort().join() !== 'id,model,version' ||
    typeof t.id !== 'string' ||
    !t.id ||
    t.id.length > 80 ||
    typeof t.model !== 'string' ||
    !t.model.trim() ||
    t.model.length > 100 ||
    !Number.isSafeInteger(t.version) ||
    t.version < 1
  )
    throw new TypeError('Invalid template snapshot');
  if (
    check.assertion?.kind === 'range' &&
    ['boolean', 'string'].includes(e.point?.dataType)
  )
    throw new TypeError('范围条件需要数值点位');
  const request = normalizeModbusRequest({
    id: 'r',
    name: 'r',
    functionCode: check.query.functionCode,
    startAddress: check.query.address,
    quantity: check.query.quantity,
    dataPoints: [e.point],
  });
  if (
    !sameJson(request.dataPoints[0], e.point) ||
    e.point.enabled !== true ||
    Object.keys(
      validateModbusRequestGroups([
        { id: 'g', name: 'g', unitId: check.query.unitId, requests: [request] },
      ]),
    ).length
  )
    throw new TypeError('Invalid engineering point');
}
export function decodeEngineeringRead(check, payload) {
  if (
    !Array.isArray(payload.actual) ||
    payload.actual.length !== check.query.quantity ||
    payload.actual.some((value) =>
      check.query.functionCode <= 2
        ? typeof value !== 'boolean'
        : !Number.isInteger(value) || value < 0 || value > 65535,
    )
  )
    throw new TypeError('Invalid raw Modbus measurement');
  const reading = decodeModbusMasterPoint(
    check.engineering.point,
    payload.actual,
    check.query.functionCode,
  );
  return {
    actual: reading.value,
    quality:
      payload.quality === 'Good' || payload.quality === 'Good (0x00000000)'
        ? reading.quality === 'good'
          ? 'Good'
          : reading.quality
        : payload.quality,
    evidence: {
      transport: payload.evidence,
      engineering: {
        raw: payload.actual,
        transportQuality: payload.quality,
        point: check.engineering.point,
        template: check.engineering.template,
        decodeQuality: reading.quality,
        reason: reading.reason,
        display: reading.display,
      },
    },
  };
}
export function validEngineeringRange(assertion) {
  const valid = (value) =>
    ((typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && value.length <= 1024)) &&
    parseDecimalFraction(value) !== null;
  return (
    valid(assertion.minimum) &&
    valid(assertion.maximum) &&
    compareDecimalFractions(
      parseDecimalFraction(assertion.minimum),
      parseDecimalFraction(assertion.maximum),
    ) <= 0
  );
}
export function engineeringAssertion(assertion, value) {
  if (assertion.kind !== 'range') return assertion.expected === value;
  const actual = parseDecimalFraction(value),
    min = parseDecimalFraction(assertion.minimum),
    max = parseDecimalFraction(assertion.maximum);
  return (
    actual !== null &&
    min !== null &&
    max !== null &&
    compareDecimalFractions(actual, min) >= 0 &&
    compareDecimalFractions(actual, max) <= 0
  );
}
export function verifyEngineeringEvidence(check, row) {
  const evidence = row.evidence?.engineering;
  if (!evidence || !Array.isArray(evidence.raw))
    throw new TypeError('Missing engineering raw evidence');
  const replay = decodeEngineeringRead(check, {
    actual: evidence.raw,
    quality: evidence.transportQuality,
    evidence: row.evidence.transport,
  });
  if (
    !sameJson(replay.actual, row.actual) ||
    !sameJson(replay.evidence.engineering, evidence) ||
    replay.quality !== row.quality
  )
    throw new TypeError('Engineering evidence does not reproduce measurement');
}
