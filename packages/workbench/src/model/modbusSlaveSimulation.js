import {
  normalizeModbusDataPoints, readModbusDataPoint, writeModbusDataPoint,
} from './modbusDataPoints.js';

const NUMERIC_TYPES = new Set(['uint16', 'int16', 'uint32', 'int32', 'float32', 'float64']);
export const numericSimulationPoints = (points) => normalizeModbusDataPoints(points)
  .filter((point) => NUMERIC_TYPES.has(point.dataType));
const signature = (points) => JSON.stringify(normalizeModbusDataPoints(points));

function finiteNumber(value, label) {
  if (String(value ?? '').trim() === '' || !Number.isFinite(Number(value))) {
    throw new Error(`${label}必须是有限数字。`);
  }
  return Number(value);
}

// Validate business values through the same codec used for manual writes. This
// checks scale/order, integer ranges and float32 overflow before any native write.
export function validateSimulationSettings(points, settings) {
  const intervalMs = finiteNumber(settings.intervalMs, '变化间隔');
  if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 3_600_000) {
    throw new Error('变化间隔必须为 100 到 3600000 毫秒的整数。');
  }
  const available = new Map(numericSimulationPoints(points).map((point) => [point.id, point]));
  const seen = new Set();
  const rules = (settings.rules ?? []).map((source) => {
    const point = available.get(source.pointId);
    if (!point || seen.has(point.id)) throw new Error('请选择有效且不重复的数值点位。');
    seen.add(point.id);
    const min = finiteNumber(source.min, `${point.name}下限`);
    const max = finiteNumber(source.max, `${point.name}上限`);
    const step = finiteNumber(source.step, `${point.name}步长`);
    if (!(min < max) || !(step > 0) || step > max - min) {
      throw new Error(`${point.name}需满足下限 < 上限，步长 > 0 且不超过范围。`);
    }
    if (!point.dataType.startsWith('float')) requireRawInteger(step / point.scale, point.name);
    const first = encodeValue(point, min);
    encodeValue(point, max);
    const second = encodeValue(point, min + step);
    if (min + step === min || max + step === max
      || first.every((word, index) => word === second[index])) {
      throw new Error(`${point.name}步长过小，寄存器无法表达变化。`);
    }
    return { pointId: point.id, min, max, step };
  });
  if (!rules.length) throw new Error('请至少勾选一个数值点位。');
  return { intervalMs, rules };
}

function requireRawInteger(raw, name) {
  const nearest = Math.round(raw);
  if (!Number.isFinite(raw) || Math.abs(raw - nearest) > Math.max(1, Math.abs(raw)) * Number.EPSILON * 4) {
    throw new Error(`${name}的范围和步长必须能由整数寄存器表达。`);
  }
  return nearest;
}

function encodeValue(point, value) {
  // Decimal scales such as 0.1 can produce 3.0000000000000004 in JS.
  // Validate near-integers and pass raw integers through the existing codec;
  // never round a genuinely fractional register value into a different value.
  const integerPoint = !point.dataType.startsWith('float');
  const raw = integerPoint ? requireRawInteger((value - point.offset) / point.scale, point.name) : value;
  const words = writeModbusDataPoint(integerPoint ? { ...point, scale: 1, offset: 0 } : point, raw);
  const decoded = readModbusDataPoint(point, {
    areas: { [point.area]: { start: point.address, values: words } },
  }).value;
  if (!Number.isFinite(decoded)) throw new Error(`${point.name}超出可编码的数值范围。`);
  return words;
}

