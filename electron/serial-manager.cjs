const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { SerialPort } = require('serialport');

const SIMPLE_COMMANDS = {
  uno: new Set(['BALANCE', 'CANCEL', 'LOGOUT', 'STATUS', 'JOURNAL', 'HELP', 'FIXTURE_MISMATCH']),
  sentinel: new Set(['STATUS', 'FIXTURE_REVOKE', 'HELP'])
};
const PROTECTED_PAIR_COMMANDS = new Set(['CARD', 'PIN', 'BALANCE', 'WITHDRAW', 'CHANGE_PIN', 'FIXTURE_MISMATCH']);
const VALID_ROLES = new Set(['uno', 'sentinel']);
const READINESS_TTL_MS = 3500;
const MAX_LINE_LENGTH = 2048;

function safeInteger(text, min, max) {
  if (typeof text !== 'string' || !/^(0|[1-9][0-9]*)$/.test(text)) return false;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function redactSensitiveSerialText(line) {
  return String(line)
    .replace(/\bCHANGE_PIN\s+\d{4,6}\s+\d{4,6}\s+\d{4,6}\b/gi, 'CHANGE_PIN [REDACTED]')
    .replace(/\bADD_ACCOUNT\s+\S+\s+\d{4,6}\s+\S+\b/gi, 'ADD_ACCOUNT [REDACTED]')
    .replace(/\bPIN\s+\d{4,6}\b/gi, 'PIN [REDACTED]')
    .replace(/\b(pin|old_pin|new_pin)=\d{4,6}\b/gi, '$1=[REDACTED]');
}

function parsedFields(text) {
  const fields = Object.create(null);
  for (const match of text.matchAll(/(?:^|[;| ])([a-z_]+)=([^;|\s]+)/gi)) {
    fields[match[1].toLowerCase()] = match[2];
  }
  return fields;
}

function safeId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,16}$/.test(value) ? value : undefined;
}

function safeAmount(value) {
  return typeof value === 'string' && safeInteger(value, 0, 1000000) ? Number(value) : undefined;
}

/**
 * Parse known board console records into a narrow, version-tolerant event shape.
 * Unknown lines remain observations only. No raw console text is placed in fields.
 */
function parseBoardLine(device, line) {
  if (!VALID_ROLES.has(device) || typeof line !== 'string') return { type: 'MALFORMED' };

  if (/SENTINEL ATM CONTROLLER V\d+(?:\.\d+)? READY|SENTINEL ESP32 GUARDIAN V\d+(?:\.\d+)? READY|^SESSION:\s*/.test(line)) {
    return { type: 'BOARD_BOOT', phase: 'BOOTED' };
  }
  if (/\[LINK\] V3 negotiation started|\[LINK\] V3 guardian HELLO observed/.test(line)) {
    return { type: 'LINK_NEGOTIATING', phase: 'NEGOTIATING' };
  }
  if (device === 'uno' && /\[STATUS_RX\] Accepted HEALTHY/.test(line)) {
    return { type: 'UNO_HEALTHY', phase: 'HEALTHY' };
  }
  if (device === 'sentinel' && /GUARDIAN_STATUS\|mode=OBSERVING/.test(line)) {
    return { type: 'GUARDIAN_OBSERVING', phase: 'OBSERVING' };
  }
  if (/\[SECURITY_LOCK\]|\[REVOKE\]|GUARDIAN_STATUS\|mode=REVOKED|GUARDIAN_REVOKED/.test(line)) {
    return { type: 'AUTHORITY_REVOKED', phase: 'REVOKED' };
  }

  if (line.startsWith('ATM_EVENT|')) {
    const parts = line.split('|');
    const eventName = parts[1] || '';
    if (!/^[A-Z_]{1,40}$/.test(eventName)) return { type: 'MALFORMED' };
    const fields = parsedFields(parts.slice(2).join('|'));
    return {
      type: 'ATM_EVENT',
      eventName,
      id: safeId(fields.id),
      amount: safeAmount(fields.amount),
      balance: safeAmount(fields.balance),
      reason: typeof fields.reason === 'string' ? redactSensitiveSerialText(fields.reason).slice(0, 64) : undefined
    };
  }

  const permit = line.match(/^\[PERMIT\] One-shot observation issued for ([A-Za-z0-9_-]{1,16});\s*amount=(0|[1-9][0-9]*)/);
  if (device === 'sentinel' && permit) {
    return { type: 'PERMIT', id: safeId(permit[1]), amount: safeAmount(permit[2]) };
  }
  if (device === 'sentinel' && line.startsWith('[DENY] ')) {
    const fields = parsedFields(line.slice('[DENY] '.length));
    return { type: 'DENY', id: safeId(fields.id), amount: safeAmount(fields.amount), reason: typeof fields.reason === 'string' ? redactSensitiveSerialText(fields.reason).slice(0, 64) : undefined };
  }
  // This marker matches the current ESP32 firmware's actual USB console output.
  // Keep the older research-console phrase accepted for backward-compatible logs.
  if (device === 'sentinel' && (
      line.startsWith('[RECONCILE] Matching controller-reported virtual commit ') ||
      line.includes('[AUDIT] Matching controller-reported virtual transaction commit observed')
  )) {
    const fields = parsedFields(line);
    return { type: 'COMMIT_RECONCILIATION', id: safeId(fields.id), amount: safeAmount(fields.amount) };
  }
  return { type: 'CONSOLE_LINE' };
}

