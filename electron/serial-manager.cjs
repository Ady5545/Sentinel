const { EventEmitter } = require('node:events');
const { SerialPort } = require('serialport');

class SerialManager extends EventEmitter {
  constructor() {
    super();
    this.devices = new Map();
    this.maxLineLength = 2048;
  }
  async listPorts() {
    const ports = await SerialPort.list();
    return ports.map(port => ({ path: port.path, manufacturer: port.manufacturer, serialNumber: port.serialNumber, vendorId: port.vendorId, productId: port.productId }));
  }
  async connect(device, requestedPath, baudRate) {
    if (this.devices.has(device)) throw new Error(device.toUpperCase() + ' is already connected.');
    const available = await this.listPorts();
    if (!available.some(port => port.path === requestedPath)) throw new Error('Selected serial port is no longer available. Scan ports again.');
    const port = new SerialPort({ path: requestedPath, baudRate, autoOpen: false });
    const state = { port, buffer: '', device, path: requestedPath };
    this.devices.set(device, state);
    return new Promise((resolve, reject) => {
      let settled = false;
      port.on('data', chunk => this.consume(state, chunk));
      port.on('error', error => {
        this.emit('event', { kind: 'error', device, path: requestedPath, message: error.message });
        if (!settled) { settled = true; reject(error); }
      });
      port.on('close', () => {
        this.devices.delete(device);
        this.emit('event', { kind: 'closed', device, path: requestedPath, message: 'Serial port closed.' });
      });
      port.open(error => {
        if (error) { this.devices.delete(device); settled = true; reject(error); return; }
        settled = true;
        this.emit('event', { kind: 'opened', device, path: requestedPath, message: 'USB serial opened at ' + baudRate + ' baud.' });
        resolve();
      });
    });
  }
  consume(state, chunk) {
    state.buffer += chunk.toString('utf8');
    if (state.buffer.length > this.maxLineLength * 2) {
      state.buffer = '';
      this.emit('event', { kind: 'error', device: state.device, path: state.path, message: 'Serial buffer exceeded its limit and was cleared.' });
      return;
    }
    let newline = state.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = state.buffer.slice(0, newline).replace(/\r$/, '').trim();
      state.buffer = state.buffer.slice(newline + 1);
      if (line.length > this.maxLineLength) this.emit('event', { kind: 'error', device: state.device, path: state.path, message: 'Oversized serial line rejected.' });
      else if (line) this.emit('event', { kind: 'line', device: state.device, path: state.path, line, at: Date.now() });
      newline = state.buffer.indexOf('\n');
    }
  }
  async disconnect(device) {
    const state = this.devices.get(device);
    if (!state) return;
    await new Promise(resolve => {
      if (!state.port.isOpen) { this.devices.delete(device); resolve(); return; }
      state.port.close(() => { this.devices.delete(device); resolve(); });
    });
  }
  async closeAll() { await Promise.all([...this.devices.keys()].map(device => this.disconnect(device))); }
}
module.exports = { SerialManager };
