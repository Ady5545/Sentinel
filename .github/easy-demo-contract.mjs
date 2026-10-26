import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const uno = readFileSync('firmware/uno_controller/uno_controller.ino', 'utf8');
const esp = readFileSync('firmware/esp32_guardian/esp32_guardian.ino', 'utf8');

test('Uno uses the agreed simple D2/D3 SoftwareSerial link at 4800 baud', () => {
  assert.match(uno, /#include <SoftwareSerial\.h>/);
  assert.match(uno, /GUARDIAN_RX = 2/);
  assert.match(uno, /GUARDIAN_TX = 3/);
  assert.match(uno, /LINK_BAUD = 4800/);
  assert.match(uno, /SoftwareSerial GuardianSerial\(GUARDIAN_RX, GUARDIAN_TX\)/);
});

test('ESP32 uses UART2 GPIO16/GPIO17 at the same baud rate', () => {
  assert.match(esp, /GUARDIAN_RX = 16/);
  assert.match(esp, /GUARDIAN_TX = 17/);
  assert.match(esp, /LINK_BAUD = 4800/);
  assert.match(esp, /Serial2\.begin\(LINK_BAUD, SERIAL_8N1, GUARDIAN_RX, GUARDIAN_TX\)/);
});

test('both firmwares share the simple heartbeat and simulated-event message contract', () => {
  assert.match(uno, /UNO\|ONLINE/);
  assert.match(uno, /GUARDIAN\|ONLINE/);
  assert.match(uno, /EVENT\|SIMULATED\|PROFILE_MISMATCH/);
  assert.match(esp, /UNO\|ONLINE/);
  assert.match(esp, /GUARDIAN\|ONLINE/);
  assert.match(esp, /EVENT\|SIMULATED\|PROFILE_MISMATCH/);
  assert.match(esp, /GUARDIAN\|REVOKED\|/);
});

test('Uno denies virtual dispensing if guardian is stale, pending, or revoked', () => {
  assert.match(uno, /GUARDIAN_TIMEOUT_MS = 2200/);
  assert.match(uno, /revoked \|\| attackPending \|\| !fresh/);
  assert.match(uno, /Virtual dispensing DENIED until both boards are restarted/);
});

test('ESP32 revocation is latched and documented as a simulated demo event', () => {
  assert.match(esp, /if \(revoked\) return/);
  assert.match(esp, /software-generated demo event, not proof of real hardware compromise/);
  assert.match(uno, /Sent does not prove 'received'/);
});

test('operator commands are intentionally small and hardcoded', () => {
  for (const command of ['HELP', 'STATUS', 'DEMO_ATTACK', 'WITHDRAW']) {
    assert.ok(uno.includes(command), `Uno should document/support ${command}`);
  }
  for (const command of ['HELP', 'STATUS']) {
    assert.ok(esp.includes(command), `ESP32 should document/support ${command}`);
  }
});
