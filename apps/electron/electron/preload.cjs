const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const subscribe = (channel) => (listener) => {
  const wrappedListener = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrappedListener);
  return () => ipcRenderer.removeListener(channel, wrappedListener);
};

contextBridge.exposeInMainWorld('ineedLinkLab', {
  runtimeName: 'electron',
  stomp: { execute: invoke('stomp:execute'), onEvent: subscribe('stomp:event') },
  opcua: { execute: invoke('opcua:execute'), onEvent: subscribe('opcua:event') },
  endpoint: {
    list: invoke('endpoint:list'),
    save: invoke('endpoint:save'),
    clone: invoke('endpoint:clone'),
    delete: invoke('endpoint:delete'),
  },
  transport: {
    scanSerialPorts: invoke('transport:scanSerialPorts'),
    open: invoke('transport:open'),
    cancelOpen: invoke('transport:cancelOpen'),
    close: invoke('transport:close'),
    send: invoke('transport:send'),
    disconnectPeer: invoke('transport:disconnectPeer'),
    onPersistenceWarning: subscribe('persistence:warning'),
    onFrames: subscribe('transport:frames'),
    onStatus: subscribe('transport:status'),
    onPeers: subscribe('transport:peers'),
  },
  modbus: {
    execute: invoke('modbus:execute'),
    readMap: invoke('modbus:readMap'),
    writeMap: invoke('modbus:writeMap'),
    onTransactions: subscribe('modbus:transaction'),
  },
  modbusHistory: {
    recordBatch: invoke('modbusHistory:recordBatch'),
    querySeries: invoke('modbusHistory:querySeries'),
    queryRows: invoke('modbusHistory:queryRows'),
    exportCsv: invoke('modbusHistory:exportCsv'),
    clear: invoke('modbusHistory:clear'),
    cleanup: invoke('modbusHistory:cleanup'),
    flush: invoke('modbusHistory:flush'),
  },
  history: {
    queryFrames: invoke('history:queryFrames'),
    queryLogs: invoke('history:queryLogs'),
    delete: invoke('history:delete'),
    clear: invoke('history:clear'),
  },
  template: {
    list: invoke('template:list'),
    save: invoke('template:save'),
    delete: invoke('template:delete'),
  },
  sendHistory: {
    record: invoke('sendHistory:record'),
    query: invoke('sendHistory:query'),
    delete: invoke('sendHistory:delete'),
    clear: invoke('sendHistory:clear'),
  },
  settings: {
    getAll: invoke('settings:getAll'),
    save: invoke('settings:save'),
    saveAll: invoke('settings:saveAll'),
  },
  workspace: {
    export: invoke('workspace:export'),
    import: invoke('workspace:import'),
  },
  storage: {
    stats: invoke('storage:stats'),
    clearHistory: invoke('storage:clearHistory'),
  },
  window: {
    openHistory: invoke('window:openHistory'),
    openWebsite: invoke('window:openWebsite'),
  },
  lifecycle: {
    onBeforeShutdown: subscribe('lifecycle:before-shutdown'),
    readyForShutdown: invoke('lifecycle:readyForShutdown'),
  },
});
