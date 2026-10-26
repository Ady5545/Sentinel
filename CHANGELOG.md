# Changelog

All notable changes to the **SENTINEL Research Environment** project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.3.0] - 2026-10-26

### Added
- **V3 UART Turn-Taking & Acknowledgement Reliability:**
  - Idempotent `TX_COMMITTED` transaction acknowledgement and sequence tracking across Arduino UNO and ESP32 guardian.
  - Dedicated commit report retry budget and duplicate frame rejection within healthy timing windows.
  - Turn-taking lockouts on operator commands during unacknowledged pending transactions.
- **Agent Skill & Automation Suite:**
  - Integrated 43 project-specific agent skills (`.agent/skills`), including design, audit, debugging, and verification workflows.
  - Added repository invariant rules in `.agent/rules/`.
  - Added `.agents/` and `.claude/` skill integration for cross-agent compatibility.
- **AI Context & Architecture Baseline:**
  - Added `.ai/CONTEXT.md`, `.ai/DECISIONS.md`, and `.ai/RULES.md` for consistent agent orientation.
  - Added comprehensive `docs/ARCHITECTURE.md` mapping hardware, serial, electron, and renderer boundaries.

### Changed
- Synchronized repository documentation, setup guides, and project orientation docs.
- Realigned Arduino Uno & ESP32 firmware state handlers to enforce canonical field serialization for commit events.

---

## [0.2.0] - 2026-10-25

### Added
- **Educational ATM Simulator Core:**
  - Virtual customer session state machine with configurable PIN timeouts, velocity checks, and transaction boundaries.
  - Host-to-controller serial protocol manager in Electron (`electron/serial-manager.cjs`).
  - Native telemetry evidence logger with JSON export and HIL terminal inspection.
- **Hardware-in-the-Loop Integration:**
  - Initial firmware implementations for Arduino UNO (`firmware/uno_controller`) and ESP32 Guardian (`firmware/esp32_guardian`).
  - Real-time heartbeat, link status detection, and supervisory revocation protocol.

---

## [0.1.0] - 2026-10-24

### Added
- Initial project scaffolding with Electron, Vite, React 18, and TypeScript.
- Base protocol specifications and threat modeling documentation.
