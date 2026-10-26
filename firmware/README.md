# SENTINEL board firmware

This contains the v3 educational ATM-controller and independent-guardian firmware for the existing Arduino Uno + ESP32 DevKit. No sensors, extra boards, real payment network, PIN pad, card reader or physical dispenser are required or implemented. GitHub Actions compiles both board targets; compilation is not a substitute for real bench testing.

- [Arduino Uno ATM controller](uno_controller/uno_controller.ino)
- [ESP32 independent guardian](esp32_guardian/esp32_guardian.ino)
- [V2 baseline implementation notes](../docs/FIRMWARE_V1_IMPLEMENTATION.md)
- [v3 protocol specification](../docs/SENTINEL_PROTOCOL.md)
- [V3 firmware reliability and hardening implementation plan](../docs/FIRMWARE_V3_IMPLEMENTATION_PLAN.md)

## Roles

- **Uno:** ATM business-state machine for fictional demo accounts: card/session selection, PIN verification, rate limiting, temporary lockout, session timeouts, balance check, withdrawal policy, virtual cash-note inventory, transaction request and commit after a matching one-shot guardian response.
- **ESP32:** independent protocol/state monitor: frame validation, session and sequence checks, transition validation, heartbeat freshness, PIN-failure-rate observation, transaction-ID replay checks, per-transaction limits, a rolling uptime-window budget, one-shot PERMIT/DENY, and latched fail-closed REVOKE.
- **Desktop app:** later presents the full ATM interface and must independently enforce its own virtual-dispenser gate. The board firmware never drives a physical dispenser and a console log alone is not proof of end-to-end enforcement.

## Upload and wire

Use Arduino IDE on the MacBook Air. Install the Espressif ESP32 board package and the **AltSoftSerial** library (Library Manager, by Paul Stoffregen) before compiling the Uno sketch.

1. Upload the ESP32 guardian sketch to **ESP32 Dev Module**. Its USB Serial Monitor is **115200 baud**.
2. Close that monitor, upload the Uno controller sketch to **Arduino Uno**, and inspect its USB monitor at **115200 baud**.
3. Power both boards independently over USB. Join GND. AltSoftSerial uses fixed **Uno D8 RX / D9 TX** pins, so wire **Uno D9 TX → suitable 5 V-to-3.3 V level shifter → ESP32 GPIO16 RX2** and **ESP32 GPIO17 TX2 → Uno D8 RX**. Leave Uno D0/D1 for USB upload/diagnostics. AltSoftSerial uses Timer1; PWM on Uno D10 is unavailable (this firmware does not use it).
4. Never connect Uno 5 V TX directly to an ESP32 GPIO. Prefer a proper level shifter. A divider with 2.2 kΩ series and 2.2 kΩ to ground outputs roughly 2.5 V and may be marginal; use a calculated divider or level shifter. Do not join the 5 V and 3.3 V supply rails.
5. Both boards must be flashed with the matched V3.3 firmware pair. The Uno should print V3 handshake completion; the ESP32 should progress from NEGOTIATING to OBSERVING after a valid heartbeat. If the 8-second startup deadline expires, power-cycle/restart both boards together after confirming both have V3 firmware. A compile alone does not prove the physical link is stable. Close Arduino Serial Monitor before letting the Electron app open the same USB port.

## Uno operator/desktop command protocol

Commands are one newline-terminated line on the Uno USB serial port at 115200 baud. The desktop can send these same commands. The firmware returns structured ATM_EVENT and ATM_STATUS lines.

