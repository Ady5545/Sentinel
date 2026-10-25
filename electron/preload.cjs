const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sentinelDesktop', {
  getRuntimeInfo: () => ipcRenderer.invoke('desktop:runtime'),
  listSerialPorts: () => ipcRenderer.invoke('serial:list-ports'),
  connectBoard: request => ipcRenderer.invoke('serial:connect', request),
  disconnectBoard: device => ipcRenderer.invoke('serial:disconnect', device),
  onSerialEvent: callback => {
    if (typeof callback !== 'function') throw new TypeError('Callback must be a function.');
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('serial:event', listener);
    return () => ipcRenderer.removeListener('serial:event', listener);
  }
});
