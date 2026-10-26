const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  SerialManager, validateBoardCommand, normalizeCommandRequest, parseBoardLine
} = require('./serial-manager.cjs');

class FakePort extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.isOpen = false;
    this.writes = [];
    this.writeError = null;
    this.drainError = null;
  }
  open(callback) {
    this.isOpen = true;
    queueMicrotask(() => callback(null));
  }
  write(text, callback) {
    if (this.writeError) return callback(this.writeError);
    this.writes.push(text);
    callback(null);
  }
  drain(callback) {
    callback(this.drainError);
  }
  close(callback) {
    this.isOpen = false;
    this.emit('close');
    callback(null);
  }
  feed(text) {
    this.emit('data', Buffer.from(text, 'utf8'));
  }
}

function makeHarness(options = {}) {
  let now = 10000;
  const created = new Map();
  const emitted = [];
  const ports = [
    { path: '/dev/ttyUNO', manufacturer: 'Test USB' },
    { path: '/dev/ttyESP', manufacturer: 'Test USB' }
  ];
  const manager = new SerialManager({
    listPorts: async () => ports,
    createPort: config => {
      const port = new FakePort(config);
      created.set(config.path, port);
      return port;
    },
    now: () => now,
    ...options
  });
  manager.on('event', event => emitted.push(event));
  return {
    manager, created, emitted,
    setNow(value) { now = value; },
    advance(ms) { now += ms; },
    async connectPair() {
      await manager.connect('uno', '/dev/ttyUNO', 115200);
      await manager.connect('sentinel', '/dev/ttyESP', 115200);
      return { uno: created.get('/dev/ttyUNO'), sentinel: created.get('/dev/ttyESP') };
    },
    async markPairReady() {
      const pair = { uno: created.get('/dev/ttyUNO'), sentinel: created.get('/dev/ttyESP') };
      pair.uno.feed('[STATUS_RX] Accepted HEALTHY\r\n');
      pair.sentinel.feed('GUARDIAN_STATUS|mode=OBSERVING\r\n');
      return pair;
    }
  };
}

test('UNO allowlist accepts documented commands and rejects arbitrary serial instructions', () => {
  assert.equal(validateBoardCommand('uno', 'STATUS').ok, true);
  assert.equal(validateBoardCommand('uno', 'ADD_ACCOUNT CARD01 4826 50000').ok, true);
  assert.equal(validateBoardCommand('uno', 'SET_CASH 20 20 20 20').ok, true);
  assert.equal(validateBoardCommand('uno', 'CARD CARD01').ok, true);
  assert.equal(validateBoardCommand('uno', 'PIN 4826').ok, true);
  assert.equal(validateBoardCommand('uno', 'WITHDRAW 500').ok, true);
  assert.equal(validateBoardCommand('uno', 'WITHDRAW 520').ok, false);
  assert.equal(validateBoardCommand('uno', 'RUN_SHELL rm -rf /').ok, false);
  assert.equal(validateBoardCommand('uno', 'STATUS\nFIXTURE_MISMATCH').ok, false);
  assert.equal(validateBoardCommand('uno', 'PIN 123').ok, false);
  assert.equal(validateBoardCommand('uno', 'STATUS  BALANCE').ok, false);
});

test('ESP32 allowlist accepts guardian policy diagnostics and labelled fixtures only', () => {
  assert.equal(validateBoardCommand('sentinel', 'STATUS').ok, true);
  assert.equal(validateBoardCommand('sentinel', 'SET_LIMITS 20000 40000').ok, true);
  assert.equal(validateBoardCommand('sentinel', 'FIXTURE_REVOKE').ok, true);
  assert.equal(validateBoardCommand('sentinel', 'ADD_ACCOUNT CARD01 4826 50000').ok, false);
  assert.equal(validateBoardCommand('sentinel', 'SET_POLICY 20000 40000 1800 2600 86400000 9 60000 1800').ok, true);
  assert.equal(validateBoardCommand('sentinel', 'SET_POLICY 20000 40000 4000 2600 86400000 9 60000 1800').ok, false);
});

