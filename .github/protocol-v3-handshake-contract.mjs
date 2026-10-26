import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const uno = await readFile(new URL("../firmware/uno_controller/uno_controller.ino", import.meta.url), "utf8");
const esp = await readFile(new URL("../firmware/esp32_guardian/esp32_guardian.ino", import.meta.url), "utf8");
const protocol = await readFile(new URL("../docs/SENTINEL_PROTOCOL.md", import.meta.url), "utf8");

test("both endpoints use S3 framing and V3 identities", () => {
  assert.match(uno, /PSTR\("S3\|%S\|%s\|%lu\|%s"\)/);
  assert.match(uno, /STREQ\(fields\[0\], "S3"\)/);
  assert.match(esp, /"S3\|%s\|%s\|%lu\|%s"/);
  assert.match(esp, /strcmp\(fields\[0\], "S3"\) != 0/);
  assert.match(uno, /UNO-ATM-V3/);
  assert.match(esp, /UNO-ATM-V3/);
  assert.match(esp, /ESP32-SENTINEL-V3/);
  assert.match(protocol, /S3\|<type>\|<session>\|<seq>\|<payload>\|<crc16>/);
});

test("retries preserve startup message identities instead of incrementing sequence counters", () => {
  assert.ok((uno.match(/sendFrameAtSequence\(F\("HELLO"\), F\("UNO-ATM-V3"\), 1\)/g) ?? []).length >= 2);
  assert.match(uno, /sendFrameAtSequence\(F\("ACK"\), F\("HELLO_ACCEPTED"\), 2\)/);
  assert.ok((esp.match(/sendFrameAtSequence\("HELLO", "ESP32-SENTINEL-V3", 1\)/g) ?? []).length >= 2);
  assert.match(esp, /sendFrameAtSequence\("ACK", "HELLO_ACCEPTED", 2\)/);
});

test("exact handshake duplicates are handled before strict sequence progression", () => {
  const unoDuplicate = uno.indexOf('if (guardianHelloSeen && seq == 1 && STREQ(type, "HELLO")');
  const unoSequenceCheck = uno.indexOf("if (seq != lastGuardianSequence + 1UL)");
  assert.ok(unoDuplicate >= 0 && unoSequenceCheck > unoDuplicate, "Uno duplicate HELLO must be idempotent before sequence-gap enforcement");
  const espDuplicate = esp.indexOf('if (strcmp(type, "HELLO") == 0 && seq == initialUnoHelloSequence');
  const espSequenceCheck = esp.indexOf("if (seq != lastUnoSequence + 1UL)");
  assert.ok(espDuplicate >= 0 && espSequenceCheck > espDuplicate, "ESP32 duplicate HELLO must be idempotent before sequence-gap enforcement");
});

test("Uno is not ready after the first guardian HELLO; final ACK completes the handshake", () => {
  const helloBranch = uno.indexOf('if (STREQ(type, "HELLO"))');
  const ackBranch = uno.indexOf('if (STREQ(type, "ACK"))');
  const readySet = uno.indexOf("handshakeComplete = true;", helloBranch);
  assert.ok(helloBranch >= 0 && ackBranch > helloBranch && readySet > ackBranch);
  assert.match(uno.slice(helloBranch, ackBranch), /sendFrameAtSequence\(F\("ACK"\), F\("HELLO_ACCEPTED"\), 2\)/);
  assert.doesNotMatch(uno.slice(helloBranch, ackBranch), /handshakeComplete = true/);
});

test("ESP32 gates transaction requests on completed negotiation", () => {
  const requestStart = esp.indexOf("void handleRequest(const char *payload)");
  const requestEnd = esp.indexOf("void handleUnoLine(char *line)", requestStart);
  const requestHandler = esp.slice(requestStart, requestEnd);
  assert.match(requestHandler, /if \(!handshakeConfirmed\)/);
  assert.match(requestHandler, /Transaction request before V3 handshake completion/);
  assert.match(esp, /HANDSHAKE_TIMEOUT_MS = 8000UL/);
  assert.match(uno, /HANDSHAKE_TIMEOUT_MS = 8000UL/);
  assert.match(uno, /V3 handshake timeout; clean paired restart required/);
});

test("protocol documentation requires a matched pair and idempotent retries", () => {
  assert.match(protocol, /both board sketches must be flashed as a matched pair/i);
  assert.match(protocol, /retries reuse the original sequence and payload/i);
  assert.match(protocol, /withholds the session REVOKE frame because the Uno may not have received the final ACK yet/i);
  assert.match(esp, /if \(heartbeatSeen\) sendFrame\("REVOKE", "POLICY_REVOKE"\)/);
});
