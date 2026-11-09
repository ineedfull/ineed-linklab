import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';
import {
  normalizeFrameWireBatch,
  normalizeStatusWireEvent,
} from '@ineed-linklab/runtime-contract';

const RUNTIME_NAME = 'tauri';

const detailsFrom = (reason) => {
  if (typeof reason === 'string') return { message: reason };
  if (reason && typeof reason === 'object') return reason;
  return {};
};

const boundaryError = (reason, fallbackName, fallbackMessage, fallbackCode, metadata) => {
  const details = detailsFrom(reason);
  const error = new Error(details.message || fallbackMessage, { cause: reason });
  error.name = details.name || fallbackName;
  error.code = details.code || fallbackCode;
  Object.assign(error, metadata);
  return error;
};

const command = (api, commandName, method, serialize = args => ({ args })) => async (...args) => {
  let response;
  try {
    response = await api.invoke(commandName, serialize(args));
  } catch (reason) {
    throw boundaryError(
      reason,
      'TauriInvokeError',
      `Tauri invoke failed for ${method}`,
      'TAURI_INVOKE_FAILED',
      { method, runtimeName: RUNTIME_NAME, command: commandName },
    );
  }
  if (response?.ok === true) return response.value;
  if (response?.ok === false && response.error) {
    const details = response.error;
    const error = new Error(details.message);
    error.name = details.name;
    error.method = details.method;
    error.runtimeName = details.runtimeName;
    error.code = details.code;
    throw error;
  }

  const error = new Error(`Invalid Tauri command response for ${commandName}`);
  error.name = 'TauriResponseError';
  error.code = 'INVALID_TAURI_RESPONSE';
  throw error;
};

const defaultReporter = (error) => {
  console.error('[Ineed LinkLab] Tauri runtime boundary error', error);
};

const reportSafely = (reporter, error) => {
  try {
    reporter(error);
  } catch {
    // Reporting must not disrupt the runtime event loop.
  }
};

const invalidEventPayloadError = (reason, method, eventName) => {
  const error = boundaryError(
    reason,
    'RuntimeEventPayloadError',
    `Invalid event payload for ${method}`,
    'INVALID_EVENT_PAYLOAD',
    { method, runtimeName: RUNTIME_NAME, eventName },
  );
  error.name = 'RuntimeEventPayloadError';
  error.code = 'INVALID_EVENT_PAYLOAD';
  return error;
};

const subscribe = (api, reporter, method, eventName, normalize = (value) => value) => (callback) => {
  let stopped = false;
  let stopPromise;
  const registration = Promise.resolve().then(() => api.listen(eventName, (event) => {
    if (stopped) return;
    let normalized;
    try {
      normalized = normalize(event.payload);
    } catch (reason) {
      reportSafely(reporter, invalidEventPayloadError(reason, method, eventName));
      return;
    }
    callback(normalized);
  }));
  registration.catch((reason) => {
    const error = boundaryError(
      reason,
      'TauriListenError',
      `Tauri listener registration failed for ${method}`,
      'TAURI_LISTEN_FAILED',
      { method, runtimeName: RUNTIME_NAME, eventName },
    );
    error.name = 'TauriListenError';
    reportSafely(reporter, error);
  });

  return () => {
    stopPromise ??= (async () => {
      stopped = true;
      try {
        const unlisten = await registration;
        await unlisten();
      } catch {
        // A failed registration has no listener to remove.
      }
    })();
    return stopPromise;
  };
};

