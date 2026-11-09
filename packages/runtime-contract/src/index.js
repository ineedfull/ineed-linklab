// Optional capability keeps older preview/custom adapters compatible.
export const STOMP_RUNTIME_METHODS = Object.freeze(['stomp.execute', 'stomp.onEvent']);
export const OPCUA_RUNTIME_METHODS = Object.freeze(['opcua.execute', 'opcua.onEvent']);

export const REQUIRED_RUNTIME_METHODS = Object.freeze([
  'endpoint.list', 'endpoint.save', 'endpoint.clone', 'endpoint.delete',
  'transport.scanSerialPorts', 'transport.open', 'transport.cancelOpen',
  'transport.close', 'transport.send', 'transport.disconnectPeer',
  'transport.onFrames', 'transport.onStatus', 'transport.onPeers',
  'modbus.execute', 'modbus.readMap', 'modbus.writeMap', 'modbus.onTransactions',
  'modbusHistory.recordBatch', 'modbusHistory.querySeries', 'modbusHistory.queryRows',
  'modbusHistory.exportCsv', 'modbusHistory.clear', 'modbusHistory.cleanup',
  'modbusHistory.flush',
  'history.queryFrames', 'history.queryLogs', 'history.delete', 'history.clear',
  'template.list', 'template.save', 'template.delete',
  'sendHistory.record', 'sendHistory.query', 'sendHistory.delete', 'sendHistory.clear',
  'settings.getAll', 'settings.save', 'settings.saveAll',
  'workspace.export', 'workspace.import',
  'storage.stats', 'storage.clearHistory', 'window.openHistory',
  'lifecycle.onBeforeShutdown', 'lifecycle.readyForShutdown',
]);

export {
  normalizeFrameWireBatch,
  normalizeStatusWireEvent,
  normalizeTransportFrameBatch,
  normalizeTransportPeerEvent,
  normalizeTransportStatusEvent,
} from './serialWireNormalizer.js';

export {
  normalizeModbusPointHistoryQuery,
  normalizeModbusPointHistoryRow,
  normalizeModbusPointHistoryRows,
  normalizeModbusPointSeriesQuery,
} from './modbusPointHistoryNormalizer.js';

const emptyPage = () => ({ rows: [], total: 0, page: 1, pageSize: 100 });

export class RuntimeUnavailableError extends Error {
  constructor(method, runtimeName) {
    super(`Runtime method "${method}" is unavailable in ${runtimeName}`);
    this.name = 'RuntimeUnavailableError';
    this.method = method;
    this.runtimeName = runtimeName;
  }
}

export function assertRuntimeAdapter(adapter) {
  const invalidMethods = REQUIRED_RUNTIME_METHODS.filter((dottedMethod) => {
    const [namespace, method] = dottedMethod.split('.');
    return typeof adapter?.[namespace]?.[method] !== 'function';
  });

  if (invalidMethods.length > 0) {
    throw new TypeError(`Runtime adapter is missing required methods: ${invalidMethods.join(', ')}`);
  }

  return adapter;
}

export function createUnavailableRuntimeAdapter(runtimeName) {
  if (typeof runtimeName !== 'string' || runtimeName.trim() === '') {
    throw new TypeError('runtimeName must be a nonblank string');
  }

  const reject = (method) => async () => {
    throw new RuntimeUnavailableError(method, runtimeName);
  };
  const unsubscribe = () => () => {};

  return {
    runtimeName,
    stomp: { execute: reject('stomp.execute'), onEvent: unsubscribe },
    opcua: { execute: reject('opcua.execute'), onEvent: unsubscribe },
    endpoint: {
      list: async () => [],
      save: reject('endpoint.save'),
      clone: reject('endpoint.clone'),
      delete: reject('endpoint.delete'),
    },
    transport: {
      scanSerialPorts: reject('transport.scanSerialPorts'),
      open: reject('transport.open'),
      cancelOpen: reject('transport.cancelOpen'),
      close: reject('transport.close'),
      send: reject('transport.send'),
      disconnectPeer: reject('transport.disconnectPeer'),
      onFrames: unsubscribe,
      onStatus: unsubscribe,
      onPeers: unsubscribe,
    },
    modbus: {
      execute: reject('modbus.execute'),
      readMap: reject('modbus.readMap'),
      writeMap: reject('modbus.writeMap'),
      onTransactions: unsubscribe,
    },
    modbusHistory: {
      recordBatch: reject('modbusHistory.recordBatch'),
      querySeries: async () => ({ series: [], from: null, to: null }),
      queryRows: async () => ({ rows: [], total: 0, page: 1, pageSize: 50 }),
      exportCsv: reject('modbusHistory.exportCsv'),
      clear: reject('modbusHistory.clear'),
      cleanup: reject('modbusHistory.cleanup'),
      flush: async () => ({ flushed: true }),
    },
    history: {
      queryFrames: async () => emptyPage(),
      queryLogs: async () => emptyPage(),
      delete: reject('history.delete'),
      clear: reject('history.clear'),
    },
    template: {
      list: async () => [],
      save: reject('template.save'),
      delete: reject('template.delete'),
    },
    sendHistory: {
      record: reject('sendHistory.record'),
      query: async () => ({ rows: [], total: 0, page: 1, pageSize: 20 }),
      delete: reject('sendHistory.delete'),
      clear: reject('sendHistory.clear'),
    },
    settings: {
      getAll: async () => ({}),
      save: reject('settings.save'),
      saveAll: reject('settings.saveAll'),
    },
    workspace: {
      export: reject('workspace.export'),
      import: reject('workspace.import'),
    },
    storage: {
      stats: async () => ({
        frameCount: 0,
        logCount: 0,
        sendHistoryCount: 0,
        totalCount: 0,
        diskBytes: 0,
      }),
      clearHistory: reject('storage.clearHistory'),
    },
    window: {
      openHistory: reject('window.openHistory'),
    },
    lifecycle: {
      onBeforeShutdown: unsubscribe,
      readyForShutdown: reject('lifecycle.readyForShutdown'),
    },
  };
}