/**
 * Validate a renderer-supplied structured command and turn it into a canonical
 * wire line. IPC must never accept a raw line or arbitrary serial bytes.
 */
function normalizeCommandRequest(device, request) {
  if (!VALID_ROLES.has(device)) return { ok: false, error: 'Unknown board role.' };
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return { ok: false, error: 'Command must be a structured { name, args } request.' };
  }
  const keys = Object.keys(request).sort();
  if (keys.length !== 2 || keys[0] !== 'args' || keys[1] !== 'name') {
    return { ok: false, error: 'Command request must contain only name and args.' };
  }
  if (typeof request.name !== 'string' || !/^[A-Z_]{1,32}$/.test(request.name) ||
      !Array.isArray(request.args) || request.args.length > 9) {
    return { ok: false, error: 'Invalid command name or argument list.' };
  }
  if (request.args.some(arg => typeof arg !== 'string' || arg.length < 1 || arg.length > 32 ||
      !/^[\x21-\x7E]+$/.test(arg) || /[\s\u0000-\u001F]/.test(arg))) {
    return { ok: false, error: 'Arguments must be single printable ASCII tokens.' };
  }
  const command = request.name + (request.args.length ? ' ' + request.args.join(' ') : '');
  const validation = validateBoardCommand(device, command);
  return validation.ok ? { ...validation, command } : validation;
}

/**
 * Validate the canonical command line against the board-role allowlist. The line
 * is used only inside the trusted main process and is never echoed to diagnostics.
 */
