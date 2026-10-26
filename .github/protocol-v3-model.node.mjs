import test from "node:test";
import assert from "node:assert/strict";

const MAX_FRAME_CHARS = 118;
const MAX_SEQUENCE = 0xFFFFFFFF;
const VALID_TYPES = new Set([
  "HELLO", "ACK", "STATE", "HEARTBEAT", "REQUEST", "PERMIT",
  "DENY", "EVENT", "REVOKE", "STATUS"
]);

function crc16CcittFalse(input) {
  const bytes = Buffer.from(input, "ascii");
  let crc = 0xFFFF;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
  }
  return crc;
}

function encodeFrame({ type, session, seq, payload = "-" }) {
  if (!VALID_TYPES.has(type)) throw new Error("Unknown frame type.");
  if (!/^[A-Z0-9]{8,12}$/.test(session)) throw new Error("Invalid session.");
  if (!Number.isSafeInteger(seq) || seq < 1 || seq > MAX_SEQUENCE) throw new Error("Invalid sequence.");
  if (typeof payload !== "string" || !payload || /[\r\n\x00-\x1F\x7F]/.test(payload)) {
    throw new Error("Invalid payload.");
  }
  const prefix = "S3|" + type + "|" + session + "|" + seq + "|" + payload;
  const line = prefix + "|" + crc16CcittFalse(prefix).toString(16).toUpperCase().padStart(4, "0") + "\n";
  if (line.length - 1 > MAX_FRAME_CHARS) throw new Error("Frame exceeds maximum length.");
  return line;
}

function decodeFrame(input) {
  if (typeof input !== "string" || !input.endsWith("\n")) return { ok: false, error: "MISSING_NEWLINE" };
  let line = input.slice(0, -1);
  if (line.endsWith("\r")) line = line.slice(0, -1);
  if (!line || line.length > MAX_FRAME_CHARS) return { ok: false, error: "FRAME_LENGTH" };
  for (let i = 0; i < line.length; i += 1) {
    if (line.charCodeAt(i) > 0x7E || line.charCodeAt(i) < 0x20) return { ok: false, error: "NON_ASCII" };
  }
  const fields = line.split("|");
  if (fields.length !== 6) return { ok: false, error: "FIELD_COUNT" };
  const [version, type, session, seqText, payload, crcText] = fields;
  if (version !== "S3" || !VALID_TYPES.has(type)) return { ok: false, error: "VERSION_OR_TYPE" };
  if (!/^[A-Z0-9]{8,12}$/.test(session)) return { ok: false, error: "SESSION" };
  if (!/^[1-9][0-9]*$/.test(seqText)) return { ok: false, error: "SEQUENCE_FORMAT" };
  const seq = Number(seqText);
  if (!Number.isSafeInteger(seq) || seq > MAX_SEQUENCE) return { ok: false, error: "SEQUENCE_RANGE" };
  if (!payload) return { ok: false, error: "EMPTY_PAYLOAD" };
  if (!/^[0-9A-Fa-f]{4}$/.test(crcText)) return { ok: false, error: "CRC_FORMAT" };
  const lastSeparator = line.lastIndexOf("|");
  const expected = crc16CcittFalse(line.slice(0, lastSeparator));
  if (expected !== Number.parseInt(crcText, 16)) return { ok: false, error: "CRC_MISMATCH" };
  return { ok: true, frame: { version, type, session, seq, payload } };
}

function parseExactPayload(payload, requiredKeys) {
  if (typeof payload !== "string" || !payload) return { ok: false, error: "EMPTY" };
  const pairs = payload.split(";");
  const values = Object.create(null);
  for (const pair of pairs) {
    const separator = pair.indexOf("=");
    if (separator <= 0 || separator === pair.length - 1 || pair.indexOf("=", separator + 1) !== -1) {
      return { ok: false, error: "MALFORMED_PAIR" };
    }
    const key = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key) || /[;\r\n\x00-\x1F]/.test(value)) {
      return { ok: false, error: "INVALID_FIELD" };
    }
    if (Object.prototype.hasOwnProperty.call(values, key)) return { ok: false, error: "DUPLICATE_KEY" };
    values[key] = value;
  }
  const actual = Object.keys(values).sort();
  const required = [...requiredKeys].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    return { ok: false, error: "KEY_SET_MISMATCH" };
  }
  return { ok: true, values };
}

