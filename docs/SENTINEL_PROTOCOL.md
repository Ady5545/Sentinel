# SENTINEL UNO ↔ ESP32 Protocol Specification

**Status:** Version 1 design contract; hardware firmware integration remains a separate gate  
**UART:** 9600 baud, 8 data bits, no parity, 1 stop bit  
**USB diagnostic consoles:** 115200 baud  
**Boards:** one Arduino Uno (primary controller stand-in) and one ESP32 DevKit (guardian stand-in)

## Safety properties

- No frame or serial text alone grants dispenser authority.
- The desktop virtual dispenser remains the final authority for virtual inventory.
- In protected hardware-in-the-loop mode, missing, stale, invalid or revoked guardian permission fails closed.
- Reconnect creates a new session and never silently restores revoked authority.
- The baseline comparison is simulation-only.
- CRC detects accidental corruption; it does not authenticate the sender or prove firmware integrity.

## Frame format

Version 1 uses newline-delimited ASCII frames so the Uno can parse them with a small fixed buffer:

`S1|<type>|<session>|<seq>|<payload>|<crc16>\n`

- `S1`: protocol version.
- `type`: uppercase message type, e.g. `HELLO`, `HEARTBEAT`, `STATE`, `EVENT`, `ACK`, `PERMIT`, `REVOKE`, `RECOVER`.
- `session`: bounded boot/session token (maximum 12 ASCII alphanumeric characters).
- `seq`: unsigned decimal sequence number; each sender increments it for every emitted frame within a session.
- `payload`: bounded printable ASCII key/value fields; `-` means empty.
- `crc16`: four hexadecimal digits of CRC-16/CCITT-FALSE over all bytes before the final separator and CRC field.

Maximum complete frame length is 120 bytes including newline. Receivers use fixed-size buffers, reject overlong frames, discard until the next newline after overflow, and never allocate based on incoming length. A frame without a newline is incomplete and cannot change authority.

## Initial message semantics

| Type | Direction | Purpose | Authority effect |
|---|---|---|---|
| `HELLO` | Both | Version/session handshake | No permit |
| `HEARTBEAT` | UNO → ESP32 | Liveness and reported controller state | Liveness only; not proof of integrity |
| `STATE` | UNO → ESP32 | Report legal controller state and sequence | Evaluated against transition policy |
| `EVENT` | UNO → ESP32 | Report a test event or service-state change | Evaluated with provenance and policy |
| `ACK` | Receiver → sender | Acknowledge a valid frame/request | No permit |
| `PERMIT` | ESP32 → UNO / desktop adapter | Short-lived permit observation for a request/session | Desktop must independently validate freshness and mode |
| `REVOKE` | ESP32 → UNO / desktop adapter | Revoke the current test authority | Denies protected virtual dispense |
| `RECOVER` | Operator-controlled flow | Begin explicit recovery after incident acknowledgement | Does not clear evidence or restore permit by itself |

## Receiver validation order

1. Enforce maximum frame length and ASCII character set.
2. Require exact version, field count and known message type.
3. Validate bounded session and numeric fields without overflow.
4. Verify CRC-16/CCITT-FALSE.
5. Require expected session and strictly fresh sequence; reject duplicate, stale or skipped sequence according to the selected policy.
6. Validate payload schema and legal controller state transition.
7. Update evidence/heartbeat timestamps only after the full frame validates.
8. Emit a normalized observation with provenance; the policy decides permit/revoke.
9. The domain-owned dispenser gate checks the current protected-mode authority immediately before inventory mutation.

Malformed input must not crash firmware or create a permit. Sequence wrap must be handled by starting a new session before ambiguity. Heartbeat age is measured locally by the receiver, not trusted from a sender-provided timestamp.

## Authentication limitation

The current boards have no trusted secure element in this project. CRC, session IDs, sequence counters and reported build IDs do not authenticate a sender against malicious firmware. Do not label this protocol cryptographic attestation. A future challenge-response design would need an explicit key-storage and compromise analysis; a secret stored in ordinary Uno flash is not a trustworthy hardware root.

## Implementation status

This document specifies the target contract. USB console observation is not equivalent to framed protocol validation. The current synthetic software fixture remains distinct from board-reported and protocol-validated evidence. Hardware-in-the-loop mode must stay unavailable until firmware, parser, freshness checks and fail-closed integration pass their tests.
