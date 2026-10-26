# SENTINEL UNO + ESP32 Firmware v2

## Scope

This v2 firmware changes SENTINEL from a heartbeat/demo-request foundation into a **configurable educational ATM-controller experiment** using only the existing Arduino Uno and ESP32 DevKit. It is still not production ATM firmware.

The Uno hosts the ATM workflow for fictional RAM-only accounts. The ESP32 independently validates the peer protocol and applies guardian-side policy before issuing a one-shot permit for a single withdrawal request. The desktop app remains responsible for its own virtual-cash gate and user interface.

## Uno ATM state machine

- UNCOMMISSIONED: no demo account has been provisioned.
- IDLE: commissioned, no active customer session.
- PIN_PENDING: a configured demo card is selected; PIN entry must complete within 30 seconds.
- AUTHENTICATED: PIN accepted; balance inquiry and withdrawals are available.
- WITHDRAW_PENDING: withdrawal was locally validated and awaits a matching one-shot ESP32 decision.
- LOCKED: the temporary PIN lockout is active.
- GUARDIAN_LOCKED: guardian revocation, protocol invalidity or link timeout is latched; a clean paired restart is required.

A session expires after 60 seconds of customer inactivity. Three failed PIN attempts temporarily lock the demo account for 60 seconds. PIN failures are also sent as board-reported evidence so the ESP32 can apply a broader attempt-rate threshold. The Uno accepts no transaction while the guardian link is stale or revoked.

## Runtime configuration instead of embedded credentials

No demo card, PIN, starting balance or note stock is hardcoded as a customer record. Use the USB serial command interface to provision up to four fictional demo accounts and a virtual cash-note inventory. Accounts, PINs, balances, policies, lockout state, note counts and audit history live in RAM and are cleared on reset. The desktop application is expected to provision its demo state after a fresh launch.

This choice intentionally avoids storing low-entropy demo PINs in source code or ordinary EEPROM and then making an unsupported claim that they are secure. It is not a substitute for a secure PIN-entry device, cryptographic PIN verification, protected key storage, durable account storage, or the payment-industry PIN security architecture used by real ATMs.

## Uno USB command contract

USB serial: 115200 baud, one command per newline.

- ADD_ACCOUNT CARD_ID PIN START_BALANCE
- SET_CASH COUNT_500 COUNT_200 COUNT_100 COUNT_50
- SET_POLICY MAX_PER_TXN WINDOW_LIMIT
- CARD CARD_ID, PIN PIN, BALANCE, WITHDRAW AMOUNT, CANCEL, LOGOUT, STATUS, JOURNAL, HELP
- FIXTURE_MISMATCH injects a labelled synthetic event and is a test-only control.

Amounts are integer INR demo amounts. Withdrawals must be positive multiples of ₹50 and must pass authentication, account balance, the controller-side policy, the configured note inventory and guardian-side authorization. Note inventory is virtual only. There is no physical output pin for money.

## V2 peer protocol

Both sketches use newline-delimited frames:

    S2|TYPE|SESSION|SEQ|PAYLOAD|CRC16\n

Frames are bounded, parsed using fixed buffers, version checked, CRC checked, session checked and sequence checked. CRC-16/CCITT-FALSE is accidental-corruption detection, **not message authentication**.

UNO → ESP32: HELLO, STATE, HEARTBEAT, EVENT, REQUEST  
ESP32 → UNO: HELLO, ACK, STATUS, PERMIT, DENY, REVOKE

For a withdrawal, the Uno transitions to WITHDRAW_PENDING, emits a unique increasing transaction ID and amount, and sends a framed REQUEST. The guardian requires fresh heartbeat evidence, the expected state, an authenticated-state report, a valid unseen transaction ID, denomination rules, and its own per-transaction/window limits. A valid request receives PERMIT id=<transaction-id>; policy rejection receives a correlated DENY. The Uno commits its RAM-only balance and note inventory only if a fresh PERMIT matches the exact pending ID. The guardian then expects a matching commit report within a timeout, otherwise it latches REVOKE. Any malformed/unknown frames, sequence gaps, illegal state changes, heartbeat timeout, replay, failed commit reconciliation, or labelled test fixture revokes guardian authority.

This is stronger than generic permit freshness, but the guardian sees the Uno's state and authentication result as **reported by the Uno**. Those reports do not independently prove that a PIN was entered or that firmware is genuine. The desktop app must independently enforce the virtual dispenser gate and ensure account/cash state cannot mutate on DENY, REVOKE, timeout, stale permission or invalid evidence.

## Validation sequence

1. Compile the Uno and ESP32 sketches in CI.
2. Flash the ESP32 and Uno; wire the peer UART exactly as described in firmware/README.md.
3. Confirm V2 HELLO/ACK and recurring heartbeat/status.
4. Provision only fictional demo account data, configure virtual note stock, then test successful PIN, wrong PIN, three-attempt lockout, timeout, balance query and valid withdrawal.
5. Test insufficient balance, invalid denomination, out-of-stock note combinations, per-transaction limit, window limit, unknown card, malformed frames, duplicate/stale sequence, link loss, guardian fixture revocation and no-recovery-without-paired-reset.
6. Keep serial logs. Confirm a successful withdrawal produces a correlated one-shot PERMIT and commit report; any denial/revoke/timeout leaves the desktop's virtual account and cassette inventory unchanged.
7. Run the desktop app's integration tests and verify its domain-owned dispenser gate. Do not call the system end-to-end complete until this is implemented and tested on the live app.
8. Bench-test both boards physically. CI compile success does not prove electrical wiring, runtime interoperability, deadline behavior or all attack cases.

## Threat-model boundary

The Uno has 2 KB SRAM and 32 KB flash. The prototype has no extra sensors, secure element, protected PIN pad, cryptographic device identity, protected key storage, secure boot configured, or physical dispenser interlock. CRC/session IDs/sequence counters do not stop an attacker who can forge frames. Runtime PIN verification and rate limits support a controlled teaching demo; they are not production PIN security. A compromised controller can lie about state; a compromised guardian can issue incorrect decisions. “Foolproof”, “unhackable”, “bank-grade”, “secure boot enabled”, and “arbitrary malware detected” are not supported claims.