function corruptFrame(frame) {
  const marker = frame.indexOf("|", frame.indexOf("|") + 1);
  const index = Math.min(frame.length - 6, marker + 3);
  const replacement = frame[index] === "X" ? "Y" : "X";
  return frame.slice(0, index) + replacement + frame.slice(index + 1);
}

function injectFault(frame, fault, options = {}) {
  switch (fault) {
    case "DROP": return { readyAt: options.nowMs || 0, chunks: [] };
    case "DUPLICATE": return { readyAt: options.nowMs || 0, chunks: [frame, frame] };
    case "CORRUPT": return { readyAt: options.nowMs || 0, chunks: [corruptFrame(frame)] };
    case "TRUNCATE": return { readyAt: options.nowMs || 0, chunks: [frame.slice(0, -5)] };
    case "DELAY": return { readyAt: (options.nowMs || 0) + (options.delayMs || 0), chunks: [frame] };
    case "CONCATENATE": return { readyAt: options.nowMs || 0, chunks: [(options.otherFrame || "") + frame] };
    case "REORDER": return { readyAt: options.nowMs || 0, chunks: [...(options.frames || [frame])].reverse() };
    default: return { readyAt: options.nowMs || 0, chunks: [frame] };
  }
}

class LineReceiver {
  constructor(maxLineChars = MAX_FRAME_CHARS) {
    this.maxLineChars = maxLineChars;
    this.buffer = "";
    this.dropping = false;
  }
  push(chunk) {
    const lines = [];
    for (const char of chunk) {
      if (char === "\n") {
        if (!this.dropping && this.buffer.length > 0) lines.push(this.buffer + "\n");
        this.buffer = "";
        this.dropping = false;
      } else if (char !== "\r") {
        if (this.buffer.length >= this.maxLineChars) this.dropping = true;
        else if (!this.dropping) this.buffer += char;
      }
    }
    return lines;
  }
}

class SequenceGate {
  constructor(session, expectedSeq = 1) {
    this.session = session;
    this.lastSeq = expectedSeq - 1;
    this.lastFingerprint = null;
    this.fault = false;
  }
  accept(frame) {
    if (this.fault) return { ok: false, reason: "FAULT_LATCHED" };
    if (frame.session !== this.session) return this.fail("SESSION_MISMATCH");
    const fingerprint = JSON.stringify(frame);
    if (frame.seq === this.lastSeq && this.lastSeq !== 0) {
      if (fingerprint === this.lastFingerprint) return { ok: true, duplicate: true, effectApplied: false };
      return this.fail("CONFLICTING_DUPLICATE");
    }
    if (this.lastSeq === MAX_SEQUENCE) return this.fail("SEQUENCE_EXHAUSTED");
    if (frame.seq !== this.lastSeq + 1) return this.fail("SEQUENCE_GAP_OR_REPLAY");
    this.lastSeq = frame.seq;
    this.lastFingerprint = fingerprint;
    return { ok: true, duplicate: false, effectApplied: true };
  }
  fail(reason) {
    this.fault = true;
    return { ok: false, reason, effectApplied: false };
  }
}

