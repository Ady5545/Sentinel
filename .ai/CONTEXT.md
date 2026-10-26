# SENTINEL AI Operational Context

## Mission
SENTINEL is an educational and security research platform demonstrating hardware-assisted supervisory validation for ATM controllers. The goal is to prove that an untrusted or compromised ATM controller (Arduino UNO) can be strictly constrained by an independent hardware guardian (ESP32) communicating over a hardened serial protocol.

## High-Level Architecture
- **Desktop Application:** Electron 45 + React 18 + Vite + TypeScript.
- **Microcontrollers:**
  - `firmware/uno_controller/uno_controller.ino`: Target ATM controller.
  - `firmware/esp32_guardian/esp32_guardian.ino`: Hardware security supervisor.
- **Protocol:** V3 UART turn-taking with monotonic frame sequencing, canonical ASCII payloads, and deterministic idempotency.

## Working Directory Layout
- `src/`: React frontend renderer and core simulator state machines (`atm-engine.ts`, `hil-evidence.ts`).
- `electron/`: Main process and serial manager interfacing with physical COM ports.
- `firmware/`: Embedded C/C++ firmware sketches for Arduino UNO and ESP32 DevKit.
- `docs/`: Technical specifications, threat models, and firmware hardening plans.
- `.agent/`: Antigravity/Agent workflows, skills, and invariant rules.

## Primary Invariants
1. **Never cut validation or fault checks:** Firmware must validate frame sequences, buffer bounds, and payload formatting.
2. **Turn-taking discipline:** Neither the UNO nor the ESP32 should flood the serial bus during active transaction handshakes.
3. **Offline-first security:** No external cloud dependencies or remote telemetry; all logs and evidence stay local.
