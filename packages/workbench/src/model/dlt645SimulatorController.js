import {
  DLT645_READ_CONTROL, buildDlt645ErrorResponse, buildDlt645ReadResponse,
  extractDlt645Frames, parseDlt645Frame,
} from '@ineed-linklab/codecs/dlt645.js';

import { normalizeDlt645SimulatorConfig } from './dlt645SimulatorConfig.js';
import { appendDlt645Transaction, failDlt645Transaction } from './dlt645Transactions.js';

// A connection owns protocol consumption. Views only subscribe to diagnostics;
// mounting a view must never replay retained requests onto the wire.
export function createDlt645SimulatorController({ endpointId, send, timers = globalThis }) {
  let config = normalizeDlt645SimulatorConfig({});
  let sessionId = null;
  let running = false;
  let disposed = false;
  let generation = 0;
  let remainder = new Uint8Array();
  let resynchronizing = false;
  let queue = Promise.resolve();
  const waits = new Map();
  const listeners = new Set();
  const processed = new WeakSet();
  const state = {
    transactions: [], statistics: { requests: 0, responses: 0, errors: 0 },
    itemActivity: new Map(), meterErrors: new Map(),
  };

  function notify() { for (const listener of listeners) listener(snapshot()); }
  function snapshot() {
    return { transactions: state.transactions, statistics: { ...state.statistics },
      itemActivity: new Map(state.itemActivity), meterErrors: new Map(state.meterErrors) };
  }
  function invalidate() {
    generation += 1;
    remainder = new Uint8Array();
    resynchronizing = false;
    queue = Promise.resolve();
    for (const [timerId, resolve] of waits) { timers.clearTimeout(timerId); resolve(); }
    waits.clear();
  }
  function reconcile(next) {
    if (disposed) return;
    const nextRunning = next.running === true && typeof next.sessionId === 'string';
    if (sessionId !== next.sessionId || running !== nextRunning) invalidate();
    sessionId = next.sessionId;
    running = nextRunning;
    config = normalizeDlt645SimulatorConfig(next.config);
  }
  function current(captured) {
    return !disposed && running && captured.generation === generation && captured.sessionId === sessionId;
  }
  function record(parsed, direction, createdAt) {
    state.transactions = appendDlt645Transaction(state.transactions, { parsed, direction, createdAt }, 200).transactions;
  }
  function consume(frames, { respond = true } = {}) {
    if (disposed) return;
    for (const frame of frames) {
      if (processed.has(frame)) continue;
      processed.add(frame);
      if (frame.endpointId !== endpointId || frame.sessionId !== sessionId || !running) continue;
      if (frame.direction === 'out') {
        try { record(parseDlt645Frame(frame.bytes), 'out', frame.createdAt); } catch { /* Raw serial frame. */ }
        continue;
      }
      const extracted = extractDlt645Frames(Uint8Array.of(...remainder, ...frame.bytes), { resynchronizing });
      remainder = new Uint8Array(extracted.remainder);
      resynchronizing = extracted.resynchronizing;
      for (const parsed of extracted.frames) {
        record(parsed, 'in', frame.createdAt);
        if (!respond || parsed.response) continue;
        const captured = { generation, sessionId, config };
        queue = queue.then(() => handleRequest(parsed, frame.createdAt, captured));
      }
    }
    notify();
  }
  function delay(milliseconds) {
    return new Promise((resolve) => {
      const timerId = timers.setTimeout(() => { waits.delete(timerId); resolve(); }, milliseconds);
      waits.set(timerId, resolve);
    });
  }
  async function handleRequest(parsed, createdAt, captured) {
    if (!current(captured) || parsed.functionCode !== DLT645_READ_CONTROL) return;
    const meter = captured.config.meters.find((candidate) => candidate.enabled && candidate.address === parsed.address);
    if (!meter) return;
    const item = meter.tasks.find((candidate) => candidate.enabled && candidate.identifier === parsed.dataIdentifier);
    state.statistics.requests += 1;
    notify();
    try {
      const bytes = item ? buildDlt645ReadResponse({ address: meter.address,
        dataIdentifier: item.identifier, value: item.value, decimals: item.decimals,
        byteLength: item.byteLength, signed: item.signed, wakeUpBytes: captured.config.wakeUpBytes,
      }) : buildDlt645ErrorResponse({ address: meter.address, requestControl: parsed.functionCode,
        errorCode: 0x02, wakeUpBytes: captured.config.wakeUpBytes });
      if (captured.config.responseDelayMs > 0) await delay(captured.config.responseDelayMs);
      if (!current(captured)) return;
      const result = await send({ endpointId, bytes,
        target: { endpointId, expectedSessionId: captured.sessionId }, framing: 'dlt645' });
      if (!current(captured)) return;
      if (result?.ok !== true) throw new Error(result?.error?.message ?? '响应发送失败');
      state.statistics.responses += 1;
      state.meterErrors.delete(meter.id);
      if (item) {
        const key = `${meter.id}:${item.id}`;
        const previous = state.itemActivity.get(key) ?? { reads: 0, lastReadAt: null };
        state.itemActivity.set(key, { reads: previous.reads + 1, lastReadAt: createdAt });
      } else { state.statistics.errors += 1; }
    } catch (error) {
      if (!current(captured)) return;
      const message = error instanceof Error ? error.message : String(error);
      state.statistics.errors += 1;
      state.meterErrors.set(meter.id, message);
      state.transactions = failDlt645Transaction(state.transactions, parsed, message).transactions;
    }
    notify();
  }
  return {
    reconcile, consume, snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { if (disposed) return; disposed = true; invalidate(); listeners.clear(); },
  };
}

export function createDlt645SimulatorManager({ send, timers }) {
  const controllers = new Map();
  function dispose() { for (const controller of controllers.values()) controller.dispose(); controllers.clear(); }
  return {
    reconcile({ endpoints, operations, statuses, reset, disposed }) {
      if (reset || disposed) { dispose(); return; }
      const simulators = endpoints.filter((endpoint) => endpoint.transport === 'dlt645-slave');
      const ids = new Set(simulators.map((endpoint) => endpoint.id));
      for (const [id, controller] of controllers) {
        if (!ids.has(id)) { controller.dispose(); controllers.delete(id); }
      }
      for (const endpoint of simulators) {
        if (!controllers.has(endpoint.id)) controllers.set(endpoint.id,
          createDlt645SimulatorController({ endpointId: endpoint.id, send, ...(timers ? { timers } : {}) }));
        const operation = operations.get(endpoint.id);
        const status = statuses.get(endpoint.id)?.status;
        controllers.get(endpoint.id).reconcile({ config: endpoint.config, sessionId: operation?.sessionId ?? null,
          running: Boolean(operation?.sessionId) && !['closed', 'closing', 'error'].includes(status) });
      }
    },
    consume(event) { controllers.get(event.endpointId)?.consume(event.frames); },
    forEndpoint(id) { return controllers.get(id) ?? null; },
    dispose,
  };
}