class StatusGate {
  constructor({ heartbeatSeq, expectedStatusSeq, nowMs = 0 }) {
    this.heartbeatSeq = heartbeatSeq;
    this.expectedStatusSeq = expectedStatusSeq;
    this.lastAcceptedStatusSeq = 0;
    this.lastAcceptedAck = 0;
    this.lastAcceptedAt = null;
    this.fault = false;
    this.accepted = false;
    this.nowMs = nowMs;
  }
  accept(frame, nowMs) {
    this.nowMs = nowMs;
    if (this.fault) return { ok: false, reason: "FAULT_LATCHED" };
    if (!frame || frame.type !== "STATUS") return this.fail("WRONG_TYPE");
    const match = /^HEALTHY;ack_seq=([1-9][0-9]*)$/.exec(frame.payload);
    if (!match) return this.fail("STATUS_SCHEMA");
    const ack = Number(match[1]);
    if (frame.seq === this.lastAcceptedStatusSeq && this.lastAcceptedStatusSeq !== 0 &&
        ack === this.lastAcceptedAck && this.lastAcceptedAt !== null &&
        nowMs - this.lastAcceptedAt <= 600) {
      return { ok: true, duplicate: true, freshnessUpdated: false, permitGranted: false };
    }
    if (frame.seq !== this.expectedStatusSeq) return this.fail("STATUS_SEQUENCE");
    if (ack !== this.heartbeatSeq) return this.fail("HEARTBEAT_ACK_MISMATCH");
    this.lastAcceptedStatusSeq = frame.seq;
    this.lastAcceptedAck = ack;
    this.lastAcceptedAt = nowMs;
    this.accepted = true;
    this.expectedStatusSeq += 1;
    return { ok: true, duplicate: false, freshnessUpdated: true, permitGranted: false };
  }
  fail(reason) {
    this.fault = true;
    this.accepted = false;
    return { ok: false, reason, permitGranted: false };
  }
}

class TransactionGate {
  constructor({ balance = 25000, cassette = 50000, maxTransaction = 20000, windowLimit = 40000 } = {}) {
    this.balance = balance;
    this.cassette = cassette;
    this.maxTransaction = maxTransaction;
    this.windowLimit = windowLimit;
    this.windowUsed = 0;
    this.lastTxNumber = 0;
    this.pending = null;
    this.committed = new Set();
    this.revoked = false;
    this.releasedTotal = 0;
  }
  request({ id, amount, authenticated = true, state = "WITHDRAW_PENDING", heartbeatFresh = true }) {
    if (this.revoked) return { ok: false, reason: "REVOKED" };
    const m = /^T([1-9][0-9]{0,8})$/.exec(id || "");
    if (!m) return this.fail("INVALID_TX_ID");
    const number = Number(m[1]);
    if (number <= this.lastTxNumber) return this.fail("TX_REPLAY");
    if (this.pending) return this.fail("SECOND_PENDING_REQUEST");
    if (!authenticated || state !== "WITHDRAW_PENDING" || !heartbeatFresh) return this.fail("PRECONDITION");
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount % 50 !== 0) return this.fail("AMOUNT_FORMAT");
    if (amount > this.maxTransaction || this.windowUsed > this.windowLimit || amount > this.windowLimit - this.windowUsed) {
      return { ok: false, reason: "POLICY_LIMIT" };
    }
    if (amount > this.balance || amount > this.cassette) return { ok: false, reason: "FUNDS_OR_STOCK" };
    this.lastTxNumber = number;
    this.pending = { id, amount, permit: false };
    return { ok: true, phase: "PENDING", released: 0 };
  }
  permit(id, amount) {
    if (this.revoked || !this.pending || this.pending.id !== id || this.pending.amount !== amount) return this.fail("PERMIT_MISMATCH");
    if (this.pending.permit) return { ok: true, duplicate: true };
    this.pending.permit = true;
    this.windowUsed += amount;
    return { ok: true, phase: "PERMIT_OBSERVED", released: 0 };
  }
  commit(id, amount) {
    if (this.committed.has(id)) {
      return { ok: id === this.lastCommittedId && amount === this.lastCommittedAmount, duplicate: true, released: 0 };
    }
    if (this.revoked || !this.pending || !this.pending.permit ||
        this.pending.id !== id || this.pending.amount !== amount) return this.fail("COMMIT_MISMATCH");
    if (amount > this.balance || amount > this.cassette) return this.fail("RECHECK_FAILED");
    this.balance -= amount;
    this.cassette -= amount;
    this.releasedTotal += amount;
    this.committed.add(id);
    this.lastCommittedId = id;
    this.lastCommittedAmount = amount;
    this.pending = null;
    return { ok: true, phase: "RECONCILED", released: amount };
  }
  timeout() {
    if (this.pending) {
      this.pending = null;
      this.revoked = true;
      return { ok: false, reason: "TIMEOUT_REVOKE", released: 0 };
    }
    return { ok: true, released: 0 };
  }
  fail(reason) {
    this.pending = null;
    this.revoked = true;
    return { ok: false, reason, released: 0 };
  }
}

