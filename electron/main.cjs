const { app, BrowserWindow, ipcMain, Menu, session } = require('electron');
const path = require('node:path');
const { SerialManager } = require('./serial-manager.cjs');

const serialManager = new SerialManager();
let mainWindow = null;
app.setAppUserModelId('org.sentinel.atm-simulator');

function assertTrustedSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Blocked IPC from an untrusted renderer.');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 640,
    title: 'SENTINEL ATM Simulator', backgroundColor: '#11171d', show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow && mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const dev = process.env.VITE_DEV_SERVER_URL && url.startsWith(process.env.VITE_DEV_SERVER_URL);
    const packagedLocal = app.isPackaged && url.startsWith('file:');
    if (!dev && !packagedLocal) event.preventDefault();
  });
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    if (!app.isPackaged) mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'));
  }
  mainWindow.on('closed', () => { mainWindow = null; });
}

function createMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'quit' }] }] : []),
    { label: 'File', submenu: [{ label: 'Reload application window', click: () => mainWindow && mainWindow.reload() }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'View', submenu: [{ role: 'reload' }, ...(process.env.VITE_DEV_SERVER_URL ? [{ role: 'toggleDevTools' }] : []), { type: 'separator' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { role: 'togglefullscreen' }] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle('desktop:runtime', event => {
  assertTrustedSender(event);
  return { platform: process.platform, version: app.getVersion(), packaged: app.isPackaged, appName: app.getName() };
});
ipcMain.handle('serial:list-ports', async event => {
  assertTrustedSender(event);
  return { ports: await serialManager.listPorts() };
});
ipcMain.handle('serial:connect', async (event, request) => {
  assertTrustedSender(event);
  if (!request || !['uno', 'sentinel'].includes(request.device)) return { ok: false, error: 'Unknown board role.' };
  if (typeof request.path !== 'string' || request.path.length < 1 || request.path.length > 256) return { ok: false, error: 'Invalid serial path.' };
  const baudRate = Number(request.baudRate);
  if (![9600, 115200].includes(baudRate)) return { ok: false, error: 'Unsupported baud rate.' };
  try {
    await serialManager.connect(request.device, request.path, baudRate);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});
ipcMain.handle('serial:disconnect', async (event, device) => {
  assertTrustedSender(event);
  if (!['uno', 'sentinel'].includes(device)) return { ok: false, error: 'Unknown board role.' };
  await serialManager.disconnect(device);
  return { ok: true };
});
serialManager.on('event', payload => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('serial:event', payload);
});

app.whenReady().then(() => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const connectSource = process.env.VITE_DEV_SERVER_URL ? "'self' http://127.0.0.1:5173 ws://127.0.0.1:5173" : "'self'";
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src " + connectSource + "; object-src 'none'; base-uri 'self'; form-action 'self'"
    ] } });
  });
  createMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('before-quit', () => { void serialManager.closeAll(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
