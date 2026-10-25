# SENTINEL UNO + ESP32 Firmware v1

## Objective
Implement the first real two-board firmware protocol for the SENTINEL research prototype. The Arduino Uno is the ATM primary-controller stand-in. The ESP32 DevKit is an independent guardian that evaluates messages and emits PERMIT/REVOKE observations. The desktop simulator remains the final authority over virtual cash; no board is connected to a physical dispenser.

## Hardware and upload targets
- Arduino IDE target: Arduino Uno / ATmega328P, 16 MHz.
- Arduino IDE target: ESP32 Dev Module (confirm exact board variant in Tools > Board).
- UART: 9600 baud, 8N1; no external libraries required.
- USB diagnostic console: 115200 baud on each board.
- UNO software UART: TX D3 and RX D2 using SoftwareSerial; keep hardware UART pins D0/D1 available for USB upload and diagnostics.
- ESP32 UART2: RX GPIO16 and TX GPIO17.
- Common GND.
- UNO TX (5 V) to ESP32 RX must use a suitable level shifter or divider. Existing divider is 2.2 kΩ series and 2.2 kΩ to GND: nominally about 2.5 V, which may be marginal for guaranteed ESP32 high-level recognition. Prefer a proper 5 V-to-3.3 V level shifter or calculate a divider suitable for the actual input thresholds. Do not connect 5 V UNO TX directly to an ESP32 GPIO.
- ESP32 TX is 3.3 V and can normally be read as HIGH by the UNO.
- Boards are powered by USB; don't join 5 V and 3.3 V rails. Join grounds only.
- Do not connect motors, solenoids, bank networks, or real ATM hardware.

## Protocol v1
ASCII line frames, maximum 120 bytes including newline:

    S1|TYPE|SESSION|SEQ|PAYLOAD|CRC16\n

CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF, no reflection, xorout 0x0000), four uppercase hex digits, computed over every byte before the final |CRC separator. Reject malformed, overlong, unknown-version, invalid-CRC, invalid-session, unknown-type, invalid-field and stale/duplicate-sequence frames. Input buffers are fixed-size. A newline is required before a frame is considered complete. On overflow, discard through the next newline.

Types:
- UNO → ESP32: HELLO, HEARTBEAT, STATE, EVENT, REQUEST
- ESP32 → UNO: HELLO, ACK, PERMIT, REVOKE, STATUS
- ESP32 STATUS and desktop bridge messages are observations only; no serial message directly dispenses virtual cash.

Session is an 8–12 character uppercase alphanumeric boot token. Sequence starts at 1 and increases by one per outgoing frame in a session. Sequence gaps, duplicates and stale frames revoke protected authority; receiver must not update liveness on invalid frames. Session changes require explicit handshake and reset state to fail-closed. This simple token is not cryptographic authentication.

## UNO state machine
BOOT_SAFE → IDLE → SESSION_ACTIVE → REQUEST_PENDING. Any malformed incoming guardian frame, guardian timeout, explicit REVOKE or invalid state transition enters GUARDIAN_LOCKED. Requests never cause physical output. The Uno reports a simulated controller state and accepts only a fresh guardian PERMIT observation for its current session; the desktop remains authoritative and independently validates the policy decision.

UNO sends:
- HELLO at boot and periodically until guardian response.
- HEARTBEAT every 500 ms, including controller state and uptime.
- STATE when state changes.
- REQUEST for a generated demo dispense request only when the local state machine allows a test request.
- EVENT for a defined demo event.
UNO must not self-grant guardian authority.

## ESP32 guardian state machine
STARTING → OBSERVING → PERMITTED (only after handshake, valid frames, fresh heartbeat and legal state) → REVOKED on malformed/stale/duplicate frames, illegal state, reported profile mismatch, sequence gap, heartbeat timeout, or explicit test fixture. Recovery requires explicit operator acknowledgement and a fresh handshake; never restore permit automatically after a revoke.

Evidence source labels:
- BOARD_REPORTED: values sent by UNO, not independently verified.
- PROTOCOL_VALIDATED: syntax/CRC/session/sequence checks passed.
- SIMULATED: deliberately injected fixture.
The ESP32 does not have a trusted secure element in this project. It cannot prove arbitrary firmware integrity.

## Build and validation sequence
1. Upload ESP32 sketch. Confirm SENTINEL ESP32 GUARDIAN READY on USB monitor at 115200.
2. Upload Uno sketch. Confirm SENTINEL UNO CONTROLLER READY.
3. Connect common GND, Uno D3 TX through a safe divider/level shifter to ESP32 GPIO16 RX, and ESP32 GPIO17 TX to Uno D2 RX. Do not wire D0/D1 to the peer board.
4. Open one USB monitor at a time if needed; close Arduino IDE monitors before Electron takes serial ownership.
5. Verify HELLO, ACK, heartbeat and protocol counters first.
6. Run test fixtures: invalid CRC, stale sequence, malformed frame, heartbeat timeout, explicit simulated integrity mismatch, disconnect/reconnect. The expected result is REVOKE and lock, not a successful dispense.
7. Verify that recovery requires explicit acknowledgement and new handshake.
8. Desktop integration is a separate gate: board serial observations must be parsed, normalized and evaluated by the desktop domain gate before they affect virtual dispenser state.
9. Do not claim end-to-end hardware protection until the desktop integration tests confirm denied requests leave both account balance and virtual cassette inventory unchanged.

## Limitations
CRC detects accidental corruption, not a malicious sender. A self-reported firmware build identifier, state string or heartbeat is not attestation. An attacker controlling the UNO firmware can emit expected values. The demo proves only detection of the configured protocol and state-machine violations. The ESP32 is not a physical cash-dispenser interlock; this firmware cannot authorize a real ATM.