export function createTauriRuntimeAdapter(
  api = { invoke: tauriInvoke, listen: tauriListen },
  reporter = defaultReporter,
) {
  return {
    runtimeName: RUNTIME_NAME,
    stomp: {
      execute: command(api, 'stomp_execute', 'stomp.execute', args => ({ request: {
        ...args[0],
        ...(args[0]?.bytes instanceof Uint8Array ? { bytes: [...args[0].bytes] } : {}),
      } })),
      onEvent: subscribe(api, reporter, 'stomp.onEvent', 'stomp:event'),
    },
    opcua: {
      execute: command(api, 'opcua_execute', 'opcua.execute', args => ({ request: args[0] })),
      onEvent: subscribe(api, reporter, 'opcua.onEvent', 'opcua:event'),
    },
    endpoint: {
      list: command(api, 'endpoint_list', 'endpoint.list'),
      save: command(api, 'endpoint_save', 'endpoint.save'),
      clone: command(api, 'endpoint_clone', 'endpoint.clone'),
      delete: command(api, 'endpoint_delete', 'endpoint.delete'),
    },
    transport: {
      scanSerialPorts: command(api, 'transport_scan_serial_ports', 'transport.scanSerialPorts'),
      open: command(api, 'transport_open', 'transport.open'),
      cancelOpen: command(api, 'transport_cancel_open', 'transport.cancelOpen'),
      close: command(api, 'transport_close', 'transport.close'),
      send: sendCommand(api),
      disconnectPeer: command(api, 'transport_disconnect_peer', 'transport.disconnectPeer'),
      onFrames: subscribe(
        api, reporter, 'transport.onFrames', 'transport:frames', normalizeFrameWireBatch,
      ),
      onStatus: subscribe(
        api, reporter, 'transport.onStatus', 'transport:status', normalizeStatusWireEvent,
      ),
      onPeers: subscribe(api, reporter, 'transport.onPeers', 'transport:peers'),
    },
    modbus: {
      execute: command(api, 'modbus_execute', 'modbus.execute'),
      readMap: command(api, 'modbus_read_map', 'modbus.readMap'),
      writeMap: command(api, 'modbus_write_map', 'modbus.writeMap'),
      onTransactions: subscribe(api, reporter, 'modbus.onTransactions', 'modbus:transaction'),
    },
    modbusHistory: {
      recordBatch: command(api, 'modbus_history_record_batch', 'modbusHistory.recordBatch'),
      querySeries: command(api, 'modbus_history_query_series', 'modbusHistory.querySeries'),
      queryRows: command(api, 'modbus_history_query_rows', 'modbusHistory.queryRows'),
      exportCsv: command(api, 'modbus_history_export_csv', 'modbusHistory.exportCsv'),
      clear: command(api, 'modbus_history_clear', 'modbusHistory.clear'),
      cleanup: command(api, 'modbus_history_cleanup', 'modbusHistory.cleanup'),
      flush: command(api, 'modbus_history_flush', 'modbusHistory.flush'),
    },
    history: {
      queryFrames: command(api, 'history_query_frames', 'history.queryFrames'),
      queryLogs: command(api, 'history_query_logs', 'history.queryLogs'),
      delete: command(api, 'history_delete', 'history.delete'),
      clear: command(api, 'history_clear', 'history.clear'),
    },
    template: {
      list: command(api, 'template_list', 'template.list'),
      save: command(api, 'template_save', 'template.save'),
      delete: command(api, 'template_delete', 'template.delete'),
    },
    sendHistory: {
      record: command(api, 'send_history_record', 'sendHistory.record'),
      query: command(api, 'send_history_query', 'sendHistory.query'),
      delete: command(api, 'send_history_delete', 'sendHistory.delete'),
      clear: command(api, 'send_history_clear', 'sendHistory.clear'),
    },
    settings: {
      getAll: command(api, 'settings_get_all', 'settings.getAll'),
      save: command(api, 'settings_save', 'settings.save'),
      saveAll: command(api, 'settings_save_all', 'settings.saveAll'),
    },
    workspace: createWorkspaceCommands(api),
    storage: {
      stats: command(api, 'storage_stats', 'storage.stats'),
      clearHistory: command(api, 'storage_clear_history', 'storage.clearHistory'),
    },
    window: {
      openHistory: command(api, 'window_open_history', 'window.openHistory'),
      openWebsite: command(api, 'window_open_website', 'window.openWebsite'),
    },
    lifecycle: {
      onBeforeShutdown: subscribe(
        api, reporter, 'lifecycle.onBeforeShutdown', 'lifecycle:before-shutdown',
      ),
      readyForShutdown: command(
        api, 'lifecycle_ready_for_shutdown', 'lifecycle.readyForShutdown',
      ),
    },
  };
}

function sendCommand(api) {
  const send = command(api, 'transport_send', 'transport.send');
  return (request, ...rest) => {
    if (rest.length > 0) return send(request, ...rest);
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      return send(request);
    }
    const bytes = request.bytes instanceof Uint8Array ? [...request.bytes] : request.bytes;
    return send({ ...request, bytes });
  };
}

function createWorkspaceCommands(api) {
  return {
    export: command(api, 'workspace_export', 'workspace.export'),
    import: command(api, 'workspace_import', 'workspace.import'),
  };
}