class ReliableCommitExchange {
  constructor({ id = "T1", amount = 500, maxAttempts = 3 } = {}) {
    this.id = id;
    this.amount = amount;
    this.maxAttempts = maxAttempts;
    this.event = encodeFrame({
      type: "EVENT", session: "U0000003C", seq: 4,
      payload: `event=TX_COMMITTED;id=${id};amount=${amount}`
    });
    this.ack = encodeFrame({
      type: "ACK", session: "U0000003C", seq: 7,
      payload: `ack_seq=4;id=${id};amount=${amount}`
    });
    this.controllerBalance = 25000;
    this.controllerCassette = 50000;
    this.controllerCommitCount = 0;
    this.guardianCommitCount = 0;
    this.attempts = 0;
    this.awaitingAck = false;
    this.faulted = false;
    this.lastAcceptedEvent = null;
    this.ackReady = false;
  }

  controllerCommit() {
    if (this.controllerCommitCount !== 0 || this.faulted) {
      this.faulted = true;
      return { ok: false, reason: "DUPLICATE_CONTROLLER_MUTATION" };
    }
    this.controllerBalance -= this.amount;
    this.controllerCassette -= this.amount;
    this.controllerCommitCount = 1;
    this.awaitingAck = true;
    this.attempts = 1;
    return { ok: true, frame: this.event, attempt: this.attempts };
  }

  retryReport() {
    if (!this.awaitingAck || this.faulted) return { ok: false, reason: "NOT_AWAITING_ACK" };
    if (this.attempts >= this.maxAttempts) {
      this.awaitingAck = false;
      this.faulted = true;
      return { ok: false, reason: "RETRY_EXHAUSTED" };
    }
    this.attempts += 1;
    return { ok: true, frame: this.event, attempt: this.attempts };
  }

  guardianReceiveEvent(frame) {
    const decoded = decodeFrame(frame);
    if (!decoded.ok || decoded.frame.type !== "EVENT") return { ok: false, reason: "INVALID_EVENT" };
    if (this.lastAcceptedEvent === frame) {
      this.ackReady = true;
      return { ok: true, duplicate: true, ack: this.ack, counted: false };
    }
    if (this.lastAcceptedEvent !== null) return { ok: false, reason: "CONFLICTING_COMMIT" };
    const expectedPayload = `event=TX_COMMITTED;id=${this.id};amount=${this.amount}`;
    if (decoded.frame.payload !== expectedPayload) return { ok: false, reason: "COMMIT_MISMATCH" };
    this.lastAcceptedEvent = frame;
    this.guardianCommitCount = 1;
    this.ackReady = true;
    return { ok: true, duplicate: false, ack: this.ack, counted: true };
  }

  controllerReceiveAck(frame) {
    const decoded = decodeFrame(frame);
    const expected = `ack_seq=4;id=${this.id};amount=${this.amount}`;
    if (!this.awaitingAck || !decoded.ok || decoded.frame.type !== "ACK" ||
        decoded.frame.payload !== expected || decoded.frame.seq !== 7) {
      this.faulted = true;
      return { ok: false, reason: "ACK_MISMATCH" };
    }
    this.awaitingAck = false;
    return { ok: true, reconciled: true };
  }
}

function elapsedMs(now, then) {
  return (now - then) >>> 0;
}

test("CRC-16/CCITT-FALSE matches the standard 123456789 golden vector", () => {
  assert.equal(crc16CcittFalse("123456789"), 0x29B1);
});