export function createModbusSlaveSimulation({ writeMap, timers = globalThis }) {
  const states = new Map();
  const jobs = new Map();
  const queues = new Map();
  const listeners = new Set();
  let disposed = false;
  const publish = () => {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* UI observers do not own simulation scheduling. */ }
    }
  };
  const current = (job) => !disposed && jobs.get(job.endpointId) === job;

  function getStatus(endpointId) {
    const state = states.get(endpointId);
    return { active: jobs.has(endpointId), error: state?.error ?? '',
      settings: state?.settings ? structuredClone(state.settings) : null };
  }
  function configure(endpointId, points, settings) {
    if (disposed) throw new Error('工作台已关闭。');
    const validated = validateSimulationSettings(points, settings);
    stop(endpointId);
    states.set(endpointId, { settings: validated, signature: signature(points), error: '' });
    publish();
  }
  function stop(endpointId) {
    const job = jobs.get(endpointId);
    if (!job) return;
    jobs.delete(endpointId);
    if (job.timer !== null) timers.clearTimeout(job.timer);
    publish();
  }
  function start({ endpointId, sessionId, points }) {
    if (disposed || !sessionId) throw new Error('请先打开从站。');
    const state = states.get(endpointId);
    if (!state?.settings || state.signature !== signature(points)) throw new Error('请先配置自动变化点位。');
    stop(endpointId);
    const pointMap = new Map(numericSimulationPoints(points).map((point) => [point.id, point]));
    const job = { endpointId, sessionId, timer: null, settings: state.settings,
      rules: state.settings.rules.map((rule) => ({ ...rule, point: pointMap.get(rule.pointId), index: 0, value: rule.min })) };
    jobs.set(endpointId, job);
    state.error = '';
    publish();
    schedule(job, 0);
  }
  function schedule(job, delay) {
    if (!current(job)) return;
    job.timer = timers.setTimeout(() => {
      job.timer = null;
      // A stopped job may still have an IPC in flight. Wait for it before a
      // replacement starts, and check job/session identity before every write.
      const work = (queues.get(job.endpointId) ?? Promise.resolve()).then(() => tick(job));
      queues.set(job.endpointId, work);
      void work.finally(() => {
        if (queues.get(job.endpointId) === work) queues.delete(job.endpointId);
      });
    }, delay);
  }
  async function tick(job) {
    try {
      for (const rule of job.rules) {
        if (!current(job)) return;
        await writeMap({ endpointId: job.endpointId, expectedSessionId: job.sessionId,
          area: rule.point.area, address: rule.point.address, values: encodeValue(rule.point, rule.value) });
        // Keep the unrounded business value as the accumulator, rather than
        // accumulating the register codec's float32 rounding error.
        rule.index += 1;
        const next = rule.min + rule.index * rule.step;
        const tolerance = Math.max(Math.abs(next), Math.abs(rule.max)) * Number.EPSILON * 4;
        if (!Number.isFinite(next) || next - rule.max > tolerance) {
          rule.index = 0;
          rule.value = rule.min;
        } else rule.value = Math.min(next, rule.max);
      }
      schedule(job, job.settings.intervalMs);
    } catch (error) {
      if (!current(job)) return;
      states.get(job.endpointId).error = error instanceof Error ? error.message : String(error);
      stop(job.endpointId);
    }
  }
  function reconcile({ endpoints = [], operations = new Map(), statuses = new Map(), reset = false } = {}) {
    const endpointsById = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint]));
    for (const endpointId of states.keys()) {
      const endpoint = endpointsById.get(endpointId);
      if (reset || !endpoint || !/^modbus-(tcp|rtu)-slave$/.test(endpoint.transport)
        || states.get(endpointId).signature !== signature(endpoint.config.dataPoints)) {
        stop(endpointId);
        states.delete(endpointId);
        publish();
      }
    }
    for (const [endpointId, job] of jobs) {
      if (operations.get(endpointId)?.sessionId !== job.sessionId
        || ['closed', 'closing', 'error'].includes(statuses.get(endpointId)?.status)) stop(endpointId);
    }
  }
  return { getStatus, configure, start, stop, reconcile,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { disposed = true; for (const id of jobs.keys()) stop(id); states.clear(); listeners.clear(); },
  };
}
