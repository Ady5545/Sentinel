# SENTINEL - ATM Security Research & Emulation Environment

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Electron%20%7C%20React%20%7C%20Arduino%20%7C%20ESP32-green.svg)](docs/ARCHITECTURE.md)
[![Status](https://img.shields.io/badge/Status-V3.4%20Hardening-orange.svg)](docs/FIRMWARE_V3_IMPLEMENTATION_PLAN.md)

SENTINEL is an offline-first native security research environment and Hardware-in-the-Loop (HIL) testbed designed for evaluating ATM controller integrity, hardware-assisted supervisory validation, and serial link protocol attacks.

---

## Architecture Overview

SENTINEL combines a cross-platform desktop application (Electron + React + TypeScript + Vite) with paired physical firmware (Arduino UNO ATM controller and ESP32 hardware security guardian):

```
+-----------------------------------------------------------+
|               SENTINEL Desktop Environment                |
|      (Electron Main / Serial Manager + React UI)         |
+-----------------------------+-----------------------------+
                              | Host Serial / USB
                              v
+-----------------------------+-----------------------------+
|               Arduino UNO Rev3 ATM Controller             |
|   - Virtual customer session state machine & PIN auth    |
|   - Dispense request generation and transaction ledger    |
|   - Half-duplex turn-taking and retry management         |
+-----------------------------+-----------------------------+
                              | Inter-Board UART (V3)
                              v
+-----------------------------+-----------------------------+
|              ESP32 NodeMCU Hardware Guardian              |
|   - Independent out-of-band transaction supervisor        |
|   - Amount bounds checking & velocity enforcement         |
|   - Cryptographic frame validation & tamper revocation   |
+-----------------------------------------------------------+
```

---

## Key Features

- **Hardware-in-the-Loop (HIL) Interface:** Direct serial communication with dual-microcontroller testbenches with live terminal telemetry and evidence capture.
- **V3 Strict Frame Protocol:** Frame validation, sequence checking, half-duplex turn-taking, and idempotent `TX_COMMITTED` acknowledgement handling.
- **Interactive Security Research Dashboard:** Live terminal feed, transaction simulator, audit logs, and anomaly detection.
- **Offline & Standalone Operation:** Designed for air-gapped lab testing, educational demos, and defense simulations.

---

## Project Structure

```
├── .agent/              # Agent skills, rules, and execution workflows
├── .agents/             # Auxiliary agent capabilities (brag, gravitas)
├── .ai/                 # AI context, architecture memory, and decisions
├── docs/                # Protocol specifications, threat models, and plans
├── electron/            # Electron main process, preload, and serial manager
├── firmware/            # Embedded firmware for Arduino UNO & ESP32 DevKit
│   ├── esp32_guardian/  # ESP32 hardware supervisory guardian
│   └── uno_controller/  # Arduino UNO ATM state machine controller
├── src/                 # React UI (renderer process) and state engines
└── scripts/             # Tooling, icon generation, and build utilities
```

---

## Getting Started

### Prerequisites

- **Node.js:** `>= 20.x` (LTS recommended)
- **Package Manager:** `npm` (v10+)
- **Arduino IDE / CLI:** For flashing embedded firmware in `firmware/`

### Installation

```bash
# Clone the repository
git clone https://github.com/Ady5545/Sentinel.git
cd Sentinel

# Install dependencies
npm install
```

### Development

```bash
# Start renderer and Electron in development mode
npm run dev
```

### Verification & Testing

```bash
# Verify Electron main scripts
npm run check:main

# Run Vitest test suites
npm test

# Full production build
npm run build
```

---

## Documentation

- [System Architecture](docs/ARCHITECTURE.md)
- [Protocol Specification (V3)](docs/SENTINEL_PROTOCOL.md)
- [Threat Model & Security Invariants](docs/THREAT_MODEL.md)
- [Hardware Guardian Design](docs/ATM_CONTROLLER_V2_DESIGN.md)
- [Firmware Implementation & Plans](docs/FIRMWARE_V3_IMPLEMENTATION_PLAN.md)
- [AI System Context](.ai/CONTEXT.md)

---

## License

Private Research Prototype. See [package.json](package.json).