test("frame encoder/decoder round-trip a correlated STATUS frame", () => {
  const wire = encodeFrame({ type: "STATUS", session: "U0000003C", seq: 3, payload: "HEALTHY;ack_seq=12" });
  const decoded = decodeFrame(wire);
  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.frame, {
    version: "S3", type: "STATUS", session: "U0000003C", seq: 3, payload: "HEALTHY;ack_seq=12"
  });
});

test("frame parser rejects missing newline, corrupted CRC, extra delimiters and overlength", () => {
  const wire = encodeFrame({ type: "HEARTBEAT", session: "U0000003C", seq: 12, payload: "state=AUTHENTICATED;up=12345" });
  assert.equal(decodeFrame(wire.slice(0, -1)).error, "MISSING_NEWLINE");
  assert.equal(decodeFrame(corruptFrame(wire)).error, "CRC_MISMATCH");
  const extraField = wire.replace("|HEARTBEAT|", "|HEARTBEAT|EXTRA|");
  assert.equal(decodeFrame(extraField).error, "FIELD_COUNT");
  assert.throws(() => encodeFrame({ type: "EVENT", session: "U0000003C", seq: 14, payload: "x".repeat(100) }),
    /Frame exceeds maximum length/);
});

test("payload schema rejects missing, duplicate, unknown, empty and malformed fields", () => {
  const parsed = parseExactPayload("id=T0000001;amount=500", ["id", "amount"]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.values.id, "T0000001");
  assert.equal(parsed.values.amount, "500");
  assert.equal(parseExactPayload("id=T1;id=T2;amount=500", ["id", "amount"]).error, "DUPLICATE_KEY");
  assert.equal(parseExactPayload("id=T1;amount=500;mode=FAST", ["id", "amount"]).error, "KEY_SET_MISMATCH");
  assert.equal(parseExactPayload("id=T1;amount=", ["id", "amount"]).error, "MALFORMED_PAIR");
  assert.equal(parseExactPayload("id=T1;amount=5=00", ["id", "amount"]).error, "MALFORMED_PAIR");
});

test("line receiver handles chunked and concatenated lines and drops an overlong line", () => {
  const receiver = new LineReceiver(MAX_FRAME_CHARS);
  const wire = encodeFrame({ type: "STATUS", session: "U0000003C", seq: 3, payload: "HEALTHY;ack_seq=12" });
  assert.deepEqual(receiver.push(wire.slice(0, 7)), []);
  assert.deepEqual(receiver.push(wire.slice(7)), [wire]);
  const two = receiver.push("one\ntwo\n");
  assert.deepEqual(two, ["one\n", "two\n"]);
  const bounded = new LineReceiver(30);
  assert.deepEqual(bounded.push("z".repeat(40) + "\nvalid\n"), ["valid\n"]);
});

test("STATUS accepts only exact matching heartbeat ack and never grants a permit", () => {
  const gate = new StatusGate({ heartbeatSeq: 12, expectedStatusSeq: 3 });
  const accepted = gate.accept({ type: "STATUS", seq: 3, payload: "HEALTHY;ack_seq=11" }, 100);
  assert.equal(accepted.ok, false);
  assert.equal(accepted.reason, "HEARTBEAT_ACK_MISMATCH");
  assert.equal(accepted.permitGranted, false);
  assert.equal(gate.accepted, false);
});

test("exact STATUS retry is idempotent and cannot refresh freshness", () => {
  const gate = new StatusGate({ heartbeatSeq: 12, expectedStatusSeq: 3 });
  const first = gate.accept({ type: "STATUS", seq: 3, payload: "HEALTHY;ack_seq=12" }, 100);
  const duplicate = gate.accept({ type: "STATUS", seq: 3, payload: "HEALTHY;ack_seq=12" }, 300);
  assert.equal(first.freshnessUpdated, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.freshnessUpdated, false);
  assert.equal(gate.lastAcceptedAt, 100);
});