- ADD_ACCOUNT CARD_ID PIN START_BALANCE — create one fictional demo account. Up to four accounts are held in RAM. There is no built-in default card or PIN.
- SET_CASH COUNT_500 COUNT_200 COUNT_100 COUNT_50 — configure fictional note inventory; counts default to zero.
- SET_POLICY MAX_PER_TXN WINDOW_LIMIT — set controller withdrawal limits. Optional full policy: SET_POLICY MAX_PER_TXN WINDOW_LIMIT WINDOW_MS PIN_TRIES LOCKOUT_MS PIN_TIMEOUT_MS SESSION_TIMEOUT_MS GUARDIAN_TIMEOUT_MS TX_TIMEOUT_MS.
- CARD CARD_ID then PIN PIN — begin a customer session and verify the provisioned demo PIN.
- CHANGE_PIN CURRENT_PIN NEW_PIN CONFIRM_NEW_PIN — change the active demo account PIN after authentication; all PIN fields are cleared from command buffers after processing.
- BALANCE, WITHDRAW AMOUNT, CANCEL, LOGOUT, STATUS, JOURNAL, HELP.
- FIXTURE_MISMATCH — deliberately send a clearly labelled synthetic integrity-violation fixture; it is not detection of actual malware.

Example commissioning values for a classroom demo only (do not reuse real account data): ADD_ACCOUNT CARD01 4826 50000, followed by SET_CASH 20 20 20 20. A withdrawal of ₹500 then requires CARD CARD01, PIN 4826, and WITHDRAW 500. The guardian must be linked and must issue a one-shot PERMIT for that transaction. The example PIN is illustrative, not embedded in the firmware.

The desktop UI should mask PIN entry before sending it to the Uno; the USB serial terminal itself does not provide a secure keypad. Policy defaults are intentionally conservative and configurable. The extended Uno policy ranges are: budget window 60,000–86,400,000 ms; PIN failures 1–10; lockout 5,000–900,000 ms; PIN entry timeout 5,000–120,000 ms; customer session timeout 10,000–600,000 ms; guardian timeout 1,800–30,000 ms; transaction decision timeout 500–10,000 ms. Guardian policy ranges: heartbeat timeout 500–10,000 ms; peer timeout must exceed heartbeat timeout and be at most 30,000 ms; budget window 60,000–86,400,000 ms; failure threshold 3–30; failure window 10,000–600,000 ms; commit timeout 500–10,000 ms. Configure matching Uno transaction and ESP32 commit timeouts if you change the defaults.

Runtime accounts, PINs, balances, policy, transaction history and cash inventory are **volatile RAM state** and are wiped by board reset. This is deliberate for the prototype: it avoids claiming that a low-entropy ATM PIN is protected by plaintext storage or ordinary Uno EEPROM. The app can provision its fictional demo state on startup.

## ESP32 local commands

- STATUS — show guardian state, last reported ATM state, heartbeat age, commit observations and denials.
- SET_LIMITS MAX_TXN WINDOW_LIMIT — configure guardian-side withdrawal limits in RAM.
- SET_POLICY MAX_TXN WINDOW_LIMIT HEARTBEAT_MS LINK_TIMEOUT_MS WINDOW_MS PIN_FAILS PIN_WINDOW_MS COMMIT_MS — configure the full guardian policy in RAM.
- FIXTURE_REVOKE — deliberately latch a synthetic guardian revocation.
- HELP.

A guardian REVOKE is latched. Reset both boards together to establish a new demo session; normal traffic cannot clear a revocation.

## Claims and limitations

This is an educational prototype, **not production ATM firmware**. The Uno stores the demo PIN in RAM because no secure keypad, secure element or protected credential store is present. It is not a bank-grade PIN verification scheme. The two boards have no cryptographic device identity or protected shared key. CRC detects accidental corruption, not deliberate message forgery; session IDs and sequences are not authentication; reported state is not attestation. A compromised Uno could lie about its own behavior, and a compromised ESP32 could make bad decisions. The prototype demonstrates specified protocol/state violations and fail-closed transaction policy—not detection of arbitrary malware and not physical cash protection. Secure boot, flash encryption, key provisioning, hardware-backed identity, persistent lockout protection, a secure PIN-entry device, independent real-dispenser interlocks, and professional security review are outside this firmware release.
