const { app, BrowserWindow, ipcMain, Menu, session, dialog } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { SerialManager } = require('./serial-manager.cjs');

const serialManager = new SerialManager();
let mainWindow = null;
app.setAppUserModelId('org.sentinel.research-environment');

function assertTrustedSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Blocked IPC from an untrusted renderer.');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 640,
    title: 'SENTINEL Research Environment', backgroundColor: '#11171d', show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow && mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('did-fail-load', (_event, code, description, validatedURL, isMainFrame) => {
    if (isMainFrame) console.error('[SENTINEL] Renderer failed to load:', { code, description, validatedURL });
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[SENTINEL] Renderer process exited:', details);
  });
  mainWindow.webContents.on('console-message', (_event, details) => {
    if (details.level >= 2) console.error('[SENTINEL renderer]', details.message);
  });
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
ipcMain.handle('data:export-file', async (event, request) => {
  assertTrustedSender(event);
  if (!request || !['json', 'csv'].includes(request.format) || typeof request.content !== 'string') {
    return { ok: false, error: 'Invalid export request.' };
  }
  if (Buffer.byteLength(request.content, 'utf8') > 5 * 1024 * 1024) {
    return { ok: false, error: 'Export exceeds the 5 MiB safety limit.' };
  }
  const extension = request.format;
  const fallback = extension === 'json' ? 'sentinel-evidence.json' : 'sentinel-evidence.csv';
  const fileName = typeof request.fileName === 'string' && /^[a-zA-Z0-9._-]{1,80}$/.test(request.fileName)
    ? request.fileName
    : fallback;
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export SENTINEL evidence',
    defaultPath: path.join(app.getPath('documents'), fileName),
    buttonLabel: 'Export evidence',
    filters: [{ name: extension.toUpperCase() + ' evidence', extensions: [extension] }]
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  try {
    await fs.writeFile(result.filePath, request.content, { encoding: 'utf8', flag: 'w' });
    return { ok: true, filePath: result.filePath };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});
ipcMain.handle('data:user-data-path', event => {
  assertTrustedSender(event);
  return app.getPath('userData');
});

ipcMain.handle('serial:list-ports', async event => {
  assertTrustedSender(event);
  return { ports: await serialManager.listPorts() };
});
ipcMain.handle('serial:readiness', event => {
  assertTrustedSender(event);
  return serialManager.getReadinessSnapshot();
});
ipcMain.handle('serial:connect', async (event, request) => {
  assertTrustedSender(event);
  if (!request || !['uno', 'sentinel'].includes(request.device)) return { ok: false, error: 'Unknown board role.' };
  if (typeof request.path !== 'string' || request.path.length < 1 || request.path.length > 256) return { ok: false, error: 'Invalid serial path.' };
  const baudRate = Number(request.baudRate);
  if (baudRate !== 115200) return { ok: false, error: 'USB console ports must use 115200 baud; peer UART baud is configured in firmware.' };
  try {
    const connection = await serialManager.connect(request.device, request.path, baudRate);
    return { ok: true, sessionId: connection.sessionId, phase: connection.phase };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Serial connection failed.' };
  }
});
ipcMain.handle('serial:command', async (event, request) => {
  assertTrustedSender(event);
  if (!request || !['uno', 'sentinel'].includes(request.device) ||
      !request.command || typeof request.command !== 'object' || Array.isArray(request.command)) {
    return { ok: false, error: 'Invalid structured board command request.' };
  }
  try {
    return await serialManager.writeCommand(request.device, request.command);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Board command was denied.' };
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
    const dev = Boolean(process.env.VITE_DEV_SERVER_URL) && !app.isPackaged;
    const connectSource = dev ? "'self' http://127.0.0.1:5173 ws://127.0.0.1:5173" : "'self'";
    // Vite's development client requires inline bootstrap/eval; packaged builds remain strict.
    const scriptSource = dev ? "'self' 'unsafe-inline' 'unsafe-eval' http://127.0.0.1:5173" : "'self'";
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [
      "default-src 'self'; script-src " + scriptSource + "; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src " + connectSource + "; object-src 'none'; base-uri 'self'; form-action 'self'"
    ] } });
  });
  createMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('before-quit', () => { void serialManager.closeAll(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
