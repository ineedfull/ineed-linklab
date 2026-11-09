import { createUnavailableRuntimeAdapter } from '@ineed-linklab/runtime-contract';
import {
  normalizeFrameWireBatch,
  normalizeStatusWireEvent,
} from '@ineed-linklab/runtime-contract';

const invoke = (bridgeMethod) => async (...args) => {
  const response = await bridgeMethod(...args);
  if (response?.ok === true) return response.value;
  if (response?.ok === false && response.error) {
    const details = response.error;
    const error = new Error(details.message);
    error.name = details.name;
    error.method = details.method;
    error.runtimeName = details.runtimeName;
    if (details.code) error.code = details.code;
    throw error;
  }

  const error = new Error('Invalid Electron IPC response');
  error.name = 'IpcResponseError';
  error.code = 'INVALID_IPC_RESPONSE';
  throw error;
};

const defaultReporter = (error) => {
  console.error('[Ineed LinkLab] Electron event payload rejected', error);
};

const reportSafely = (reporter, error) => {
  try {
    reporter(error);
  } catch {
    // Reporting must not disrupt the runtime event loop.
  }
};

const invalidEventPayloadError = (reason, method, eventName, runtimeName) => {
  const error = new Error(`Invalid event payload for ${method}`, { cause: reason });
  error.name = 'RuntimeEventPayloadError';
  error.code = 'INVALID_EVENT_PAYLOAD';
  error.method = method;
  error.eventName = eventName;
  error.runtimeName = runtimeName;
  return error;
};

const subscribeNormalized = (
  subscribe, fallback, reporter, method, eventName, runtimeName, normalize,
) => (
  typeof subscribe === 'function'
    ? (listener) => subscribe((payload) => {
      let normalized;
      try {
        normalized = normalize(payload);
      } catch (reason) {
        reportSafely(
          reporter,
          invalidEventPayloadError(reason, method, eventName, runtimeName),
        );
        return;
      }
      listener(normalized);
    })
    : fallback
);