test('IPC command requests must be structured, canonical, and allowlisted', () => {
  assert.deepEqual(normalizeCommandRequest('uno', { name: 'STATUS', args: [] }), {
    ok: true, command: 'STATUS', commandName: 'STATUS', sensitive: false
  });
  assert.equal(normalizeCommandRequest('uno', 'STATUS').ok, false);
  assert.equal(normalizeCommandRequest('uno', { name: 'STATUS', args: [], raw: 'anything' }).ok, false);
  assert.equal(normalizeCommandRequest('uno', { name: 'WITHDRAW', args: ['520'] }).ok, false);
  assert.equal(normalizeCommandRequest('uno', { name: 'PIN', args: ['4826', 'FIXTURE_MISMATCH'] }).ok, false);
  assert.equal(normalizeCommandRequest('sentinel', { name: 'ADD_ACCOUNT', args: ['CARD01', '4826', '50000'] }).ok, false);
});

test('known board lines become narrow typed events without exposing sensitive fields', () => {
  assert.deepEqual(parseBoardLine('uno', '[STATUS_RX] Accepted HEALTHY'), {
    type: 'UNO_HEALTHY', phase: 'HEALTHY'
  });
  assert.deepEqual(parseBoardLine('sentinel', 'GUARDIAN_STATUS|mode=OBSERVING'), {
    type: 'GUARDIAN_OBSERVING', phase: 'OBSERVING'
  });
  assert.deepEqual(parseBoardLine('sentinel', '[PERMIT] One-shot observation issued for T0000007; amount=500'), {
    type: 'PERMIT', id: 'T0000007', amount: 500
  });
  assert.deepEqual(parseBoardLine('sentinel', '[RECONCILE] Matching controller-reported virtual commit id=T0000007;amount=500'), {
    type: 'COMMIT_RECONCILIATION', id: 'T0000007', amount: 500
  });
  const event = parseBoardLine('uno', 'ATM_EVENT|WITHDRAWAL_PENDING|id=TX01;amount=500;pin=4826');
  assert.deepEqual(event, { type: 'ATM_EVENT', eventName: 'WITHDRAWAL_PENDING', id: 'TX01', amount: 500, balance: undefined, reason: undefined });
  assert.equal(JSON.stringify(event).includes('4826'), false);
});

test('fragmented input, concatenated lines and CRLF are framed correctly', async () => {
  const h = makeHarness();
  await h.manager.connect('uno', '/dev/ttyUNO', 115200);
  const port = h.created.get('/dev/ttyUNO');
  port.feed('SENTINEL ATM CONTROLLER V3.4 READY\r');
  port.feed('\n[STATUS_RX] Accepted ');
  port.feed('HEALTHY\r\nATM_EVENT|WITHDRAWAL_PENDING|id=TX01;amount=500\r\n');
  const lines = h.emitted.filter(event => event.kind === 'line');
  assert.equal(lines.length, 3);
  assert.equal(lines[0].parsed.type, 'BOARD_BOOT');
  assert.equal(lines[1].parsed.type, 'UNO_HEALTHY');
  assert.equal(lines[2].parsed.eventName, 'WITHDRAWAL_PENDING');
  assert.equal(lines.every(event => event.sessionId), true);
  assert.equal(h.manager.getReadinessSnapshot().boards.uno.phase, 'HEALTHY');
});

test('connection alone is never pair readiness and protected commands fail closed', async () => {
  const h = makeHarness();
  const pair = await h.connectPair();
  assert.equal(h.manager.isPairReady(), false);
  await assert.rejects(
    h.manager.writeCommand('uno', { name: 'WITHDRAW', args: ['500'] }),
    /Connection alone is not readiness/
  );
  await h.markPairReady();
  assert.equal(h.manager.isPairReady(), true);
  const result = await h.manager.writeCommand('uno', { name: 'WITHDRAW', args: ['500'] });
  assert.equal(result.ok, true);
  assert.equal(pair.uno.writes[0], 'WITHDRAW 500\n');
});

