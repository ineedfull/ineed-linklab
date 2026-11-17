import {
  decodeEngineeringRead,
  verifyEngineeringEvidence,
} from './engineeringAcceptance.js';
import {
  ACCEPTANCE_LIMITS,
  acceptanceId,
  boundedText,
  evaluateAcceptanceAssertion,
  freezeJson,
  jsonClone,
  normalizeAcceptancePlan,
  requireShape,
} from './acceptancePlan.js';

export const isGoodAcceptanceQuality = (quality) =>
  typeof quality === 'string' && /^Good(?: \(0x00000000\))?$/.test(quality);

export function normalizeAcceptanceTarget(input) {
  const target = Object.fromEntries(
    ['endpointId', 'name', 'protocol', 'identity', 'sessionId'].map((key) => [
      key,
      input?.[key],
    ]),
  );
  boundedText(target.endpointId, 'endpoint id', 128);
  boundedText(target.name, 'endpoint name');
  boundedText(target.identity, 'endpoint identity', 2048);
  boundedText(target.sessionId, 'session id', 128);
  if (!['modbus', 'opcua'].includes(target.protocol))
    throw new TypeError('target protocol is invalid');
  // Connection identities supplied by adapters must never include URL userinfo.
  if (/\w+:\/\/[^/\s]*@/.test(target.identity))
    throw new TypeError('target identity contains credentials');
  return target;
}
function normalizeReadPayload(input) {
  const payload = jsonClone(
    input,
    ACCEPTANCE_LIMITS.resultBytes,
    ACCEPTANCE_LIMITS.valueDepth + 1,
  );
  jsonClone(payload.actual, ACCEPTANCE_LIMITS.resultBytes);
  jsonClone(payload.evidence, ACCEPTANCE_LIMITS.resultBytes);
  if (payload.quality !== null && typeof payload.quality !== 'string') {
    throw new Error('Read quality must be a string');
  }
  return payload;
}
function requirePassingRead(protocol, result, check) {
  if (!isGoodAcceptanceQuality(result.quality)) {
    throw new Error('Read quality is missing or not Good');
  }
  if (
    protocol === 'modbus' &&
    !check?.engineering &&
    !Array.isArray(result.actual)
  ) {
    throw new Error('Modbus read must return an array');
  }
}
export function normalizeAcceptanceReport(input) {
  const report = jsonClone(
    input,
    ACCEPTANCE_LIMITS.reportBytes,
    ACCEPTANCE_LIMITS.valueDepth + 5,
  );
  requireShape(
    report,
    ['id', 'plan', 'target', 'startedAt', 'endedAt', 'status', 'results'],
    'report',
  );
  boundedText(report.id, 'report id', 80);
  report.plan = normalizeAcceptancePlan(report.plan);
  requireShape(
    report.target,
    ['endpointId', 'name', 'protocol', 'identity', 'sessionId'],
    'report target',
  );
  normalizeAcceptanceTarget(report.target);
  if (report.target.protocol !== report.plan.protocol)
    throw new TypeError('report protocol mismatch');
  const time = (value) =>
    Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
  if (
    !time(report.startedAt) ||
    !time(report.endedAt) ||
    report.endedAt < report.startedAt ||
    !['passed', 'failed', 'stopped', 'invalidated'].includes(report.status)
  )
    throw new TypeError('report status or time is invalid');
  if (
    !Array.isArray(report.results) ||
    report.results.length !== report.plan.checks.length
  )
    throw new TypeError('report results mismatch');
  for (const [index, result] of report.results.entries()) {
    requireShape(
      result,
      [
        'checkId',
        'status',
        'startedAt',
        'endedAt',
        'actual',
        'quality',
        'evidence',
        'error',
      ],
      'result',
    );
    if (
      result.checkId !== report.plan.checks[index].id ||
      !['passed', 'failed', 'not-run'].includes(result.status) ||
      (result.quality !== null && typeof result.quality !== 'string') ||
      typeof result.error !== 'string' ||
      result.error.length > 2048
    )
      throw new TypeError('result is invalid');
    normalizeReadPayload({
      actual: result.actual,
      quality: result.quality,
      evidence: result.evidence,
    });
    if (result.status === 'not-run') {
      if (
        result.startedAt !== null ||
        result.endedAt !== null ||
        result.actual !== null ||
        result.quality !== null ||
        result.evidence !== null ||
        result.error !== ''
      )
        throw new TypeError('unrun result contains evidence');
    } else if (
      !time(result.startedAt) ||
      !time(result.endedAt) ||
      result.startedAt < report.startedAt ||
      result.endedAt < result.startedAt ||
      result.endedAt > report.endedAt
    )
      throw new TypeError('result time is invalid');
    if (result.status === 'passed')
      requirePassingRead(
        report.plan.protocol,
        result,
        report.plan.checks[index],
      );
    if (result.status === 'passed' && report.plan.checks[index].engineering)
      verifyEngineeringEvidence(report.plan.checks[index], result);
    if (
      result.status === 'passed' &&
      (!isGoodAcceptanceQuality(result.quality) ||
        result.error ||
        !evaluateAcceptanceAssertion(
          report.plan.checks[index].assertion,
          result.actual,
          report.plan.protocol,
          !!report.plan.checks[index].engineering,
        ))
    )
      throw new TypeError('passed result has invalid evidence');
  }
  if (
    report.status === 'passed' &&
    report.results.some((row) => row.status !== 'passed')
  )
    throw new TypeError('passed report contains incomplete checks');
  return report;
}
export function createAcceptanceRunner({
  captureTarget,
  isCurrent,
  read,
  now = Date.now,
  onChange = () => {},
}) {
  const state = { running: false, report: null };
  const listeners = new Set();
  let active = null;
  function publish() {
    onChange(state);
    listeners.forEach((listener) => listener(state));
  }
  function current(target) {
    try {
      return isCurrent(target) === true;
    } catch {
      return false;
    }
  }
  function snapshot(report) {
    state.report = freezeJson(structuredClone(report));
    publish();
  }
  function timestamp() {
    // Keep epoch milliseconds, but never move backwards within one run after
    // NTP/manual clock correction. Every row and finalizer shares this boundary.
    active.lastTimestamp = Math.max(now(), active.lastTimestamp);
    return active.lastTimestamp;
  }
  function finalize(status, message) {
    if (!active || active.report.status !== 'running') return;
    const report = active.report;
    report.status = status;
    report.endedAt = timestamp();
    if (active.index !== null) {
      const row = report.results[active.index];
      row.status = 'failed';
      row.endedAt = report.endedAt;
      row.error = message;
    }
    snapshot(report);
  }
  return {
    state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop() {
      finalize('stopped', 'Stopped by user');
      return state.report;
    },
    async run(input, endpointId) {
      if (active) throw new Error('An acceptance run is already running');
      const plan = freezeJson(normalizeAcceptancePlan(input));
      // A captured target is private to the adapter and runner. Persist only the whitelist.
      const target = freezeJson(
        structuredClone(captureTarget(endpointId, plan.protocol)),
      );
      const metadata = normalizeAcceptanceTarget(target);
      if (
        metadata.endpointId !== endpointId ||
        metadata.protocol !== plan.protocol
      )
        throw new TypeError('captured target does not match the plan');
      const startedAt = now();
      const report = {
        id: acceptanceId(),
        plan,
        target: metadata,
        startedAt,
        endedAt: null,
        status: 'running',
        results: plan.checks.map((check) => ({
          checkId: check.id,
          status: 'not-run',
          startedAt: null,
          endedAt: null,
          actual: null,
          quality: null,
          evidence: null,
          error: '',
        })),
      };
      const run = { report, index: null, lastTimestamp: startedAt };
      active = run;
      state.running = true;
      snapshot(report);
      try {
        for (let i = 0; i < plan.checks.length; i++) {
          if (report.status !== 'running') break;
          if (!current(target)) {
            finalize('invalidated', 'Endpoint session changed');
            break;
          }
          run.index = i;
          const row = report.results[i];
          row.startedAt = timestamp();
          snapshot(report);
          try {
            const response = await read(target, plan.checks[i]);
            if (report.status !== 'running') break;
            if (!current(target)) {
              finalize('invalidated', 'Endpoint session changed');
              break;
            }
            if (!response || !Object.hasOwn(response, 'actual'))
              throw new Error('Read returned no value');
            let payload = normalizeReadPayload({
              actual: response.actual,
              quality: response.quality ?? null,
              evidence: response.evidence ?? null,
            });
            if (plan.checks[i].engineering)
              payload = normalizeReadPayload(
                decodeEngineeringRead(plan.checks[i], payload),
              );
            Object.assign(row, payload);
            requirePassingRead(plan.protocol, row, plan.checks[i]);
            row.status = evaluateAcceptanceAssertion(
              plan.checks[i].assertion,
              row.actual,
              plan.protocol,
              !!plan.checks[i].engineering,
            )
              ? 'passed'
              : 'failed';
            if (row.status === 'failed') row.error = 'Assertion did not match';
          } catch (error) {
            if (report.status !== 'running') break;
            if (!current(target)) {
              finalize('invalidated', 'Endpoint session changed');
              break;
            }
            row.status = 'failed';
            row.error = String(
              error instanceof Error ? error.message : error,
            ).slice(0, 2048);
          }
          row.endedAt = timestamp();
          run.index = null;
          snapshot(report);
        }
        if (report.status === 'running') {
          report.status = report.results.every((row) => row.status === 'passed')
            ? 'passed'
            : 'failed';
          report.endedAt = timestamp();
          snapshot(report);
        }
        return state.report;
      } finally {
        active = null;
        state.running = false;
        publish();
      }
    },
  };
}
