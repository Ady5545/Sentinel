const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { SerialPort } = require('serialport');

const SIMPLE_COMMANDS = {
  uno: new Set(['BALANCE', 'CANCEL', 'LOGOUT', 'STATUS', 'JOURNAL', 'HELP', 'FIXTURE_MISMATCH']),
  sentinel: new Set(['STATUS', 'FIXTURE_REVOKE', 'HELP'])
};

function safeInteger(text, min, max) {
  if (!/^(0|[1-9][0-9]*)$/.test(text)) return false;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

/**
 * Validate a single operator command before it reaches a board.
 * The command text and argument values are never emitted to diagnostic events.
 */
function validateBoardCommand(device, command) {
  if (!['uno', 'sentinel'].includes(device)) return { ok: false, error: 'Unknown board role.' };
  if (typeof command !== 'string' || command.length < 1 || command.length > 96) {
    return { ok: false, error: 'Command must contain 1–96 characters.' };
  }
  if (command !== command.trim() || [...command].some(character => { const code = character.charCodeAt(0); return code < 0x20 || code > 0x7E; })) {
    return { ok: false, error: 'Command contains whitespace padding or disallowed control/non-ASCII characters.' };
  }
  const parts = command.split(/ +/);
  if (parts.some(part => !part) || parts[0] !== parts[0].toUpperCase()) return { ok: false, error: 'Use a canonical uppercase command with single spaces.' };
  const [name, ...args] = parts;
  const integer = (value, min, max) => safeInteger(value, min, max);
  const card = value => /^[A-Z0-9_-]{1,16}$/.test(value);
  const pin = value => typeof value === 'string' && value.length >= 4 && value.length <= 6 && [...value].every(character => character >= '0' && character <= '9');
  let valid = false;

  if (SIMPLE_COMMANDS[device].has(name) && args.length === 0) valid = true;
  if (device === 'uno') {
    if (name === 'ADD_ACCOUNT' && args.length === 3) valid = card(args[0]) && pin(args[1]) && integer(args[2], 0, 1000000);
    else if (name === 'SET_CASH' && args.length === 4) valid = args.every(value => integer(value, 0, 9999));
    else if (name === 'SET_POLICY' && (args.length === 2 || args.length === 9)) {
      valid = integer(args[0], 1, 1000000) && integer(args[1], Number(args[0]), 1000000);
      if (valid && args.length === 9) valid =
        integer(args[2], 60000, 86400000) && integer(args[3], 1, 10) &&
        integer(args[4], 5000, 900000) && integer(args[5], 5000, 120000) &&
        integer(args[6], 10000, 600000) && integer(args[7], 1800, 30000) &&
        integer(args[8], 500, 10000);
    } else if (name === 'CARD' && args.length === 1) valid = card(args[0]);
    else if (name === 'PIN' && args.length === 1) valid = pin(args[0]);
    else if (name === 'WITHDRAW' && args.length === 1) valid = integer(args[0], 1, 1000000) && Number(args[0]) % 50 === 0;
    else if (name === 'CHANGE_PIN' && args.length === 3) valid = args.every(pin);
  } else {
    if (name === 'SET_LIMITS' && args.length === 2) {
      valid = integer(args[0], 1, 1000000) && integer(args[1], Number(args[0]), 1000000);
    } else if (name === 'SET_POLICY' && args.length === 8) {
      valid = integer(args[0], 1, 1000000) && integer(args[1], Number(args[0]), 1000000) &&
        integer(args[2], 700, 10000) && integer(args[3], Number(args[2]) + 1, 30000) &&
        integer(args[4], 60000, 86400000) && integer(args[5], 3, 30) &&
        integer(args[6], 10000, 600000) && integer(args[7], 500, 10000);
    }
  }
  if (!valid) return { ok: false, error: 'Command is not in the allowlist or its arguments are outside the documented range.' };
  return { ok: true, commandName: name, sensitive: name === 'PIN' || name === 'ADD_ACCOUNT' || name === 'CHANGE_PIN' };
}

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
    if ([...this.devices.values()].some(entry => entry.path === requestedPath)) throw new Error('This serial path is already assigned to another board role.');
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
  async writeCommand(device, command) {
    const validation = validateBoardCommand(device, command);
    if (!validation.ok) throw new Error(validation.error);
    const state = this.devices.get(device);
    if (!state || !state.port.isOpen) throw new Error(device.toUpperCase() + ' serial port is not open.');
    const requestId = randomUUID();
    await new Promise((resolve, reject) => {
      state.port.write(command + String.fromCharCode(10), error => {
        if (error) { reject(error); return; }
        state.port.drain(drainError => drainError ? reject(drainError) : resolve());
      });
    });
    // Local write/drain is not a board acknowledgement; never log raw command text,
    // because commands may contain fictional PINs.
    this.emit('event', {
      kind: 'command-written', device, path: state.path, requestId,
      commandName: validation.commandName, sensitive: validation.sensitive,
      message: 'Command bytes drained locally; board acceptance has not yet been confirmed.'
    });
    return { ok: true, requestId, commandName: validation.commandName, sensitive: validation.sensitive };
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
module.exports = { SerialManager, validateBoardCommand };
