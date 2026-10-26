import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const uno = await readFile(new URL("../firmware/uno_controller/uno_controller.ino", import.meta.url), "utf8");
const esp = await readFile(new URL("../firmware/esp32_guardian/esp32_guardian.ino", import.meta.url), "utf8");
const protocol = await readFile(new URL("../docs/SENTINEL_PROTOCOL.md", import.meta.url), "utf8");

test("both endpoints use S3 framing and V3 identities", () => {
  assert.match(uno, /PSTR\("S3\|%S\|%s\|%lu\|%s"\)/);
  assert.match(uno, /STREQ\(f(?:ields)?\[0\],\s*"S3"\)/);
  assert.match(esp, /"S3\|%s\|%s\|%lu\|%s"/);
  assert.match(esp, /strcmp\(fields\[0\],\s*"S3"\)\s*!=\s*0/);
  assert.match(uno, /UNO-ATM-V3/);
  assert.match(esp, /UNO-ATM-V3/);
  assert.match(esp, /ESP32-SENTINEL-V3/);
  assert.match(protocol, /S3\|<type>\|<session>\|<seq>\|<payload>\|<crc16>/);
});

test("retries preserve startup message identities instead of incrementing sequence counters", () => {
  const unoHello = /sendFrameAtSequence\s*\(\s*F\("HELLO"\)\s*,\s*F\("UNO-ATM-V3"\)\s*,\s*1\s*\)/g;
  assert.ok((uno.match(unoHello) ?? []).length >= 2, "Uno must retry the same HELLO at sequence 1");
  assert.match(uno, /sendFrameAtSequence\s*\(\s*F\("ACK"\)\s*,\s*F\("HELLO_ACCEPTED"\)\s*,\s*2\s*\)/);
  const espHello = /sendFrameAtSequence\s*\(\s*"HELLO"\s*,\s*"ESP32-SENTINEL-V3"\s*,\s*1\s*\)/g;
  assert.ok((esp.match(espHello) ?? []).length >= 2, "ESP32 must retry the same HELLO at sequence 1");
  assert.match(esp, /sendFrameAtSequence\s*\(\s*"ACK"\s*,\s*"HELLO_ACCEPTED"\s*,\s*2\s*\)/);
});