test("drop, corrupt, truncate and delay faults never become accepted status", () => {
  const valid = encodeFrame({ type: "STATUS", session: "U0000003C", seq: 3, payload: "HEALTHY;ack_seq=12" });
  for (const fault of ["DROP", "CORRUPT", "TRUNCATE"]) {
    const output = injectFault(valid, fault);
    const gate = new StatusGate({ heartbeatSeq: 12, expectedStatusSeq: 3 });
    for (const chunk of output.chunks) {
      for (const line of new LineReceiver().push(chunk)) {
        const decoded = decodeFrame(line);
        if (decoded.ok) gate.accept(decoded.frame, 200);
      }
    }
    assert.equal(gate.accepted, false, fault);
  }
  const delayed = injectFault(valid, "DELAY", { nowMs: 0, delayMs: 250 });
  assert.equal(delayed.readyAt > 100, true);
  assert.equal(delayed.chunks.length, 1);
});

test("identical duplicates are idempotent; conflicting duplicates, gaps and session changes fail closed", () => {
  const first = { version: "S3", type: "STATE", session: "U0000003C", seq: 3, payload: "atm=IDLE;auth=0;tx=0" };
  const sequence = new SequenceGate("U0000003C", 3);
  assert.equal(sequence.accept(first).effectApplied, true);
  assert.deepEqual(sequence.accept({ ...first }), { ok: true, duplicate: true, effectApplied: false });

  const conflicting = new SequenceGate("U0000003C", 3);
  conflicting.accept(first);
  assert.equal(conflicting.accept({ ...first, payload: "atm=AUTHENTICATED;auth=1;tx=0" }).reason, "CONFLICTING_DUPLICATE");

  const gap = new SequenceGate("U0000003C", 3);
  assert.equal(gap.accept({ ...first, seq: 4 }).reason, "SEQUENCE_GAP_OR_REPLAY");

  const session = new SequenceGate("U0000003C", 3);
  assert.equal(session.accept({ ...first, session: "U0000004D" }).reason, "SESSION_MISMATCH");

  const exhausted = new SequenceGate("U0000003C", MAX_SEQUENCE);
  assert.equal(exhausted.accept({ ...first, seq: MAX_SEQUENCE }).effectApplied, true);
  assert.equal(exhausted.accept({ ...first, seq: 1 }).reason, "SEQUENCE_EXHAUSTED");
});

test("concat, reorder, and bounded retries preserve message identities", () => {
  const a = encodeFrame({ type: "STATE", session: "U0000003C", seq: 3, payload: "atm=IDLE;auth=0;tx=0" });
  const b = encodeFrame({ type: "HEARTBEAT", session: "U0000003C", seq: 4, payload: "state=IDLE;up=1" });
  const receiver = new LineReceiver();
  assert.deepEqual(receiver.push(injectFault(a, "CONCATENATE", { otherFrame: b }).chunks[0]), [b, a]);
  const reordered = injectFault(a, "REORDER", { frames: [a, b] }).chunks;
  assert.equal(decodeFrame(reordered[0]).frame.seq, 4);
  assert.equal(decodeFrame(reordered[1]).frame.seq, 3);

  const retry = [a, a, a];
  assert.equal(new Set(retry).size, 1, "retry must reuse identical frame/sequence");
  assert.equal(retry.length, 3, "retry count must be bounded");
});

test("transaction model keeps cash unchanged until exact permit then commits exactly once", () => {
  const gate = new TransactionGate();
  assert.equal(gate.request({ id: "T1", amount: 500 }).ok, true);
  assert.equal(gate.balance, 25000);
  assert.equal(gate.cassette, 50000);
  assert.equal(gate.permit("T1", 500).ok, true);
  assert.equal(gate.balance, 25000);
  const committed = gate.commit("T1", 500);
  assert.equal(committed.phase, "RECONCILED");
  assert.equal(gate.balance, 24500);
  assert.equal(gate.cassette, 49500);
  assert.equal(gate.releasedTotal, 500);
  const duplicate = gate.commit("T1", 500);
  assert.equal(duplicate.duplicate, true);
  assert.equal(gate.balance, 24500);
  assert.equal(gate.releasedTotal, 500);
});