function validateBoardCommand(device, command) {
  if (!VALID_ROLES.has(device)) return { ok: false, error: 'Unknown board role.' };
  if (typeof command !== 'string' || command.length < 1 || command.length > 96) {
    return { ok: false, error: 'Command must contain 1–96 characters.' };
  }
  if (command !== command.trim() || [...command].some(character => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code > 0x7E;
  })) {
    return { ok: false, error: 'Command contains whitespace padding or disallowed control/non-ASCII characters.' };
  }
  const parts = command.split(' ');
  if (parts.some(part => !part) || parts[0] !== parts[0].toUpperCase()) {
    return { ok: false, error: 'Use a canonical uppercase command with single spaces.' };
  }
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
  constructor(options = {}) {
    super();
    this.devices = new Map();
    this.maxLineLength = options.maxLineLength || MAX_LINE_LENGTH;
    this.freshnessMs = options.freshnessMs || READINESS_TTL_MS;
    this.now = options.now || (() => Date.now());
    this.listPortsProvider = options.listPorts || (() => SerialPort.list());
    this.createPort = options.createPort || (config => new SerialPort(config));
  }

  async listPorts() {
    const ports = await this.listPortsProvider();
    return ports.map(port => ({
      path: port.path,
      manufacturer: port.manufacturer,
      serialNumber: port.serialNumber,
      vendorId: port.vendorId,
      productId: port.productId
    }));
  }

  async connect(device, requestedPath, baudRate) {
    if (!VALID_ROLES.has(device)) throw new Error('Unknown board role.');
    if (typeof requestedPath !== 'string' || !requestedPath || requestedPath.length > 256) throw new Error('Invalid serial path.');
    if (baudRate !== 115200) throw new Error('USB console ports must use 115200 baud; peer UART baud is configured in firmware.');
    if (this.devices.has(device)) throw new Error(device.toUpperCase() + ' is already connected.');
    if ([...this.devices.values()].some(entry => entry.path === requestedPath && !entry.closed)) {
      throw new Error('This serial path is already assigned to another board role.');
    }
    const available = await this.listPorts();
    if (!available.some(port => port.path === requestedPath)) throw new Error('Selected serial port is no longer available. Scan ports again.');

    const port = this.createPort({ path: requestedPath, baudRate, autoOpen: false });
    const state = {
      port, buffer: '', droppingLongLine: false, device, path: requestedPath,
      sessionId: randomUUID(), connected: false, failed: false, closed: false,
      phase: 'USB OPEN', lastLineAt: 0, readinessAt: 0, writeQueue: Promise.resolve()
    };
    this.devices.set(device, state);

    return new Promise((resolve, reject) => {
      let settled = false;
      const failOpen = error => {
        state.failed = true;
        state.phase = 'ERROR';
        if (this.devices.get(device) === state) this.devices.delete(device);
        this.emit('event', { kind: 'error', code: 'OPEN_FAILED', device, path: requestedPath, sessionId: state.sessionId, message: 'Serial port could not be opened.' });
        if (!settled) {
          settled = true;
          reject(error instanceof Error ? new Error('Serial port could not be opened.') : new Error('Serial port could not be opened.'));
        }
      };

      port.on('data', chunk => this.consume(state, chunk));
      port.on('error', () => {
        state.failed = true;
        state.phase = 'ERROR';
        state.readinessAt = 0;
        this.emit('event', { kind: 'error', code: 'PORT_ERROR', device, path: requestedPath, sessionId: state.sessionId, message: 'Serial port error; readiness is revoked until reconnect.' });
        if (!settled) failOpen(new Error('Serial port error.'));
        else void this.disconnect(device);
      });
      port.on('close', () => {
        if (state.closed) return;
        state.closed = true;
        state.connected = false;
        state.phase = 'DISCONNECTED';
        state.readinessAt = 0;
        if (this.devices.get(device) === state) this.devices.delete(device);
        this.emit('event', { kind: 'closed', code: 'PORT_CLOSED', device, path: requestedPath, sessionId: state.sessionId, message: 'Serial port closed; readiness invalidated.' });
      });
      port.open(error => {
        if (error) { failOpen(error); return; }
        if (state.closed || state.failed) { failOpen(new Error('Serial port failed during open.')); return; }
        state.connected = true;
        settled = true;
        this.emit('event', { kind: 'opened', code: 'PORT_OPENED', device, path: requestedPath, sessionId: state.sessionId, phase: state.phase, message: 'USB console opened; board readiness not established.' });
        resolve({ sessionId: state.sessionId, phase: state.phase });
      });
    });
  }

  getReadinessSnapshot() {
    const boards = {};
    for (const device of ['uno', 'sentinel']) {
      const state = this.devices.get(device);
      if (!state || state.closed || !state.connected || state.failed || !state.port.isOpen) {
        boards[device] = {
          device, connected: false, path: state ? state.path : '',
          sessionId: state ? state.sessionId : undefined,
          phase: state && state.failed ? 'ERROR' : 'DISCONNECTED',
          lastLineAt: state ? state.lastLineAt : 0,
          readinessAt: 0
        };
        continue;
      }
      const isStale = ['HEALTHY', 'OBSERVING'].includes(state.phase) &&
        (!state.readinessAt || this.now() - state.readinessAt > this.freshnessMs);
      boards[device] = {
        device, connected: true, path: state.path, sessionId: state.sessionId,
        phase: isStale ? 'STALE' : state.phase,
        lastLineAt: state.lastLineAt,
        readinessAt: state.readinessAt
      };
    }
    const uno = boards.uno;
    const sentinel = boards.sentinel;
    const pairReady = uno.connected && sentinel.connected &&
      uno.phase === 'HEALTHY' && sentinel.phase === 'OBSERVING' &&
      uno.readinessAt > 0 && sentinel.readinessAt > 0 &&
      this.now() - uno.readinessAt <= this.freshnessMs &&
      this.now() - sentinel.readinessAt <= this.freshnessMs;
    return { pairReady, freshnessMs: this.freshnessMs, boards };
  }

  isPairReady() {
    return this.getReadinessSnapshot().pairReady;
  }

  async writeCommand(device, request) {
    const validation = normalizeCommandRequest(device, request);
    if (!validation.ok) throw new Error(validation.error);
    const state = this.devices.get(device);
    if (!state || state.closed || state.failed || !state.connected || !state.port.isOpen) {
      throw new Error(device.toUpperCase() + ' serial port is not open.');
    }
    if (PROTECTED_PAIR_COMMANDS.has(validation.commandName) && !this.isPairReady()) {
      throw new Error('Protected command denied: both board roles must have fresh HEALTHY/OBSERVING reports. Connection alone is not readiness.');
    }

    const requestId = randomUUID();
    // Serialize writes to avoid interleaving concurrent IPC command frames.
    const write = () => new Promise((resolve, reject) => {
      state.port.write(validation.command + String.fromCharCode(10), error => {
        if (error) { reject(error); return; }
        state.port.drain(drainError => drainError ? reject(drainError) : resolve());
      });
    });
    const current = state.writeQueue.then(write, write);
    state.writeQueue = current.catch(() => undefined);
    try {
      await current;
    } catch {
      state.failed = true;
      state.phase = 'ERROR';
      state.readinessAt = 0;
      this.emit('event', { kind: 'error', code: 'WRITE_FAILED', device, path: state.path, sessionId: state.sessionId, message: 'Serial write failed; board readiness invalidated.' });
      void this.disconnect(device);
      throw new Error('Serial write failed; reconnect and re-establish both board readiness reports.');
    }

    this.emit('event', {
      kind: 'command-written', code: 'WRITE_DRAINED', device, path: state.path, sessionId: state.sessionId,
      requestId, commandName: validation.commandName, sensitive: validation.sensitive,
      message: 'Command bytes drained locally; board acceptance has not yet been confirmed.'
    });
    return { ok: true, requestId, commandName: validation.commandName, sensitive: validation.sensitive };
  }

  rejectInput(state, code, message) {
    if (state.closed || state.failed) return;
    state.failed = true;
    state.phase = 'ERROR';
    state.readinessAt = 0;
    state.buffer = '';
    state.droppingLongLine = false;
    this.emit('event', { kind: 'error', code, device: state.device, path: state.path, sessionId: state.sessionId, message });
    // Ambiguous framing revokes readiness and releases the port for a clean reconnect.
    void this.disconnect(state.device);
  }

  consume(state, chunk) {
    if (state.closed || state.failed || this.devices.get(state.device) !== state) return;
    const incoming = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    let text = incoming;

    if (state.droppingLongLine) {
      const nextNewline = text.indexOf('\n');
      if (nextNewline < 0) return;
      text = text.slice(nextNewline + 1);
      state.droppingLongLine = false;
    }
    state.buffer += text;
    if (state.buffer.length > this.maxLineLength * 2 && !state.buffer.includes('\n')) {
      this.rejectInput(state, 'LINE_TOO_LONG', 'Oversized serial line rejected; board readiness invalidated.');
      return;
    }

    let newline = state.buffer.indexOf('\n');
    while (newline >= 0) {
      const candidate = state.buffer.slice(0, newline).replace(/\r$/, '');
      state.buffer = state.buffer.slice(newline + 1);
      if (candidate.length > this.maxLineLength) {
        this.rejectInput(state, 'LINE_TOO_LONG', 'Oversized serial line rejected; board readiness invalidated.');
        return;
      } else if (!candidate) {
        // Ignore an empty line, but keep framing synchronized.
      } else if (candidate !== candidate.trim() || /[^\x20-\x7E]/.test(candidate)) {
        this.rejectInput(state, 'MALFORMED_LINE', 'Malformed serial line rejected; board readiness invalidated.');
        return;
      } else {
        this.acceptLine(state, candidate);
      }
      newline = state.buffer.indexOf('\n');
    }

    if (state.buffer.length > this.maxLineLength) {
      this.rejectInput(state, 'LINE_TOO_LONG', 'Oversized serial line rejected; board readiness invalidated.');
      return;
    }
  }

  acceptLine(state, rawLine) {
    const at = this.now();
    const parsed = parseBoardLine(state.device, rawLine);
    state.lastLineAt = at;
    if (parsed.phase) {
      state.phase = parsed.phase;
      if (parsed.phase === 'HEALTHY' || parsed.phase === 'OBSERVING') state.readinessAt = at;
      else state.readinessAt = 0;
    }
    this.emit('event', {
      kind: 'line', code: 'BOARD_LINE', device: state.device, path: state.path,
      sessionId: state.sessionId, line: redactSensitiveSerialText(rawLine), parsed, at
    });
  }

  async disconnect(device) {
    const state = this.devices.get(device);
    if (!state) return;
    state.readinessAt = 0;
    if (!state.port.isOpen) {
      if (!state.closed) {
        state.closed = true;
        state.connected = false;
        state.phase = 'DISCONNECTED';
        state.readinessAt = 0;
        this.emit('event', { kind: 'closed', code: 'PORT_CLOSED', device, path: state.path, sessionId: state.sessionId, message: 'Serial port closed; readiness invalidated.' });
      }
      if (this.devices.get(device) === state) this.devices.delete(device);
      return;
    }
    await new Promise(resolve => {
      state.port.close(() => {
        if (!state.closed) {
          state.connected = false;
          state.closed = true;
          state.phase = 'DISCONNECTED';
          state.readinessAt = 0;
          this.emit('event', { kind: 'closed', code: 'PORT_CLOSED', device, path: state.path, sessionId: state.sessionId, message: 'Serial port closed; readiness invalidated.' });
        }
        if (this.devices.get(device) === state) this.devices.delete(device);
        resolve();
      });
    });
  }

  async closeAll() {
    await Promise.all([...this.devices.keys()].map(device => this.disconnect(device)));
  }
}

module.exports = {
  SerialManager, validateBoardCommand, normalizeCommandRequest, parseBoardLine, redactSensitiveSerialText,
  READINESS_TTL_MS, PROTECTED_PAIR_COMMANDS
};
