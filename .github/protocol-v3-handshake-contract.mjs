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
  const unoHello = /sendFrameAt\s*\(\s*F\("HELLO"\)\s*,\s*F\("UNO-ATM-V3"\)\s*,\s*1\s*\)/g;
  assert.ok((uno.match(unoHello) ?? []).length >= 2, "Uno must retry the same HELLO at sequence 1");
  assert.match(uno, /sendFrameAt\s*\(\s*F\("ACK"\)\s*,\s*F\("HELLO_ACCEPTED"\)\s*,\s*2\s*\)/);
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
  assert.match(handler.slice(helloBranch, ackBranch), /sendFrameAt\s*\(\s*F\("ACK"\)\s*,\s*F\("HELLO_ACCEPTED"\)\s*,\s*2\s*\)/);
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

test("Uno serializes heartbeat/status traffic for SoftwareSerial", () => {
  assert.match(uno, /bool\s+awaitingGuardianStatus\s*=\s*false\s*;/);
  assert.match(uno, /awaitingGuardianStatus\s*=\s*true\s*;/);
  assert.match(uno, /!awaitingGuardianStatus[\s\S]*sendHeartbeat\(now\)/);
  const statusBranch = uno.search(/if\s*\(\s*STREQ\(type,\s*"STATUS"\)\s*\)/);
  assert.ok(statusBranch >= 0, "Uno must have a STATUS receive branch");
  assert.match(uno.slice(statusBranch, statusBranch + 420), /awaitingGuardianStatus\s*=\s*false\s*;/);
  assert.match(esp, /if\s*\(!revokeLatched\)\s*sendFrame\("STATUS",\s*"HEALTHY"\);/);
  assert.match(protocol, /at most one.{0,80}HEARTBEAT/i);
  assert.match(protocol, /clears the outstanding-heartbeat flag only after receiving and validating that STATUS/i);
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
