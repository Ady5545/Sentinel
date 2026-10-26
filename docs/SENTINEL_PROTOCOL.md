# SENTINEL UNO ↔ ESP32 Protocol Specification — v2

**Status:** Implemented firmware proposal; build and hardware bench validation required  
**UART:** 9600 baud, 8 data bits, no parity, 1 stop bit  
**USB diagnostics/desktop command link:** 115200 baud  
**Boards:** one Arduino Uno (ATM-controller demo) + one ESP32 DevKit (guardian demo)

## Safety properties

- No heartbeat, serial text or self-reported string alone authorizes dispensing.
- The ESP32 issues a **one-shot, transaction-ID-correlated** PERMIT only after validating the current reported state, fresh heartbeat, unseen transaction ID, amount format, and guardian-side amount budget.
- A policy rejection returns a correlated DENY. Unexpected protocol/state behavior, replay, timeout, or failed commit reconciliation latches REVOKE.
- The Uno commits fictional balance and note inventory only after a matching permit for the current pending transaction.
- Desktop virtual cash is a separate authority boundary and must independently deny every unpermitted transaction.
- CRC is not authentication; session IDs and counters are not cryptographic proof.

## Frame format

    S2|<type>|<session>|<seq>|<payload>|<crc16>\n

- Fixed ASCII framing, newline required, maximum line length bounded by the firmware parser.
- CRC-16/CCITT-FALSE, polynomial 0x1021, initial 0xFFFF, no reflection, xorout 0x0000, four hexadecimal digits.
- Receivers reject malformed field counts, unsupported version, invalid session characters, invalid sequence format, CRC mismatch, overlong frames, stale/duplicate/skipped sequence and unknown message types.
- Each direction has its own sequence counter. Reboot establishes a new session; sequence/session tokens are not cryptographic.
- Frames and payload fields are bounded; no dynamic allocation is based on peer-controlled lengths.

## Message types

| Direction | Type | Meaning |
|---|---|---|
| UNO → ESP32 | HELLO | Starts a new demo session (UNO-ATM-V2) |
| ESP32 → UNO | HELLO | Announces entry into the observed Uno session; sent once per startup handshake |
| UNO → ESP32 | STATE | Reports atm, auth, and committed transaction count |
| UNO → ESP32 | HEARTBEAT | Reports state and uptime; receiver timestamps receipt locally |
| UNO → ESP32 | REQUEST | Requests guardian evaluation for one withdrawal, e.g. id=T0000001;amount=500 |
| ESP32 → UNO | PERMIT | One-shot permit correlated to pending transaction ID |
| ESP32 → UNO | DENY | Policy refusal correlated to transaction ID |
| UNO → ESP32 | EVENT | Reports authentication/fixture/transaction evidence |
| ESP32 → UNO | REVOKE | Latches guardian authority revoked; does not self-clear |
| ESP32 → UNO | STATUS | Guardian liveness response to a validated UNO HEARTBEAT; no permit |
| UNO → ESP32 | ACK | Diagnostic protocol observation; never grants authority |

## Half-duplex handshake and liveness scheduling

The Uno's `SoftwareSerial` link cannot reliably receive while the Uno is transmitting. To avoid startup collisions, the ESP32 responds to the first UNO `HELLO` with exactly one ESP32 `HELLO` frame; it must not send an immediate second startup frame. The Uno then sends its `ACK` and initial `STATE`. The ESP32 sends `STATUS|HEALTHY` only after it has received and validated a UNO `HEARTBEAT`, so the Uno is not transmitting while the guardian replies. Each subsequent valid heartbeat receives one status response; the ESP32 must not send timer-driven status frames independently of the heartbeat. Missing or invalid heartbeats still fail closed.

## Guardian policy

The guardian expects known ATM states: UNCOMMISSIONED, IDLE, PIN_PENDING, AUTHENTICATED, WITHDRAW_PENDING, LOCKED, GUARDIAN_LOCKED. It checks the allowed transition table and the reported authentication flag against the state. It rejects a withdrawal request unless state is WITHDRAW_PENDING, the authentication flag is reported true, the last validated heartbeat is fresh, the transaction identifier is syntactically valid and strictly increasing, and the amount is a positive multiple of ₹50. Controller-side and guardian-side policy limits both apply. The defaults are configurable through the respective local USB console and are held in RAM. The Uno full command is SET_POLICY MAX WINDOW WINDOW_MS PIN_TRIES LOCKOUT_MS PIN_TIMEOUT_MS SESSION_TIMEOUT_MS GUARDIAN_TIMEOUT_MS TX_TIMEOUT_MS; the ESP32 full command is SET_POLICY MAX WINDOW HEARTBEAT_MS LINK_TIMEOUT_MS WINDOW_MS PIN_FAILS PIN_WINDOW_MS COMMIT_MS. Short SET_POLICY/SET_LIMITS forms change only the amount limits. The Uno TX_TIMEOUT_MS and guardian COMMIT_MS must be configured consistently.

On permit, the ESP32 records the transaction identifier/amount and expects a matching subsequent UNO commit event within a deadline. A mismatched or missing commit triggers REVOKE. The guardian independently counts reported PIN failures over a short window and can revoke at its configured threshold. Test fixtures are labelled SIMULATED; they do not constitute real compromise detection.

## Uno ATM workflow

Runtime operator setup creates up to four fictional demo accounts using ADD_ACCOUNT CARD_ID PIN START_BALANCE, and sets virtual cash counts using SET_CASH. The active customer may change a demo PIN via CHANGE_PIN CURRENT_PIN NEW_PIN CONFIRM_NEW_PIN while authenticated. No preset PIN exists. Customer flow: CARD, PIN, then BALANCE or WITHDRAW. Three failed PIN attempts cause a temporary demo lockout; PIN entry and authenticated sessions time out; invalid amounts, insufficient balance, policy limits, unavailable denominations, missing guardian and stale/revoked state block withdrawals. All customer state is RAM-only and wiped on reset.

## Known limitations

This protocol does not use HMAC, digital signatures, a protected shared secret, secure element, hardware identity, secure boot configured, or an independently trusted PIN-entry device. The Uno's PIN/result/state are reported by its own firmware. A compromised Uno can fabricate normal-looking state and events; a compromised ESP32 can issue incorrect decisions. CRC detects accidental corruption, not deliberate forgery. The firmware is not a physical dispenser interlock. No real account/PIN, real network, or physical cash may be connected. Production-grade ATM security requires a distinct hardware/key-management architecture and independent review.
