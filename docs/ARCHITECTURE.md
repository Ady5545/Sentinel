# SENTINEL System Architecture

## 1. System Overview

SENTINEL is an offline-first native security research environment and educational ATM simulator. It allows security researchers and students to study embedded hardware attacks, supervisory protocol verification, and hardware-in-the-loop (HIL) defenses against ATM jackpotting and controller manipulation.

```
+-----------------------------------------------------------------------+
|                             USER INTERFACE                            |
|             React 18 + TypeScript + Vite + Lucide Icons               |
|     (ATM Simulator, HIL Terminal, Evidence Viewer, Config Panel)     |
+-----------------------------------+-----------------------------------+
                                    | IPC (contextBridge via preload.cjs)
                                    v
+-----------------------------------------------------------------------+
|                          ELECTRON MAIN PROCESS                         |
|   - Node.js Runtime (main.cjs)                                        |
|   - SerialPort Manager (electron/serial-manager.cjs)                  |
|   - Telemetry Stream Parsing & Buffer Normalization                   |
+-----------------------------------+-----------------------------------+
                                    | USB CDC / Serial (115200 baud)
                                    v
+-----------------------------------------------------------------------+
|                    ARDUINO UNO REV3 ATM CONTROLLER                    |
|   - ATM State Machine (IDLE, CARD_INSERTED, AUTHENTICATED, etc.)      |
|   - PIN verification & Virtual Ledger                                 |
|   - V3 Protocol Turn-Taking & Retry Queue                             |
+-----------------------------------+-----------------------------------+
                                    | Half-Duplex UART (Software/Hardware)
                                    v
+-----------------------------------------------------------------------+
|                     ESP32 HARDWARE SECURITY GUARDIAN                  |
|   - Supervisory Policy Engine (Per-transaction limits, velocity)      |
|   - Sequence & Idempotency Validator                                  |
|   - Out-of-Band Physical Alerting & Relay Revocation                  |
+-----------------------------------------------------------------------+
```

---

## 2. Core Subsystems

### 2.1 Electron Application (Host Environment)
- **`electron/main.cjs`**: Application lifecycle, window management, and native IPC channels.
- **`electron/preload.cjs`**: Secure IPC bridge exposing sanitized serial port discovery, connection management, and frame dispatch.
- **`electron/serial-manager.cjs`**: Node.js `serialport` driver managing USB COM ports, delimiter buffering (`\n`), and reconnection resilience.

### 2.2 React Frontend (Renderer Process)
- **`src/App.tsx`**: Main UI dashboard layout hosting tabbed views:
  - **Simulator View:** Interactive ATM keypad, card slot, and cash tray.
  - **HIL Terminal:** Real-time raw and structured UART telemetry stream.
  - **Evidence Capture:** Exportable chronological event log with cryptographic hashes.
  - **Bench Controls:** Fault injection triggers (frame corruption, replay attack, drop ACK).
- **`src/core/atm-engine.ts`**: Pure TypeScript state machine modeling ATM transitions client-side when running in pure software emulation mode.
- **`src/core/hil-evidence.ts`**: Structured evidence collector recording frame sequences, timestamps, and anomalies.

### 2.3 Physical Microcontroller Layer
- **Arduino UNO Controller (`firmware/uno_controller/uno_controller.ino`)**:
  - Handles customer interface emulation, PIN entry timeouts, and transaction request formation (`REQUEST`).
  - Strict turn-taking: Suspends command processing while awaiting guardian transaction authorization or commit acknowledgement.
- **ESP32 Guardian (`firmware/esp32_guardian/esp32_guardian.ino`)**:
  - Supervisory coprocessor with non-volatile logging and cryptographic check routines.
  - Maintains strict state tracking of one-shot permits. Revokes authorization immediately if payload fields deviate from canonical order.

---

## 3. Communication Protocol (V3 Invariants)

All frames between Controller, Guardian, and Host follow bounded canonical ASCII framing:
```
[TYPE]:key1=val1;key2=val2;seq=1234\n
```

1. **Strict Monotonic Sequences:** Frames must increment sequence counters; unexpected sequence gaps trigger link re-synchronization or revocation.
2. **Idempotent Commit ACKs:** Repeated `TX_COMMITTED` reports within the duplicate window receive the identical ACK without double-debiting balances or incrementing transaction metrics.
3. **Turn-Taking Lockouts:** During inflight `REQUEST` or unacknowledged `TX_COMMITTED` states, non-status operator inputs are deferred to prevent race conditions.

---

## 4. Security & Trust Model

Refer to [docs/THREAT_MODEL.md](THREAT_MODEL.md) for full attack taxonomy and mitigations:
- **Untrusted Controller:** The Arduino UNO is assumed vulnerable to physical memory tampering or firmware overwrite.
- **Supervisory Guardian:** The ESP32 acts as an independent out-of-band arbiter. It cannot prevent a compromised controller from lying about display text, but it completely prevents unauthorized physical or virtual cash disbursement beyond enforced policy limits.
