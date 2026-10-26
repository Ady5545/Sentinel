const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sentinelDesktop', {
  getRuntimeInfo: () => ipcRenderer.invoke('desktop:runtime'),
  exportEvidence: request => ipcRenderer.invoke('data:export-file', request),
  getUserDataPath: () => ipcRenderer.invoke('data:user-data-path'),
  listSerialPorts: () => ipcRenderer.invoke('serial:list-ports'),
  getSerialReadiness: () => ipcRenderer.invoke('serial:readiness'),
  setResearchMode: mode => ipcRenderer.invoke('serial:set-research-mode', mode),
  connectBoard: request => ipcRenderer.invoke('serial:connect', request),
  disconnectBoard: device => ipcRenderer.invoke('serial:disconnect', device),
  sendBoardCommand: request => ipcRenderer.invoke('serial:command', request),
  onSerialEvent: callback => {
    if (typeof callback !== 'function') throw new TypeError('Callback must be a function.');
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('serial:event', listener);
    return () => ipcRenderer.removeListener('serial:event', listener);
  }
});
