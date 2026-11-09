const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('ineedLinkLab', {
  runtimeName: 'electron',
  history: {
    queryFrames: invoke('history:queryFrames'),
    queryLogs: invoke('history:queryLogs'),
  },
  settings: {
    getAll: invoke('settings:getAll'),
  },
});
