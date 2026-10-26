# SENTINEL V3 UART Turn-Taking Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate the V3 heartbeat/status deadlock caused by Arduino Uno SoftwareSerial transmit windows while preserving strict fail-closed sequencing and transaction authority rules.

**Architecture:** Keep the existing S3 framing and V3 handshake unchanged. Change the post-handshake liveness path to explicit application-level turn-taking: the Uno sends one heartbeat and waits for its matching guardian STATUS before sending another heartbeat; the ESP32 continues to answer a validated heartbeat exactly once and never emits timer-driven STATUS frames. Add a small deterministic contract test and update the protocol specification so the scheduling rule is executable and documented.

**Tech Stack:** Arduino Uno/ATmega328P C++, ESP32 Arduino C++, Node.js built-in test runner, GitHub Actions.

**Spec:** `docs/SENTINEL_PROTOCOL.md` plus `docs/FIRMWARE_V3_IMPLEMENTATION_PLAN.md`.

## Global Constraints

- Preserve one Arduino Uno + one ESP32 DevKit.
- Preserve Uno SoftwareSerial D2 RX / D3 TX and ESP32 UART2 GPIO16 RX / GPIO17 TX.
- Preserve 9600 8N1 inter-board UART and existing level shifting/wiring.
- Preserve S3 framing, CRC-16/CCITT-FALSE, session/sequence validation, fail-closed revocation, and transaction-correlated permits.
- Do not weaken sequence checks or accept arbitrary sequence gaps to hide transport loss.
- A heartbeat/status exchange is liveness evidence only; it is never transaction authority.
- No real accounts, banking connection, PIN hardware, or physical dispenser.

## Review Focus

1. Back-to-back Uno STATE + HEARTBEAT frames must not cause a later heartbeat to overlap a guardian response; test that the Uno gates the next heartbeat on STATUS receipt.
2. Lost STATUS must cause a safe timeout rather than an unbounded wait; test that no withdrawal permit becomes possible while guardian freshness is stale.
3. Duplicate STATUS must not advance protocol sequence twice or create a false liveness state; test the existing strict receive path remains intact.
4. ESP32 must not start timer-driven STATUS traffic; test the response remains coupled to HEARTBEAT handling.
5. Startup handshake behavior must remain unchanged; run the existing V3 contract suite and both board builds.

### Task 1: Add the liveness turn-taking contract test

**Files:**
- Modify: `.github/protocol-v3-handshake-contract.mjs`

**Interfaces:**
- Consumes: current Uno/ESP32 sketch source and `docs/SENTINEL_PROTOCOL.md`.
- Produces: executable assertions for one-heartbeat-at-a-time scheduling.

- [ ] **Step 1: Write the failing test**
  - Assert the Uno has an `awaitingGuardianStatus` gate.
  - Assert `sendHeartbeat()` sets that gate.
  - Assert the main loop only calls `sendHeartbeat()` when the gate is clear.
  - Assert ESP32 STATUS remains emitted from `handleHeartbeat()` rather than from a timer-driven status loop.

- [ ] **Step 2: Run the protocol contract test**
  - Run: `node --test .github/protocol-v3-handshake-contract.mjs`
  - Expected: FAIL because the current Uno has no heartbeat response gate.

### Task 2: Implement Uno heartbeat/status turn-taking

**Files:**
- Modify: `firmware/uno_controller/uno_controller.ino`

**Interfaces:**
- Consumes: existing `sendHeartbeat`, `handleGuardianLine`, guardian freshness timer, and `loop`.
- Produces: `bool awaitingGuardianStatus` as a single liveness scheduling guard.

- [ ] **Step 1: Add `awaitingGuardianStatus` state**
  - Initialize false at boot.
  - It represents exactly one outstanding HEARTBEAT awaiting the corresponding STATUS response.

- [ ] **Step 2: Gate HEARTBEAT transmission**
  - In `sendHeartbeat(uint32_t now)`, set `awaitingGuardianStatus = true` only after the heartbeat frame is successfully serialized/transmitted.
  - In the main loop, do not send another heartbeat while `awaitingGuardianStatus` is true.

- [ ] **Step 3: Clear the gate only on valid STATUS**
  - In the `STATUS|HEALTHY` branch, after validation, update guardian freshness and clear `awaitingGuardianStatus`.
  - Do not clear it for malformed, duplicate, wrong-session, or otherwise rejected frames.

- [ ] **Step 4: Bound the wait**
  - Use the existing guardian timeout as the upper bound. If a heartbeat is outstanding and no valid STATUS arrives before the configured guardian timeout, enter `GUARDIAN_LOCKED` through the existing fail-closed path.
  - Do not create a second heartbeat while the first is outstanding.

- [ ] **Step 5: Preserve startup ordering**
  - Keep initial STATE publication before the first HEARTBEAT.
  - Ensure a state transition that occurs while waiting for STATUS does not create an overlapping heartbeat; the existing next-loop scheduling handles it after the response/fault.

- [ ] **Step 6: Run focused source contract test**
  - Run: `node --test .github/protocol-v3-handshake-contract.mjs`
  - Expected: PASS.

### Task 3: Document the half-duplex application scheduler

**Files:**
- Modify: `docs/SENTINEL_PROTOCOL.md`
- Modify: `docs/FIRMWARE_V3_IMPLEMENTATION_PLAN.md`

**Interfaces:**
- Consumes: implemented Uno `awaitingGuardianStatus` scheduling rule.
- Produces: protocol text stating that Uno HEARTBEAT is request/response liveness traffic and the next heartbeat waits for STATUS.

- [ ] **Step 1: Update protocol specification**
  - State that Uno sends at most one outstanding HEARTBEAT.
  - State that ESP32 replies once with STATUS|HEALTHY after validation.
  - State that Uno waits for STATUS before sending the next heartbeat because SoftwareSerial cannot reliably receive during transmission.
  - State that timeout/revocation remains fail-closed and STATUS is not a permit.

- [ ] **Step 2: Update implementation plan incident record**
  - Record the hardware evidence: ESP32 observed valid heartbeat/state traffic while Uno timed out waiting for STATUS.
  - Identify the leading cause as response collision with the Uno's SoftwareSerial transmit window, not a reason to weaken sequence validation.
  - Keep the conclusion explicitly evidence-based: hardware bench validation remains required.

### Task 4: Build and verify

**Files:**
- No additional source files.

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: buildable V3 pair with automated contract checks.

- [ ] **Step 1: Run protocol tests**
  - Run: `node --test .github/protocol-v3-handshake-contract.mjs`
  - Expected: all tests PASS.

- [ ] **Step 2: Run GitHub Actions firmware build**
  - Confirm the firmware workflow compiles `arduino:avr:uno` and `esp32:esp32:esp32` with warnings enabled.
  - Expected: both firmware targets PASS and protocol contract tests PASS.

- [ ] **Step 3: Inspect the resulting diff**
  - Verify only the intended firmware scheduling, protocol documentation, and test contract changed.
  - Verify no wiring, baud rate, pins, transaction authorization, or fail-closed rules were weakened.

- [ ] **Step 4: Commit**
  - Commit message: `fix: serialize V3 heartbeat status exchange`

- [ ] **Step 5: Hardware acceptance after flashing**
  - Flash both matched V3 sketches from this branch.
  - Reset/power both together with the existing wiring.
  - Expected sequence: handshake complete → initial STATE → heartbeat observed → STATUS received by Uno → repeated heartbeat/STATUS cycles without guardian timeout.
  - Only after stable liveness should fictional account/cash provisioning and withdrawal tests resume.
