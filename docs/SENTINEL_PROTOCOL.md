# SENTINEL UNO ↔ ESP32 Protocol Specification — v3

**Status:** V3 handshake implementation; build and hardware bench validation required  
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

    S3|<type>|<session>|<seq>|<payload>|<crc16>\n

- Fixed ASCII framing, newline required, maximum line length bounded by the firmware parser.
- CRC-16/CCITT-FALSE, polynomial 0x1021, initial 0xFFFF, no reflection, xorout 0x0000, four hexadecimal digits.
- Receivers reject malformed field counts, unsupported version, invalid session characters, invalid sequence format, CRC mismatch, overlong frames, unexplained sequence gaps, conflicting duplicates, and unknown message types. Exact startup HELLO/handshake-ACK duplicates are recognized only in the defined negotiation window and do not repeat domain effects.
- Each direction has its own sequence counter. Reboot establishes a new session; sequence/session tokens are not cryptographic.
- Frames and payload fields are bounded; no dynamic allocation is based on peer-controlled lengths.

## Message types

| Direction | Type | Meaning |
|---|---|---|
| UNO → ESP32 | HELLO | Starts a new demo session (UNO-ATM-V3, sequence 1) |
| ESP32 → UNO | HELLO | Announces V3 negotiation (sequence 1); retried identically until controller ACK |
| UNO → ESP32 | STATE | Reports atm, auth, and committed transaction count |
| UNO → ESP32 | HEARTBEAT | Reports state and uptime; receiver timestamps receipt locally |
| UNO → ESP32 | REQUEST | Requests guardian evaluation for one withdrawal, e.g. id=T0000001;amount=500 |
| ESP32 → UNO | PERMIT | One-shot permit correlated to pending transaction ID |
| ESP32 → UNO | DENY | Policy refusal correlated to transaction ID |
| UNO → ESP32 | EVENT | Reports authentication/fixture/transaction evidence |
| ESP32 → UNO | REVOKE | Latches guardian authority revoked; does not self-clear |
| ESP32 → UNO | STATUS | Guardian liveness response to a validated UNO HEARTBEAT; no permit |
| UNO ↔ ESP32 | ACK | Exact handshake acknowledgement; never grants transaction authority |

## V3 session handshake, retry, and liveness scheduling

The frame prefix is \`S3\`; both board sketches must be flashed as a matched pair. V2 (\`S2\`) frames are rejected. Do not mix one V2 sketch with one V3 sketch.

The handshake is a four-message exchange with fixed sequence identities:

1. UNO sends \`S3|HELLO|<session>|1|UNO-ATM-V3|<crc>\`.
2. ESP32 accepts only the initial HELLO at sequence 1 for a new session and sends \`HELLO\` at ESP32 sequence 1.
3. UNO acknowledges with \`ACK|HELLO_ACCEPTED\` at UNO sequence 2 but does **not** publish STATE or HEARTBEAT yet.
4. ESP32 accepts that ACK, replies with its own \`ACK|HELLO_ACCEPTED\` at ESP32 sequence 2, and considers negotiation complete. The Uno becomes ready only when that final ESP32 ACK is received. The ESP32 still withholds OBSERVING status and all permits until it sees a valid heartbeat.

If the first ESP32 HELLO is missed, the Uno retries the identical HELLO at sequence 1. If the Uno ACK is missed, the ESP32 retries the identical HELLO at sequence 1. If the ESP32 final ACK is missed, the Uno's duplicate HELLO causes the ESP32 to replay its fixed sequence-2 ACK. Retries reuse the original sequence and payload; they never advance a sequence counter. Exact duplicate startup HELLOs and handshake ACKs are idempotent and do not re-apply domain effects. Duplicate exceptions end after startup; a later repeated HELLO remains a protocol fault.

The ESP32 retries its HELLO every 800 ms and latches a local negotiation fault after an 8-second handshake deadline. Until negotiation completes, neither side may issue a PERMIT, and the ESP32 does not transmit a session REVOKE that the Uno cannot reliably correlate. The Uno keeps announcing the same initial HELLO until negotiation completes or its own guardian fault is latched. A clean paired restart is required after a latched failure.

The Uno's \`SoftwareSerial\` link is timing-sensitive, so application-level turn-taking remains important. The ESP32 sends \`STATUS|HEALTHY\` only after a validated UNO heartbeat; it does not emit timer-driven status frames. A missing/invalid heartbeat or protocol timeout still fails closed. CRC detects accidental corruption, not malicious forgery.

## Guardian policy

The guardian expects known ATM states: UNCOMMISSIONED, IDLE, PIN_PENDING, AUTHENTICATED, WITHDRAW_PENDING, LOCKED, GUARDIAN_LOCKED. It checks the allowed transition table and the reported authentication flag against the state. It rejects a withdrawal request unless state is WITHDRAW_PENDING, the authentication flag is reported true, the last validated heartbeat is fresh, the transaction identifier is syntactically valid and strictly increasing, and the amount is a positive multiple of ₹50. Controller-side and guardian-side policy limits both apply. The defaults are configurable through the respective local USB console and are held in RAM. The Uno full command is SET_POLICY MAX WINDOW WINDOW_MS PIN_TRIES LOCKOUT_MS PIN_TIMEOUT_MS SESSION_TIMEOUT_MS GUARDIAN_TIMEOUT_MS TX_TIMEOUT_MS; the ESP32 full command is SET_POLICY MAX WINDOW HEARTBEAT_MS LINK_TIMEOUT_MS WINDOW_MS PIN_FAILS PIN_WINDOW_MS COMMIT_MS. Short SET_POLICY/SET_LIMITS forms change only the amount limits. The Uno TX_TIMEOUT_MS and guardian COMMIT_MS must be configured consistently.

On permit, the ESP32 records the transaction identifier/amount and expects a matching subsequent UNO commit event within a deadline. A mismatched or missing commit triggers REVOKE. The guardian independently counts reported PIN failures over a short window and can revoke at its configured threshold. Test fixtures are labelled SIMULATED; they do not constitute real compromise detection.

## Uno ATM workflow

Runtime operator setup creates up to four fictional demo accounts using ADD_ACCOUNT CARD_ID PIN START_BALANCE, and sets virtual cash counts using SET_CASH. The active customer may change a demo PIN via CHANGE_PIN CURRENT_PIN NEW_PIN CONFIRM_NEW_PIN while authenticated. No preset PIN exists. Customer flow: CARD, PIN, then BALANCE or WITHDRAW. Three failed PIN attempts cause a temporary demo lockout; PIN entry and authenticated sessions time out; invalid amounts, insufficient balance, policy limits, unavailable denominations, missing guardian and stale/revoked state block withdrawals. All customer state is RAM-only and wiped on reset.

## Known limitations

This protocol does not use HMAC, digital signatures, a protected shared secret, secure element, hardware identity, secure boot configured, or an independently trusted PIN-entry device. The Uno's PIN/result/state are reported by its own firmware. A compromised Uno can fabricate normal-looking state and events; a compromised ESP32 can issue incorrect decisions. CRC detects accidental corruption, not deliberate forgery. The firmware is not a physical dispenser interlock. No real account/PIN, real network, or physical cash may be connected. Production-grade ATM security requires a distinct hardware/key-management architecture and independent review.
