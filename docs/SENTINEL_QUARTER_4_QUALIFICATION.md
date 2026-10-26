# SENTINEL Quarter 4 — Release and Hardware Qualification

**Status: IN PROGRESS.** This document defines repeatable checks; it is not evidence that a check has passed. The machine-readable tracker is `docs/quarter-4-qualification-matrix.json`.

## Evidence rules

Every result must name the exact 40-character source commit, test date/time, host OS, app/package version, operator, result (`PASS`, `FAIL`, or `NOT RUN`), and evidence paths. Attach redacted logs or exported run records where applicable. Do not put PINs, credentials, account secrets, or unredacted command lines in the evidence bundle.

Use distinct evidence labels:
- **SOFTWARE_SIMULATION** — the local ATM/domain model generated the event.
- **SYNTHETIC_FIXTURE** — a deterministic test scenario, never a real board.
- **BOARD_REPORTED** — text received from a USB serial console; not cryptographic device attestation.
- **PROTOCOL_VALIDATED** — a trace passed the defined protocol assertions for the named test; it does not alone prove physical hardware identity.
- **HOST_DERIVED** — the desktop derived a result from correlated records.

A successful compile or CI workflow does not prove paired-board operation. Missing physical hardware, unrun tests, and unverified OS behavior remain `NOT RUN`; they are not inferred as passing.

## 1. Pinned software and package checks

1. Select one 40-character Git commit SHA as the release candidate and record it before testing.
2. Run Electron entry-point/serial tests, domain tests, qualification-manifest tests, TypeScript and Vite build on that commit.
3. Build the macOS Apple Silicon package and Windows x64 package from that same SHA on the matching runner/target.
4. Generate `release/qualification-manifest.json` plus its SHA-256 sidecar. Run manifest verification against the same SHA. Keep the workflow URLs and build logs with the release evidence.
5. Verify the resulting artifacts exist and are non-empty. Preserve the manifest and artifact digests with the package files; do not claim installation or offline behavior from package creation alone.

## 2. Offline installed-app smoke check

For each operating system, install the produced package on the intended architecture, disconnect networking, then launch the installed app. Confirm the local software-only ATM and scenario replay work without either board connected. Confirm serial controls clearly explain that hardware is optional, and that no real bank, account, or dispenser is contacted. Record actual app version, source SHA, timestamps, and result. If not physically run on that OS, record `NOT RUN`.

## 3. Physical interface safety check — before powering the pair

- Verify Uno GND and ESP32 GND share a common ground.
- Keep the Uno 5 V TX line level-shifted before the ESP32 RX input. For the documented divider, route Uno D1/TX through 2.2 kΩ to the junction, connect the junction to ESP32 GPIO16/RX2, and connect 3.3 kΩ from the junction to common GND.
- **Never connect the Uno's 5 V TX signal directly to an ESP32 GPIO.**
- The ESP32 GPIO17/TX2 is the paired-board transmit pin. Do not connect it to Uno RX unless the approved wiring/firmware plan explicitly requires the reciprocal link.
- Inspect for shorts and confirm pin labels before connecting USB/power. Record wiring photos/measurements only after the physical setup has actually been inspected.

This document records the expected arrangement, not an assertion that the user's current wires have passed inspection.

## 4. Paired start, reconnect, and idle qualification

Record each attempt as a separate row with sequence number, timestamp, source SHA, Uno USB session ID, ESP32 USB session ID, startup result, freshness result, and log path.

- Run 100 clean paired starts/resets. Do not reuse a prior session's logs or count software replays as physical starts.
- Test unplug/replug on each board separately, simultaneous reconnect, boot during a pending request, stale readiness, serial framing error, and host app restart. Verify protected HIL fails closed until new boot/session evidence and fresh paired readiness are re-established.
- Observe the paired setup idle for 30 minutes, recording start/end times and any restart, disconnect, readiness expiry or unexpected output.
- Attach redacted paired serial logs. If a test cannot be performed, leave it `NOT RUN`; if a test fails, preserve the failure and corrective-action record instead of replacing it with a later pass.

## 5. Allowed and denied fictional transaction cases

For each transaction, preserve the transaction ID, amount, board session IDs, expected result, actual result, and evidence paths. Do not store PINs.

1. **Allowed case:** provision a fictional account and cassette; request a permitted amount; observe the guardian permit, Uno commit and ESP32 reconciliation/ACK; verify exact ID/amount/balance matching and one shadow update only.
2. **Denied case:** exercise a documented denial condition; verify terminal denial and zero shadow-cash mutation.
3. **Mismatch case:** use the approved synthetic mismatch fixture or a controlled mismatch test; confirm it is clearly identified as a fixture when simulated, freezes protected follow-up actions, and leaves shadow cash unchanged.
4. **Revocation/reset case:** observe authority loss or a controlled fixture, then verify readiness alone cannot clear the latched desktop fault and both board boot/session epochs are required.
5. Export JSON and CSV; compare provenance labels and redact sensitive data. A UI toast saying a command was written is not proof the board accepted it.

## 6. Demonstration and final report

Use a small, reproducible run on the same pinned build. Show the mode, source SHA, evidence provenance, transaction correlation, virtual-only cash ledger, and export path. Explicitly distinguish fixture-generated events, board-reported serial lines, and protocol assertions. State that this project models a fictional ATM; it does not control real cash, connect to a bank, or cryptographically attest firmware identity.

## Current qualification status

All entries in `docs/quarter-4-qualification-matrix.json` begin as `PENDING` or `NOT RUN`. Update them only with attributable evidence. The 100-start, 30-minute, wiring, paired transaction and installed-app checks require real-world execution; repository CI cannot perform them.
