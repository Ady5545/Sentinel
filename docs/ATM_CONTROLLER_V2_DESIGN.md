# SENTINEL ATM Controller v2 — Design and Acceptance Checklist

## Intended demo

Use one Arduino Uno for fictional ATM customer flows and one ESP32 as an independent protocol/policy observer. The desktop app later presents the full ATM UI and independently decides whether virtual cash/account state may change. No sensors or additional boards are required for this firmware milestone.

## What is configurable

- Up to four fictional card IDs, 4–6 digit PINs and starting balances are provisioned over the Uno USB command interface.
- Virtual note counts for ₹500, ₹200, ₹100 and ₹50 are configured at runtime.
- Controller-side maximum withdrawal and uptime-window limit are configurable.
- Guardian-side maximum transaction and uptime-window limit are independently configurable.
- There is no built-in customer card/PIN or starting balance; the default virtual cash inventory is zero.

For now this data resides in RAM and disappears on reset. This is deliberate to avoid storing a short demo PIN in source or plaintext EEPROM. Provision the demo state after each reset. This is not a persistence strategy for a real ATM.

## PIN and session protections in the demo

- PIN format validation (4–6 digits).
- PIN comparison without printing the PIN or storing it in source constants.
- Maximum of three failed attempts per configured demo card followed by a timed lockout.
- Guardian-wide rate observation of reported PIN failures.
- PIN-entry timeout, authenticated-session inactivity timeout, explicit cancel/logout and guardian-loss lock.
- Unknown card, malformed PIN and invalid state are logged as separate structured observations.
- PIN entry over USB is not a secure hardware PIN pad. The desktop UI should mask the input; the command goes over local USB serial and is visible to firmware/host memory. These protections are for education, not production PIN handling.

## Withdrawal protections

1. Customer must be authenticated and the session must be fresh.
2. Amount must be a positive integer multiple of ₹50.
3. Amount must not exceed balance, controller-side per-transaction policy or controller-side uptime-window policy.
4. Virtual cassette inventory must have a combination of configured denominations to satisfy the exact amount.
5. Uno enters WITHDRAW_PENDING and sends a unique monotonic transaction ID and amount.
6. ESP32 checks protocol/session/sequence, expected reported ATM state, fresh heartbeat, reported authenticated state, transaction replay, amount form, its own per-transaction limit and its own uptime-window budget.
7. The ESP32 returns PERMIT id=<same transaction ID> or a correlated DENY. Unexpected protocol/evidence triggers a latched REVOKE.
8. The Uno commits balance and virtual note inventory only after the matching permit arrives before timeout; no physical pins are toggled.
9. The guardian expects a matching commit event within a deadline; mismatch or silence revokes.
10. The desktop domain-owned dispenser gate separately verifies the current hardware observation and protected mode before mutating its own virtual account/cassette state.

## Required verification before calling v2 ready

- Both CI compile jobs pass with warnings reviewed.
- Two-board physical handshake and heartbeat work at the documented pins/baud.
- Each of the valid/invalid PIN, three-attempt lockout, session timeout, unknown card, balance query, normal withdrawal, invalid denomination, insufficient balance, no-cash-combination, controller limit, guardian limit, stale heartbeat, replay ID, malformed/CRC-bad frame, sequence gap, link disconnect, fixture revoke and no-auto-recovery tests behave as expected.
- Failed/denied/revoked/time-out transactions leave both UNO state and desktop account/cassette inventory unchanged.
- Serial logs prove the permit ID and commit ID match.
- Electron app opens the correct serial port, provisions accounts in a controlled demo mode, masks PIN entry, parses output safely, and does not treat USB logs as cryptographic attestation.
- Board restart resets RAM-only fictional accounts/policy and requires reprovisioning.

## Explicit non-goals

No real banking, real customer data, actual card standards, secure PIN-entry device, secure element, persistent real account ledger, hardware-backed identity, cryptographic peer authentication, ESP32 secure boot/encrypted flash provisioning, physical dispenser or physical tamper sensors. No claim of foolproof/unhackable protection or arbitrary malware detection is permitted.