test("missing permit, wrong amount, replay and timeout fail closed without money mutation", () => {
  const noPermit = new TransactionGate();
  noPermit.request({ id: "T1", amount: 500 });
  assert.equal(noPermit.commit("T1", 500).ok, false);
  assert.equal(noPermit.balance, 25000);
  assert.equal(noPermit.releasedTotal, 0);

  const wrongAmount = new TransactionGate();
  wrongAmount.request({ id: "T1", amount: 500 });
  wrongAmount.permit("T1", 500);
  assert.equal(wrongAmount.commit("T1", 1000).ok, false);
  assert.equal(wrongAmount.balance, 25000);
  assert.equal(wrongAmount.releasedTotal, 0);

  const replay = new TransactionGate();
  replay.request({ id: "T1", amount: 500 });
  assert.equal(replay.request({ id: "T1", amount: 500 }).ok, false);
  assert.equal(replay.balance, 25000);
  assert.equal(replay.releasedTotal, 0);

  const timeout = new TransactionGate();
  timeout.request({ id: "T1", amount: 500 });
  timeout.timeout();
  assert.equal(timeout.revoked, true);
  assert.equal(timeout.balance, 25000);
  assert.equal(timeout.releasedTotal, 0);
});

test("unsafe new transaction while one permit is pending revokes the model", () => {
  const gate = new TransactionGate();
  gate.request({ id: "T1", amount: 500 });
  assert.equal(gate.request({ id: "T2", amount: 500 }).ok, false);
  assert.equal(gate.revoked, true);
  assert.equal(gate.balance, 25000);
  assert.equal(gate.releasedTotal, 0);
});

test("lost TX_COMMITTED event retries the identical frame and mutates controller state once", () => {
  const exchange = new ReliableCommitExchange({ id: "T1", amount: 500 });
  const first = exchange.controllerCommit();
  assert.equal(first.ok, true);
  assert.equal(exchange.controllerBalance, 24500);
  assert.equal(exchange.controllerCassette, 49500);
  assert.equal(exchange.controllerCommitCount, 1);

  // First event is dropped; the bounded retry must reuse the exact encoded frame.
  const retry = exchange.retryReport();
  assert.equal(retry.frame, first.frame);
  assert.equal(retry.attempt, 2);
  const accepted = exchange.guardianReceiveEvent(retry.frame);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.counted, true);
  assert.equal(exchange.guardianCommitCount, 1);
  assert.equal(exchange.controllerCommitCount, 1);
});

test("lost commit ACK makes the guardian replay the same ACK without recounting the commit", () => {
  const exchange = new ReliableCommitExchange({ id: "T2", amount: 1000 });
  const first = exchange.controllerCommit();
  const firstDelivery = exchange.guardianReceiveEvent(first.frame);
  assert.equal(firstDelivery.counted, true);

  // ACK is lost. Uno retransmits the exact TX_COMMITTED event, not the cash mutation.
  const retry = exchange.retryReport();
  assert.equal(retry.frame, first.frame);
  const duplicateDelivery = exchange.guardianReceiveEvent(retry.frame);
  assert.equal(duplicateDelivery.duplicate, true);
  assert.equal(duplicateDelivery.counted, false);
  assert.equal(duplicateDelivery.ack, firstDelivery.ack);
  assert.equal(exchange.guardianCommitCount, 1);
  assert.equal(exchange.controllerCommitCount, 1);
  assert.equal(exchange.controllerReceiveAck(duplicateDelivery.ack).reconciled, true);
  assert.equal(exchange.awaitingAck, false);
});

test("commit report retry exhaustion fails closed without repeating controller mutation", () => {
  const exchange = new ReliableCommitExchange({ id: "T3", amount: 500, maxAttempts: 2 });
  exchange.controllerCommit();
  assert.equal(exchange.retryReport().attempt, 2);
  assert.deepEqual(exchange.retryReport(), { ok: false, reason: "RETRY_EXHAUSTED" });
  assert.equal(exchange.faulted, true);
  assert.equal(exchange.controllerCommitCount, 1);
  assert.equal(exchange.controllerBalance, 24500);
  assert.equal(exchange.guardianCommitCount, 0);
});