test("exact handshake duplicates are handled before strict sequence progression", () => {
  const unoDuplicate = uno.search(/if\s*\(\s*guardianHelloSeen\s*&&\s*seq\s*==\s*1\s*&&\s*STREQ\(type,\s*"HELLO"\)/);
  const unoSequenceCheck = uno.search(/if\s*\(\s*seq\s*!=\s*lastGuardianSequence\s*\+\s*1UL\s*\)/);
  assert.ok(unoDuplicate >= 0 && unoSequenceCheck > unoDuplicate, "Uno duplicate HELLO must be idempotent before sequence-gap enforcement");
  const espDuplicate = esp.search(/if\s*\(\s*strcmp\(type,\s*"HELLO"\)\s*==\s*0\s*&&\s*seq\s*==\s*initialUnoHelloSequence/);
  const espSequenceCheck = esp.search(/if\s*\(\s*seq\s*!=\s*lastUnoSequence\s*\+\s*1UL\s*\)/);
  assert.ok(espDuplicate >= 0 && espSequenceCheck > espDuplicate, "ESP32 duplicate HELLO must be idempotent before sequence-gap enforcement");
});

test("Uno is not ready after the first guardian HELLO; final ACK completes the handshake", () => {
  const handlerStart = uno.indexOf("void handleGuardianLine(char *line)");
  const handlerEnd = uno.indexOf("void pollGuardian()", handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  const handler = uno.slice(handlerStart, handlerEnd);
  const helloBranch = handler.search(/if\s*\(\s*STREQ\(type,\s*"HELLO"\)\s*\)/);
  const ackBranch = handler.search(/if\s*\(\s*STREQ\(type,\s*"ACK"\)\s*\)/);
  const readySet = handler.search(/handshakeComplete\s*=\s*true\s*;/);
  assert.ok(helloBranch >= 0 && ackBranch > helloBranch && readySet > ackBranch);
  assert.match(handler.slice(helloBranch, ackBranch), /sendFrameAtSequence\s*\(\s*F\("ACK"\)\s*,\s*F\("HELLO_ACCEPTED"\)\s*,\s*2\s*\)/);
  assert.doesNotMatch(handler.slice(helloBranch, ackBranch), /handshakeComplete\s*=\s*true/);
});

test("ESP32 gates transaction requests on completed negotiation", () => {
  const requestStart = esp.indexOf("void handleRequest(const char *payload)");
  const requestEnd = esp.indexOf("void handleUnoLine(char *line)", requestStart);
  assert.ok(requestStart >= 0 && requestEnd > requestStart, "ESP32 request handler must exist");
  const requestHandler = esp.slice(requestStart, requestEnd);
  assert.match(requestHandler, /if\s*\(!handshakeConfirmed\)/);
  assert.match(requestHandler, /Transaction request before V3 handshake completion/);
  assert.match(esp, /HANDSHAKE_TIMEOUT_MS\s*=\s*8000UL/);
  assert.match(uno, /HANDSHAKE_TIMEOUT_MS\s*=\s*8000UL/);
  assert.match(uno, /V3 handshake timeout; clean paired restart required/);
});

test("protocol documentation requires a matched pair and idempotent retries", () => {
  assert.match(protocol, /both board sketches must be flashed as a matched pair/i);
  assert.match(protocol, /retries reuse the original sequence and payload/i);
  assert.match(protocol, /withholds the session REVOKE frame because the Uno may not have received the final ACK yet/i);
  assert.match(esp, /if\s*\(heartbeatSeen\)\s*sendFrame\("REVOKE",\s*"POLICY_REVOKE"\)/);
});

test("Uno serializes heartbeat/status traffic over its timed peer UART", () => {
  assert.match(uno, /bool\s+awaitingGuardianStatus\s*=\s*false\s*;/);
  assert.match(uno, /awaitingGuardianStatus\s*=\s*true\s*;/);
  assert.match(uno, /!awaitingGuardianStatus[\s\S]*sendHeartbeat\(now\)/);
  const statusBranch = uno.search(/if\s*\(\s*STREQ\(type,\s*"STATUS"\)\s*\)/);
  assert.ok(statusBranch >= 0, "Uno must have a STATUS receive branch");
  assert.match(uno.slice(statusBranch, statusBranch + 420), /awaitingGuardianStatus\s*=\s*false\s*;/);
  assert.match(esp, /pendingHealthyStatus\s*=\s*true;/);
  assert.match(esp, /HEALTHY_STATUS_TURNAROUND_MS\s*=\s*100UL/);
  assert.match(esp, /if\s*\(pendingHealthyStatus[\s\S]*?sendFrameAtSequence\("STATUS",\s*"HEALTHY",\s*healthyStatusSequence\)/,
    "ESP32 must defer HEALTHY STATUS and retry the same sequence instead of replying inside the heartbeat RX handler");
  assert.match(esp, /HEALTHY_STATUS_RETRY_MS\s*=\s*250UL/);
  assert.match(esp, /HEALTHY_STATUS_MAX_ATTEMPTS\s*=\s*3/);
  assert.match(uno, /lastGuardianStatusSequence\s*!=\s*0/);
  assert.match(uno, /MAX_INITIAL_STATUS_FRAME_DROPS\s*=\s*3/);
  assert.match(protocol, /at most one.{0,80}HEARTBEAT/i);
  assert.match(protocol, /clears the outstanding-heartbeat flag only after receiving and validating a STATUS/i);
  assert.match(uno, /if\s*\(sendFrame\(F\("HEARTBEAT"\),\s*payload\)\)\s*\{[\s\S]{0,180}lastHeartbeatAt\s*=\s*millis\(\)/);
});


test("Uno peer UART uses timer-assisted AltSoftSerial on fixed Uno pins", () => {
  assert.match(uno, /#include <AltSoftSerial\.h>/);
  assert.match(uno, /AltSoftSerial\s+GuardianSerial\s*;/);
  assert.match(uno, /PEER_RX_PIN\s*=\s*8/);
  assert.match(uno, /PEER_TX_PIN\s*=\s*9/);
  assert.doesNotMatch(uno, /SoftwareSerial/);
  assert.match(uno, /SENTINEL ATM CONTROLLER V3\.3 READY/);
  assert.match(protocol, /AltSoftSerial[\s\S]{0,100}D8 RX[\s\S]{0,40}D9 TX/i);
});

test("Uno receiver diagnostics distinguish missing bytes from incomplete lines", () => {
  assert.ok(uno.includes("guardianRxByteCount"));
  assert.ok(uno.includes("guardianRxLineCount"));
  assert.ok(uno.includes("[UART_DIAG] rx_bytes="));
  assert.ok(uno.includes("byte_age_ms="));
  assert.ok(uno.includes("line_age_ms="));
  assert.ok(uno.includes("++guardianRxByteCount;"));
  assert.ok(uno.includes("++guardianRxLineCount;"));
});

test("ESP32 flushes completed STATUS bytes locally without claiming peer acceptance", () => {
  assert.ok(esp.includes('if (strcmp(type, "STATUS") == 0)'));
  assert.ok(esp.includes("Serial2.flush();"));
  assert.ok(esp.includes("peer acceptance still unconfirmed"));
});

test("guardian commit-reconciliation log includes the exact matched transaction ID and amount", () => {
  assert.ok(esp.includes('[AUDIT] Matching controller-reported virtual transaction commit observed id='));
  assert.ok(esp.includes('Serial.print(pendingPermitId);'));
  assert.ok(esp.includes('Serial.println(pendingPermitAmount);'));
});

test("both boards use the same slower peer UART and bounded status retry contract", () => {
  assert.match(uno, /PEER_BAUD\s*=\s*4800/);
  assert.match(esp, /PEER_BAUD\s*=\s*4800/);
  assert.match(protocol, /UART:\*\* 4800 baud/);
  assert.match(protocol, /at most three total transmissions/);
  assert.match(protocol, /600 ms retry window/);
});

test("ESP32 safely drops malformed pre-session UART noise and keeps revocation latched", () => {
  const handlerStart = esp.indexOf("void handleUnoLine(char *line)");
  const handlerEnd = esp.indexOf("void pollUno()", handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, "ESP32 UNO frame handler must exist");
  const handler = esp.slice(handlerStart, handlerEnd);
  assert.match(handler, /if\s*\(revokeLatched\)\s*return;/,
    "a latched revoke must prevent later frames from changing guardian state");
  const parseStart = handler.indexOf("if (!parseFrame(line, fields, seq))");
  const typeStart = handler.indexOf("const char *type", parseStart);
  assert.ok(parseStart >= 0 && typeStart > parseStart);
  const malformedBranch = handler.slice(parseStart, typeStart);
  assert.match(malformedBranch, /if\s*\(!sessionEstablished\)/,
    "malformed startup noise must be distinguished from malformed session traffic");
  assert.match(malformedBranch, /LINK_DROP.*pre-session UART noise/);
  assert.match(malformedBranch, /revoke\("Malformed frame, overlong input, CRC or protocol-version failure\."\)/,
    "malformed frames after session establishment must still fail closed");
});