test('readiness expires at the host gate even if unrelated console text keeps arriving', async () => {
  const h = makeHarness();
  const pair = await h.connectPair();
  await h.markPairReady();
  h.advance(3400);
  pair.uno.feed('[INFO] unrelated diagnostic\n');
  h.advance(101);
  assert.equal(h.manager.getReadinessSnapshot().boards.uno.phase, 'STALE');
  assert.equal(h.manager.isPairReady(), false);
  await assert.rejects(
    h.manager.writeCommand('uno', { name: 'BALANCE', args: [] }),
    /fresh HEALTHY\/OBSERVING/
  );
});

test('role ownership prevents double-connect and assigning one path to two roles', async () => {
  const h = makeHarness();
  await h.manager.connect('uno', '/dev/ttyUNO', 115200);
  await assert.rejects(h.manager.connect('uno', '/dev/ttyESP', 115200), /already connected/);
  await assert.rejects(h.manager.connect('sentinel', '/dev/ttyUNO', 115200), /already assigned/);
  await h.manager.connect('sentinel', '/dev/ttyESP', 115200);
  assert.equal(h.manager.getReadinessSnapshot().boards.uno.connected, true);
  await h.manager.closeAll();
});

test('oversized and malformed input invalidate readiness and release the port', async () => {
  const h = makeHarness({ maxLineLength: 16 });
  const pair = await h.connectPair();
  await h.markPairReady();
  pair.uno.feed('X'.repeat(17) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.emitted.some(event => event.code === 'LINE_TOO_LONG'), true);
  assert.equal(h.manager.getReadinessSnapshot().boards.uno.connected, false);
  await h.manager.connect('uno', '/dev/ttyUNO', 115200);
  h.created.get('/dev/ttyUNO').feed('\tSTATUS\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.emitted.some(event => event.code === 'MALFORMED_LINE'), true);
  assert.equal(h.manager.getReadinessSnapshot().boards.uno.connected, false);
});

test('unplug invalidates the session and pair readiness immediately', async () => {
  const h = makeHarness();
  const pair = await h.connectPair();
  await h.markPairReady();
  assert.equal(h.manager.isPairReady(), true);
  pair.sentinel.isOpen = false;
  pair.sentinel.emit('close');
  const snapshot = h.manager.getReadinessSnapshot();
  assert.equal(snapshot.pairReady, false);
  assert.equal(snapshot.boards.sentinel.connected, false);
  assert.equal(h.emitted.some(event => event.kind === 'closed' && event.device === 'sentinel'), true);
});

test('write failures redact diagnostics, clear readiness and release the connection', async () => {
  const h = makeHarness();
  const pair = await h.connectPair();
  await h.markPairReady();
  pair.uno.writeError = new Error('synthetic failure carrying PIN 4826');
  await assert.rejects(h.manager.writeCommand('uno', { name: 'BALANCE', args: [] }), /Serial write failed/);
  assert.equal(h.emitted.some(event => event.code === 'WRITE_FAILED'), true);
  assert.equal(JSON.stringify(h.emitted).includes('4826'), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.manager.getReadinessSnapshot().boards.uno.connected, false);
});

test('PIN-bearing commands never place their values in command diagnostics', async () => {
  const h = makeHarness();
  const pair = await h.connectPair();
  await h.markPairReady();
  await h.manager.writeCommand('uno', { name: 'PIN', args: ['4826'] });
  const commandEvent = h.emitted.find(event => event.kind === 'command-written');
  assert.equal(commandEvent.commandName, 'PIN');
  assert.equal(commandEvent.sensitive, true);
  assert.equal(JSON.stringify(h.emitted).includes('4826'), false);
  assert.equal(pair.uno.writes[0], 'PIN 4826\n');
});