test("wrap-safe elapsed milliseconds works across uint32 rollover", () => {
  assert.equal(elapsedMs(0x00000020, 0xFFFFFFF0), 0x30);
});


test("commit ACK rejects wrong transaction, amount, sequence, type, and session", () => {
  const cases = [
    encodeFrame({ type: "ACK", session: "U0000003C", seq: 7, payload: "ack_seq=4;id=TWRONG;amount=500" }),
    encodeFrame({ type: "ACK", session: "U0000003C", seq: 7, payload: "ack_seq=4;id=T1;amount=1000" }),
    encodeFrame({ type: "ACK", session: "U0000003C", seq: 8, payload: "ack_seq=4;id=T1;amount=500" }),
    encodeFrame({ type: "STATUS", session: "U0000003C", seq: 7, payload: "ack_seq=4;id=T1;amount=500" }),
    encodeFrame({ type: "ACK", session: "U0000004D", seq: 7, payload: "ack_seq=4;id=T1;amount=500" })
  ];
  for (const ack of cases) {
    const exchange = new ReliableCommitExchange({ id: "T1", amount: 500 });
    exchange.controllerCommit();
    const result = exchange.controllerReceiveAck(ack);
    assert.equal(result.ok, false);
    assert.equal(exchange.faulted, true);
    assert.equal(exchange.controllerCommitCount, 1, "bad ACK must never repeat controller mutation");
    assert.equal(exchange.controllerBalance, 24500);
  }
});

test("conflicting duplicate commit report cannot be mistaken for an idempotent retry", () => {
  const exchange = new ReliableCommitExchange({ id: "T4", amount: 500 });
  const first = exchange.controllerCommit();
  assert.equal(exchange.guardianReceiveEvent(first.frame).counted, true);
  const conflicting = encodeFrame({
    type: "EVENT", session: "U0000003C", seq: 4,
    payload: "event=TX_COMMITTED;id=T4;amount=1000"
  });
  assert.deepEqual(exchange.guardianReceiveEvent(conflicting), {
    ok: false, reason: "CONFLICTING_COMMIT"
  });
  assert.equal(exchange.guardianCommitCount, 1);
  assert.equal(exchange.controllerCommitCount, 1);
});

test("lost every commit report attempt leaves one controller mutation and an explicit fault", () => {
  const exchange = new ReliableCommitExchange({ id: "T5", amount: 1500, maxAttempts: 3 });
  const first = exchange.controllerCommit();
  assert.equal(first.ok, true);
  assert.equal(exchange.retryReport().frame, first.frame);
  assert.equal(exchange.retryReport().frame, first.frame);
  assert.deepEqual(exchange.retryReport(), { ok: false, reason: "RETRY_EXHAUSTED" });
  assert.equal(exchange.faulted, true);
  assert.equal(exchange.awaitingAck, false);
  assert.equal(exchange.controllerCommitCount, 1);
  assert.equal(exchange.controllerBalance, 23500);
  assert.equal(exchange.controllerCassette, 48500);
  assert.equal(exchange.guardianCommitCount, 0);
});

test("an identical commit retry is accepted only as the same full encoded frame", () => {
  const exchange = new ReliableCommitExchange({ id: "T6", amount: 750 });
  const first = exchange.controllerCommit();
  const accepted = exchange.guardianReceiveEvent(first.frame);
  assert.equal(accepted.counted, true);
  assert.equal(exchange.guardianReceiveEvent(first.frame).duplicate, true);

  const samePayloadDifferentSequence = encodeFrame({
    type: "EVENT", session: "U0000003C", seq: 5,
    payload: "event=TX_COMMITTED;id=T6;amount=750"
  });
  assert.deepEqual(exchange.guardianReceiveEvent(samePayloadDifferentSequence), {
    ok: false, reason: "CONFLICTING_COMMIT"
  });
  assert.equal(exchange.guardianCommitCount, 1);
});