export function createElectronRuntimeAdapter(bridge, reporter = defaultReporter) {
  const fallback = createUnavailableRuntimeAdapter(bridge.runtimeName);
  const invokeOr = (bridgeMethod, fallbackMethod) => (
    typeof bridgeMethod === 'function' ? invoke(bridgeMethod) : fallbackMethod
  );
  return {
    runtimeName: bridge.runtimeName,
    stomp: {
      execute: invokeOr(bridge.stomp?.execute, fallback.stomp.execute),
      onEvent: bridge.stomp?.onEvent ?? fallback.stomp.onEvent,
    },
    opcua: {
      execute: invokeOr(bridge.opcua?.execute, fallback.opcua.execute),
      onEvent: bridge.opcua?.onEvent ?? fallback.opcua.onEvent,
    },
    endpoint: {
      list: invokeOr(bridge.endpoint?.list, fallback.endpoint.list),
      save: invokeOr(bridge.endpoint?.save, fallback.endpoint.save),
      clone: invokeOr(bridge.endpoint?.clone, fallback.endpoint.clone),
      delete: invokeOr(bridge.endpoint?.delete, fallback.endpoint.delete),
    },
    transport: {
      scanSerialPorts: invokeOr(bridge.transport?.scanSerialPorts, fallback.transport.scanSerialPorts),
      open: invokeOr(bridge.transport?.open, fallback.transport.open),
      cancelOpen: invokeOr(bridge.transport?.cancelOpen, fallback.transport.cancelOpen),
      close: invokeOr(bridge.transport?.close, fallback.transport.close),
      send: invokeOr(bridge.transport?.send, fallback.transport.send),
      disconnectPeer: invokeOr(bridge.transport?.disconnectPeer, fallback.transport.disconnectPeer),
      onPersistenceWarning: bridge.transport?.onPersistenceWarning,
      onFrames: subscribeNormalized(
        bridge.transport?.onFrames,
        fallback.transport.onFrames,
        reporter,
        'transport.onFrames',
        'transport:frames',
        bridge.runtimeName,
        normalizeFrameWireBatch,
      ),
      onStatus: subscribeNormalized(
        bridge.transport?.onStatus,
        fallback.transport.onStatus,
        reporter,
        'transport.onStatus',
        'transport:status',
        bridge.runtimeName,
        normalizeStatusWireEvent,
      ),
      onPeers: bridge.transport?.onPeers ?? fallback.transport.onPeers,
    },
    modbus: {
      execute: invokeOr(bridge.modbus?.execute, fallback.modbus.execute),
      readMap: invokeOr(bridge.modbus?.readMap, fallback.modbus.readMap),
      writeMap: invokeOr(bridge.modbus?.writeMap, fallback.modbus.writeMap),
      onTransactions: bridge.modbus?.onTransactions ?? fallback.modbus.onTransactions,
    },
    modbusHistory: {
      recordBatch: invokeOr(bridge.modbusHistory?.recordBatch, fallback.modbusHistory.recordBatch),
      querySeries: invokeOr(bridge.modbusHistory?.querySeries, fallback.modbusHistory.querySeries),
      queryRows: invokeOr(bridge.modbusHistory?.queryRows, fallback.modbusHistory.queryRows),
      exportCsv: invokeOr(bridge.modbusHistory?.exportCsv, fallback.modbusHistory.exportCsv),
      clear: invokeOr(bridge.modbusHistory?.clear, fallback.modbusHistory.clear),
      cleanup: invokeOr(bridge.modbusHistory?.cleanup, fallback.modbusHistory.cleanup),
      flush: invokeOr(bridge.modbusHistory?.flush, fallback.modbusHistory.flush),
    },
    history: {
      queryFrames: invokeOr(bridge.history?.queryFrames, fallback.history.queryFrames),
      queryLogs: invokeOr(bridge.history?.queryLogs, fallback.history.queryLogs),
      delete: invokeOr(bridge.history?.delete, fallback.history.delete),
      clear: invokeOr(bridge.history?.clear, fallback.history.clear),
    },
    template: {
      list: invokeOr(bridge.template?.list, fallback.template.list),
      save: invokeOr(bridge.template?.save, fallback.template.save),
      delete: invokeOr(bridge.template?.delete, fallback.template.delete),
    },
    sendHistory: {
      record: invokeOr(bridge.sendHistory?.record, fallback.sendHistory.record),
      query: invokeOr(bridge.sendHistory?.query, fallback.sendHistory.query),
      delete: invokeOr(bridge.sendHistory?.delete, fallback.sendHistory.delete),
      clear: invokeOr(bridge.sendHistory?.clear, fallback.sendHistory.clear),
    },
    settings: {
      getAll: invokeOr(bridge.settings?.getAll, fallback.settings.getAll),
      save: invokeOr(bridge.settings?.save, fallback.settings.save),
      saveAll: invokeOr(bridge.settings?.saveAll, fallback.settings.saveAll),
    },
    workspace: {
      export: invokeOr(bridge.workspace?.export, fallback.workspace.export),
      import: invokeOr(bridge.workspace?.import, fallback.workspace.import),
    },
    storage: {
      stats: invokeOr(bridge.storage?.stats, fallback.storage.stats),
      clearHistory: invokeOr(bridge.storage?.clearHistory, fallback.storage.clearHistory),
    },
    window: {
      openHistory: invokeOr(bridge.window?.openHistory, fallback.window.openHistory),
      openWebsite: bridge.window?.openWebsite ? invokeOr(bridge.window.openWebsite) : undefined,
    },
    lifecycle: {
      onBeforeShutdown: bridge.lifecycle?.onBeforeShutdown ?? fallback.lifecycle.onBeforeShutdown,
      readyForShutdown: invokeOr(
        bridge.lifecycle?.readyForShutdown,
        fallback.lifecycle.readyForShutdown,
      ),
    },
  };
}
