import { createServer } from 'node:http';
import { SerialPort } from 'serialport';
import { WebSocketServer, WebSocket } from 'ws';

const HOST = '127.0.0.1';
const PORT = Number(process.env.SENTINEL_WS_PORT || 8787);
const server = createServer((request, response) => {
  response.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:5173');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (request.url === '/health') {
    response.writeHead(200);
    response.end(JSON.stringify({ ok: true, service: 'sentinel-local-serial-bridge', port: PORT }));
    return;
  }
  if (request.url === '/') {
    response.writeHead(200);
    response.end(JSON.stringify({ service: 'SENTINEL local serial bridge', websocket: 'ws://' + HOST + ':' + PORT, status: 'ready' }));
    return;
  }
  response.writeHead(404);
  response.end(JSON.stringify({ error: 'not_found' }));
});

const wss = new WebSocketServer({ server, maxPayload: 8192 });
const portsByDevice = { uno: null, sentinel: null };
const buffers = { uno: '', sentinel: '' };
const knownPorts = new Map();
const deviceNames = { uno: 'Arduino Uno', sentinel: 'SENTINEL ESP32' };

function send(client, message) {
  if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
}
function broadcast(message) {
  for (const client of wss.clients) send(client, message);
}
function deviceSnapshot() {
  return Object.fromEntries(Object.entries(portsByDevice).map(([name, port]) => [
    name, { connected: Boolean(port?.isOpen), path: port?.path || '' }
  ]));
}
function broadcastState() {
  broadcast({ type: 'bridge_state', devices: deviceSnapshot() });
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
async function scanPorts() {
  try {
    const found = await SerialPort.list();
    knownPorts.clear();
    for (const port of found) knownPorts.set(port.path, port);
    broadcast({ type: 'ports', ports: found.map(port => ({
      path: port.path,
      manufacturer: port.manufacturer || '',
      serialNumber: port.serialNumber || '',
      vendorId: port.vendorId || '',
      productId: port.productId || ''
    })) });
  } catch (error) {
    broadcast({ type: 'bridge_error', message: 'Could not enumerate serial ports: ' + errorMessage(error) });
  }
}
function closeDevice(device, announce = true) {
  const port = portsByDevice[device];
  if (!port) {
    if (announce) broadcast({ type: 'device_status', device, connected: false, path: '' });
    return;
  }
  portsByDevice[device] = null;
  buffers[device] = '';
  if (port.isOpen) {
    port.close(error => {
      if (error) broadcast({ type: 'bridge_error', message: 'Closing ' + deviceNames[device] + ': ' + errorMessage(error) });
    });
  }
  if (announce) broadcast({ type: 'device_status', device, connected: false, path: port.path || '' });
}
function connectDevice(client, message) {
  const device = message.device;
  const path = String(message.path || '');
  const baudRate = Number(message.baudRate || 115200);
  if (device !== 'uno' && device !== 'sentinel') {
    send(client, { type: 'bridge_error', message: 'Unknown device slot.' });
    return;
  }
  if (!knownPorts.has(path)) {
    send(client, { type: 'bridge_error', message: 'Scan serial ports and select a listed port before connecting.' });
    return;
  }
  if (Object.entries(portsByDevice).some(([key, port]) => key !== device && port?.path === path)) {
    send(client, { type: 'bridge_error', message: 'That serial port is already assigned to the other board.' });
    return;
  }
  closeDevice(device, false);
  const serial = new SerialPort({ path, baudRate, autoOpen: false });
  portsByDevice[device] = serial;
  buffers[device] = '';
  serial.on('open', () => {
    broadcast({ type: 'device_status', device, connected: true, path });
    broadcastState();
  });
  serial.on('data', chunk => {
    buffers[device] += chunk.toString('utf8');
    let newline = buffers[device].indexOf('\n');
    while (newline >= 0) {
      const line = buffers[device].slice(0, newline).replace(/\r$/, '').trim();
      buffers[device] = buffers[device].slice(newline + 1);
      if (line) broadcast({ type: 'serial_data', device, line, at: new Date().toISOString() });
      newline = buffers[device].indexOf('\n');
    }
    if (buffers[device].length > 4096) buffers[device] = buffers[device].slice(-1024);
  });
  serial.on('error', error => {
    broadcast({ type: 'bridge_error', message: deviceNames[device] + ' serial error: ' + errorMessage(error) });
  });
  serial.on('close', () => {
    if (portsByDevice[device] === serial) {
      portsByDevice[device] = null;
      buffers[device] = '';
      broadcast({ type: 'device_status', device, connected: false, path });
      broadcastState();
    }
  });
  serial.open(error => {
    if (error) {
      if (portsByDevice[device] === serial) portsByDevice[device] = null;
      send(client, { type: 'bridge_error', message: 'Could not open ' + path + ': ' + errorMessage(error) + '. Close Arduino IDE Serial Monitor and try again.' });
      broadcastState();
    }
  });
}
function sendLine(client, message) {
  const device = message.device;
  if (device !== 'uno' && device !== 'sentinel') {
    send(client, { type: 'bridge_error', message: 'Unknown target device.' });
    return;
  }
  const port = portsByDevice[device];
  if (!port?.isOpen) {
    send(client, { type: 'bridge_error', message: deviceNames[device] + ' is not connected.' });
    return;
  }
  const line = String(message.line || '');
  if (line.includes('\n') || line.includes('\r') || line.length > 512) {
    send(client, { type: 'bridge_error', message: 'Messages must be one line and at most 512 characters.' });
    return;
  }
  port.write(line + '\n', error => {
    if (error) send(client, { type: 'bridge_error', message: 'Serial write failed: ' + errorMessage(error) });
    else port.drain(drainError => {
      if (drainError) send(client, { type: 'bridge_error', message: 'Serial drain failed: ' + errorMessage(drainError) });
    });
  });
}
wss.on('connection', client => {
  send(client, { type: 'bridge_ready', service: 'sentinel-local-serial-bridge' });
  send(client, { type: 'bridge_state', devices: deviceSnapshot() });
  client.on('message', raw => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      send(client, { type: 'bridge_error', message: 'Invalid JSON control message.' });
      return;
    }
    if (message.type === 'get_state') broadcastState();
    else if (message.type === 'scan_ports') void scanPorts();
    else if (message.type === 'connect') connectDevice(client, message);
    else if (message.type === 'disconnect' && (message.device === 'uno' || message.device === 'sentinel')) closeDevice(message.device);
    else if (message.type === 'send_line') sendLine(client, message);
    else send(client, { type: 'bridge_error', message: 'Unsupported bridge command.' });
  });
});
server.on('error', error => {
  console.error('[SENTINEL bridge]', errorMessage(error));
});
server.listen(PORT, HOST, () => {
  console.log('SENTINEL local serial bridge listening at http://' + HOST + ':' + PORT);
});
process.on('SIGINT', () => {
  for (const device of ['uno', 'sentinel']) closeDevice(device, false);
  server.close(() => process.exit(0));
});
process.on('SIGTERM', () => {
  for (const device of ['uno', 'sentinel']) closeDevice(device, false);
  server.close(() => process.exit(0));
});
