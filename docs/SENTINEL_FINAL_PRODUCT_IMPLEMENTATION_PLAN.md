# SENTINEL Final Product Implementation Plan

**Document type:** Current-state assessment, integration roadmap, test strategy, and release acceptance contract  
**Date:** 26 October 2026  
**Repository:** [Ady5545/Sentinel](https://github.com/Ady5545/Sentinel)  
**Baseline:** `main` at `e59b00cd5ccbea6f495cb4bf91559a10e904dce1`  
**Scope of this change:** Plan/documentation only. No application or firmware implementation changes are included in this plan commit.  
**Existing references:** `docs/ATM_SIMULATOR_IMPLEMENTATION_PLAN.md`, `docs/FIRMWARE_V3_IMPLEMENTATION_PLAN.md`, `docs/SENTINEL_PROTOCOL.md`, `docs/THREAT_MODEL.md`, and `docs/EXPERIMENT_METHOD.md`.

---

## 1. Executive assessment

SENTINEL has a substantial starting foundation, but the intended final product is **not complete**. The current main branch contains an Electron/React desktop application, a software ATM model, two firmware sketches, an initial peer protocol, a passive USB serial viewer, an experiment screen, an event journal, evidence export, and CI builds. Those pieces are not yet joined into one working end-to-end system.

There are two release-blocking issues:

1. **Physical UART liveness is not stable.** The latest paired-board trace shows that the V3 handshake completes and the ESP32 receives a valid Uno heartbeat, then the ESP32 reports a local STATUS write, but the Uno never logs `[STATUS_RX] Accepted HEALTHY`. The Uno eventually locks on guardian-status timeout. The ESP32 then logs a revoke after it sees the Uno report its own guardian-lock state. That final revoke is downstream fail-closed behavior, not proof that an attack was detected. The most recent log does not show a valid accepted HEALTHY status, so this issue remains open.
2. **The desktop app does not control the boards yet.** Electron can enumerate ports, open the Uno and ESP32 USB consoles at 115200 baud, and display incoming serial lines. The current preload/IPC/SerialManager API has no serial-write operation and the renderer does not feed board events into the ATM transaction state. The software ATM and the physical boards are therefore separate demonstrations today.

A third high-priority correctness gap exists in the software authority boundary: in `src/core/atm-engine.ts`, the regular protected-mode withdrawal path can mutate the virtual balance and cassette when the state is merely `MONITORING`; it assigns `PERMIT` as part of the successful withdrawal rather than requiring a prior explicit decision. The compromise-fixture test covers a revoked scenario, but the normal withdrawal test does not prove that an explicit current permit is required.

**Release conclusion:** CI passing demonstrates that code builds and source-contract tests pass. It does not demonstrate a functioning physical UART link, a connected desktop-to-board workflow, or a secure virtual-dispenser gate. Those require separate acceptance evidence.

## 2. The exact finished product to build

SENTINEL should behave as one native, offline-capable ATM research environment with clearly separated **software simulation** and **hardware-in-the-loop (HIL)** modes.

### 2.1 User-facing experience

The operator can:

- Open the installed macOS application (Apple Silicon) or Windows x64 build and use it offline.
- View a fictional ATM terminal, its modeled modules, the current Sentinel authority state, the experiment lab, an incident journal, and a hardware bridge.
- Select a repeatable, clearly labelled synthetic scenario such as an illegal state transition, stale/replayed frame, controller-profile mismatch, guardian timeout, or privileged-path fixture.
- Compare the *same* software-only scenario in an explicitly unprotected baseline and protected simulation, with identical starting account and cassette values.
- In protected HIL mode, connect the Uno and ESP32, verify they have established a current session, provision fictional demo data, send allowed operator/customer commands to the Uno, and observe what the ESP32 reports through its policy/permit/revoke lifecycle.
- See whether a virtual dispense is **requested, pending, denied, revoked, or confirmed**; the app only updates its visible virtual cash after the current transaction passes the defined gate.
- Review why a decision happened, its transaction/session identifiers, the evidence source, timestamps/latency where measured, and final account/cassette state.
- Export a run record in JSON/CSV and replay the same software fixture.

### 2.2 The three authorities

| Component | Responsibility | Must not claim |
|---|---|---|
| Desktop domain core | Owns software-simulation state, experiment setup, run records, and the final **software virtual-dispenser gate** | It cannot independently attest to genuine board firmware merely from USB text |
| Arduino Uno | Primary ATM-controller stand-in: fictional account/session state, PIN demo flow, local policy, pending withdrawal, and controller-side commit after matching guardian decision | It is not the ultimate trusted authority and does not control any physical cash mechanism |
| ESP32 SENTINEL | Separate guardian stand-in: protocol/session/freshness checks, state-transition policy, transaction-ID checks, one-shot PERMIT/DENY, and latched REVOKE | It cannot prove arbitrary malware exists or authenticate the Uno cryptographically in this design |

The Desktop and Uno may have separate *shadow* copies of the fictional balances for HIL display/reconciliation, but the ownership and update rules must be explicit. A board commit must never silently cause a second or duplicate desktop commit. If the app cannot reconcile a HIL transaction, it freezes HIL withdrawals rather than guessing or silently falling back to simulation.

### 2.3 Meaning of “SENTINEL ON/OFF” and “attack”

- **Simulation baseline / Sentinel OFF** means the independent policy/gate is deliberately bypassed in the *software-only comparison*. It is not an instruction to disable or bypass the real ESP32 guardian.
- **Simulation protected / Sentinel ON** means the deterministic policy evaluates fixture evidence and the domain-owned gate enforces the result.
- **HIL protected** means the real connected pair must be healthy and the matching board-reported decision/commit lifecycle must be observed. HIL mode never becomes permissive because a board is missing.
- In HIL demonstrations, “attack” means a named, deterministic *synthetic compromise fixture* sent through a documented allowlisted test command (for example the existing Uno `FIXTURE_MISMATCH` input), or a controlled loss/replay simulation. It does **not** mean installing real malware, exploiting a commercial ATM, or claiming arbitrary malware detection.
- Do not add a “disable the physical guardian” control. If the ESP32 is disconnected, revoked, stale, or inconsistent, the protected HIL result is **DENY / NO VIRTUAL DISPENSE**.

## 3. Repository baseline and exact current gaps

The review below is based on `main` at `e59b00cd5ccbea6f495cb4bf91559a10e904dce1` and the latest supplied board logs.

| Area | Current state | Gap before final product |
|---|---|---|
| Native shell | Electron + React + TypeScript foundation exists; CI tests and package workflow pass for the current commit | Must validate actual install/launch/offline behavior on the intended Mac and Windows target, not only package creation |
| Main screens | ATM Terminal, Machine Model, Sentinel Console, Experiment Lab, Event Journal, and Hardware Bridge exist | Views still mostly reflect local reducer state rather than one joined simulation/HIL coordinator |
| Software ATM | A pure-ish reducer models PIN/session, balance, cassette, transactions, and a compromise fixture | Protected normal withdrawals do not require a prior explicit permit; scenario coverage and mode constraints need hardening |
| Sentinel simulation | One primary controlled-compromise fixture uses synthetic evidence and can block the software gate | Need a scenario catalogue, independent rule decisions, normal/negative controls, and repeatable experiment records |
| Uno firmware | Runtime fictional accounts/cash, PIN/session checks, transaction state, protocol messages, and permit-conditioned internal commit exist | Must solve physical status reception, improve typed reporting and transaction reconciliation, then bench-test |
| ESP32 firmware | Handshake, heartbeat checking, STATUS/PERMIT/DENY/REVOKE handling, transaction policy, and commit observation exist | Must demonstrate stable status round trips and the complete lifecycle on hardware; USB logs remain self-reported evidence |
| Peer UART | Uno is currently configured for AltSoftSerial D8 RX / D9 TX at 4800 baud; ESP32 UART2 uses GPIO16 RX / GPIO17 TX at 4800 baud | Latest logs still show no accepted HEALTHY STATUS on the Uno; exact failure point needs evidence, not another blind timing tweak |
| Voltage translation | The described equal 2.2 kΩ divider produces approximately 2.5 V from a 5 V Uno TX | This leaves too little margin for a robust ESP32 logic-high signal; establish a suitable level shifter or correctly calculated divider before final qualification |
| Desktop serial | `SerialManager` enumerates ports and receives bounded newline-terminated text; preload exposes connect/disconnect/list | There is no write-command API, allowlisted host command layer, typed board event parser, readiness state machine, or correlation with ATM actions |
| UI-to-board workflow | Board lines are displayed in Hardware Bridge | UI card/PIN/withdraw/scenario actions do not drive the Uno; incoming board messages do not drive the domain reducer or virtual gate |
| Transaction authority | Uno code waits for a matching ESP32 PERMIT before its own fictional balance/cash commit | Desktop gate and board transaction lifecycle are not integrated; board/desktop shadow state and lost-ack/reconciliation rules need definition |
| Evidence/export | JSON/CSV export and local event journal exist | Current exports principally describe the local software state; HIL provenance, raw/normalized board events, IDs and replayable scenario configuration need integration |
| Documentation | Threat model, experiment method, protocol, firmware implementation plan, and full simulator plan exist | Older plan files still describe earlier D2/D3 / 9600-baud SoftwareSerial assumptions; unify stale pins/timings and mark old plans as superseded where appropriate |
| CI | Firmware builds + protocol contract tests and desktop build/tests/package jobs pass on the latest `main` commit | Add protocol fault-injection tests, SerialManager tests, gate invariants, and packaged-app smoke checks; physical testing remains a separate gate |

### 3.1 Read of the latest hardware trace

Observed:

- Uno prints V3.3 and AltSoftSerial D8/D9 at 4800.
- ESP32 prints V3.3 and UART2 GPIO16/GPIO17 at 4800.
- The Uno sees the ESP32 handshake and says the V3 handshake completed.
- The ESP32 says the handshake was confirmed and a heartbeat was seen.
- The ESP32 logs `STATUS_TX` and `sendFrame_return=true`.
- The Uno does **not** log `[STATUS_RX] Accepted HEALTHY`; it eventually prints `[SECURITY_LOCK] Guardian status timeout`.
- The ESP32 later logs that the Uno reported a guardian lock, then remains REVOKED.

Interpretation:

1. The peer link is not simply dead in both directions: startup and at least one heartbeat path work.
2. `sendFrame_return=true` only means the ESP32 UART write call accepted the bytes; it is not a receiver acknowledgement.
3. The missing acceptance line leaves multiple possibilities open: response bytes never reached Uno RX, the frame terminator/receive path did not complete, parser/CRC/sequence validation rejected it, or the Uno had already transitioned into a timed-out state. The latest logs alone do not distinguish these.
4. The guardian's later REVOKE is consistent with fail-closed behavior after the Uno reports its own lock. Do not change the firmware to ignore that lock or accept arbitrary sequence gaps just to make the UI green.

## 4. Architecture contract before implementation

All code work should follow this data flow and never bypass it.

### 4.1 Simulation mode

1. The UI submits a typed ATM action or scenario request.
2. The domain engine validates the current session and creates a transaction ID.
3. The simulation policy evaluates the evidence for this run.
4. The domain-owned virtual-dispenser gate checks the current decision, decision freshness, transaction ID, mode, amount, balance, cassette inventory, and duplicate status immediately before mutation.
5. Only a successful allowed transition changes the balance/cassette and increments the released-virtual-cash total.
6. The journal records fixture/input → evidence → decision → gate result → state delta using correlated IDs.
7. Baseline mode is limited to this software comparison and is visibly labelled unprotected.

### 4.2 Protected hardware-in-the-loop mode

1. The application opens both selected USB console ports at 115200 baud, records board-role/path assignment, and begins passive observation.
2. A host-side HIL coordinator requires both devices to be in a verified current session state; “USB connected” alone does not mean “guardian ready.”
3. The app provisions only fictional demo account/cash/policy data through a narrow allowlisted command API, and confirms completion from structured responses. A board reset clears RAM-only state and requires recommissioning.
4. The customer/operator action is translated to an allowlisted Uno command. The Uno performs its controller-side checks, enters a single pending withdrawal, and emits a transaction-correlated request over the peer link.
5. The ESP32 validates the request/session/sequence/freshness/state/policy and issues one correlated PERMIT or DENY, or latches REVOKE.
6. The Uno accepts only a current matching decision and commits its own demo state once. The ESP32 expects the matching commit evidence.
7. The desktop verifies the same transaction ID/amount/session against the current HIL state and available Uno + ESP32 reports. Only then does its own software virtual-dispenser gate update the visual cash/account shadow once.
8. Any missing, duplicate, mismatched, stale, malformed, disconnected, timeout, revoked, or unrecognized evidence leaves the desktop virtual cash unchanged and moves HIL to a visible denied/fault/reconcile-required state.
9. Because USB text and ordinary session/CRC fields are not cryptographic attestation, HIL outcomes are labelled **BOARD-REPORTED** or **PROTOCOL-VALIDATED** according to what the app actually checked. Never label them proof of genuine uncompromised firmware.

### 4.3 Single-source-of-truth rules

- Simulation mode owns its synthetic state inside the tested domain model.
- In HIL mode, the Uno is the controller's own RAM-state model and the ESP32 is the policy guardian; the desktop keeps a shadow for visual display only.
- A desktop shadow is updated from one correlated successful HIL transaction at most once. A repeated line or repeated transaction ID is idempotent.
- If the controller reports a committed withdrawal but the guardian does not reconcile the same transaction, quarantine the HIL run. Do not undo or invent board-side state; request paired reset/recommission and visibly mark the unresolved transaction.
- No UI badge, event text, “CONNECTED” bit, or button press grants permission by itself.
- A restart invalidates the active session and outstanding permits. HIL cannot silently switch into simulation to complete a timed-out transaction.

## 5. Detailed implementation phases

Each phase should leave `main` buildable, have a narrowly reviewed commit, and finish with its exit tests. Do not start dependent phases while a gate is red.

### Phase 0 — Freeze the product contract and trace the baseline

**Goal:** Establish one agreed design and a trustworthy starting point.

1. Keep `main` as the source of truth; record its SHA in run logs.
2. Adopt the two explicit modes: software Simulation and Protected HIL. Define which controls are valid in each mode.
3. Write the state/provenance vocabulary once: DISCONNECTED, CONNECTED, NEGOTIATING, OBSERVING/READY, PENDING, DENIED, SUSPECT, REVOKED, ERROR, and RECONCILIATION REQUIRED.
4. Define transaction evidence fields: run ID, session ID, transaction ID, amount, board role, source/provenance, sequence where available, monotonic receive time, message type, decision, reason code and state delta.
5. Map every UI button to a domain action or a typed host operation. Any decorative button must be labelled informational or removed.
6. Make a trace matrix from existing firmware log lines to their expected state effects; do not infer a state from an unvalidated substring.
7. Keep the older full simulator plan as conceptual product context, and update/mark outdated UART-specific plans so only the current pin/baud contract is treated as active.

**Deliverables:** updated requirements/state diagram, baseline logs, gap checklist, current wiring sheet.  
**Exit gate:** simulation/HIL/baseline behavior is unambiguous; no authority is based on a connection badge or free-form log.

### Phase 1 — Close the physical UART issue with evidence

**Priority:** P0 / immediate blocker.

1. Power off and verify the final wire map: Uno D9 TX → suitable 5 V-to-3.3 V level translator → ESP32 GPIO16 RX; ESP32 GPIO17 TX → Uno D8 RX; common GND; divider's lower leg to shared GND. Uno D2/D3 are no longer the AltSoftSerial peer pins.
2. Measure or correctly engineer the Uno-TX level conversion. The equal 2.2 kΩ divider gives about 2.5 V; treat it as a weak-margin test setup, not qualified wiring. Prefer a suitable logic-level shifter or a correctly calculated divider with adequate HIGH margin and no overvoltage on ESP32 RX.
3. Verify the two USB ports run at 115200 and peer UART is 4800 8N1. Close Arduino Serial Monitor on any port that Electron is using; a serial port must have a single owner.
4. Add temporary, redacted, bounded diagnostics to distinguish: RX byte count, complete-line count, malformed framing, CRC mismatch, wrong session, sequence mismatch, accepted STATUS, last receive time, and last accepted sequence. Avoid flooding logs per byte and never log a PIN.
5. Reproduce with both current V3.3 sketches and a clean paired restart. Capture timestamps and order on both USB consoles.
6. If the status never reaches Uno RX, run an isolated two-direction UART loopback/echo diagnostic with the same pins, baud and frame sizes; restore the protocol sketches afterward.
7. If bytes arrive but validation fails, calculate the frame/CRC/expected sequence from captured bytes and fix that specific defect. Do not disable CRC checks, accept arbitrary sequence gaps, or extend every timeout without a trace-backed reason.
8. If the physical link and CRC are good, instrument state/timeout ordering and compare actual local elapsed times to the documented heartbeat/guardian deadlines.
9. Re-run after a paired power-up and a paired reset. Confirm `[STATUS_RX] Accepted HEALTHY` occurs before any guardian timeout and that ESP32 stays OBSERVING rather than REVOKED.
10. Only after basic stability, perform at least 10 consecutive clean starts as an early bench gate; the later release gate remains 100 starts and 30 minutes of continuous observation.

**Deliverables:** cause classification, corrected wire/level notes, paired logs, regression test reproducing the timing/sequence invariant.  
**Exit gate:** the Uno accepts valid HEALTHY status repeatedly with no unexplained timeout or corruption. A successful compile does not pass this phase.

### Phase 2 — Make the peer protocol explicit and testable

**Goal:** Prevent the liveness fix from being another timing-only patch.

1. Review the existing S3 frame format, CRC-16/CCITT-FALSE, session rules, per-direction sequence counters, and one-outstanding-heartbeat gate.
2. Specify every message's exact direction, schema, maximum length, legal state, sequence rules, timeout, retry count, idempotency key, and effect.
3. Correlate each STATUS to the heartbeat/request it answers. Define a response acknowledgement or equivalent confirmed-receipt mechanism so the ESP32 can distinguish “UART write succeeded locally” from “Uno accepted the status.”
4. Define when an outbound sequence is allocated; retransmission must reuse the exact same sequence and payload. A duplicate with identical content may be idempotent only in its documented retry window. A conflicting duplicate remains a fault.
5. Ensure a STATUS retry window can complete before the normal guardian-liveness timeout. Do not let a new STATE or lock-report inadvertently cancel recovery before the bounded response attempt finishes; still fail closed when retry exhaustion or the overall deadline is reached.
6. Preserve the rule that STATUS proves liveness only; it is not a transaction PERMIT.
7. Ensure the final handshake ACK is confirmed before OBSERVING/READY. On reboot, old sessions and permits cannot survive.
8. Formalize typed error classes: malformed line, CRC failure, wrong session, duplicate, sequence gap, stale message, illegal state, missing ACK, timeout and exhausted retries.
9. Keep bounded static buffers on the Uno. Reject overflow/truncation rather than processing partial data.
10. Update `docs/SENTINEL_PROTOCOL.md`, contract tests, status messages, and all active wiring documents together.

**Deliverables:** protocol state diagram, frame/schema table, golden frame vectors, bounded retry/ack rules.  
**Exit gate:** both builds and tests pass; the simulated peer can prove STATUS receipt or converges to an explicit fail-closed fault; no unexplained “healthy” state.

### Phase 3 — Build a deterministic protocol fault simulator

**Goal:** Find link/state bugs without repeatedly reflashing boards for every failure.

1. Add a host-side protocol harness that feeds the same serialized messages to small testable protocol functions/state models.
2. Support deterministic drop, delay, duplicate, corruption, truncation, concatenation, overlong line, wrong session, wrong sequence, reset of either peer, and timeout injection.
3. Test startup ordering: ESP32 first, Uno first, simultaneous power, delayed startup, one-sided reset, paired reset, and a lost handshake acknowledgement.
4. Test liveness: lost STATUS, delayed STATUS, invalid CRC, exact duplicate STATUS, unrelated message arriving while STATUS is pending, and no heartbeat after a failed exchange.
5. Test that a failed frame cannot refresh freshness or grant authorization.
6. Test that bounded retries stop and leave the system fail-closed rather than retrying forever.
7. Test sequence exhaustion and millis()-timer wrap using the host model where practical.
8. Add the harness to GitHub Actions beside `.github/protocol-v3-handshake-contract.mjs`.

**Deliverables:** repeatable fault-injection suite and test traces.  
**Exit gate:** every injected failure either recovers through the documented retry or ends in an explicit fault; none produces a permit or state mutation without authorization.

### Phase 4 — Repair the simulation authority gate before HIL wiring

**Priority:** P0 correctness blocker.

1. Refactor the domain core so a withdrawal request, policy decision, and cash mutation are separate transitions.
2. Replace the implicit rule “not revoked means allowed” with an explicit decision record: transaction ID, mode, decision, evidence source, session/run ID, issue time, expiry/deadline and reason.
3. In protected simulation, run the policy against current evidence and require a fresh explicit PERMIT for the exact pending withdrawal before changing balance/cassette.
4. Do not create `lastDecision: PERMIT` as a side effect of already having dispensed the cash. The decision must precede the gate mutation.
5. Reject missing, expired, stale, wrong-transaction, duplicate, revoked, or unknown decisions. Refusal must leave account balance, cassette cash and total released virtual cash unchanged.
6. Keep baseline mode explicitly unprotected and software-only. It may reproduce the intended controlled unauthorized dispense for comparison, but that route must not be reachable from HIL mode.
7. Give each transaction a stable idempotency key; a double click/replayed action cannot decrement the same cassette twice.
8. Reset/transition flows must clear pending authority; reusing a previous PERMIT after reset is forbidden.
9. Make the normal allowed simulation case test an actual policy-issued PERMIT; add negative tests proving that `MONITORING` alone is not a permit.
10. Expand `src/core/atm-engine.test.ts` for valid permit, missing permit, stale permit, wrong ID, duplicate confirm, revoked mode, reset, deny, timeout and unchanged balances.

**Deliverables:** tested transaction/gate state machine and explicit authority object.  
**Exit gate:** every protected cash mutation has a prior current decision for the same transaction; all denial/fault paths preserve money invariants.

### Phase 5 — Define and implement the safe scenario catalogue

1. Keep the existing S-001 controlled-compromise scenario as the first deterministic fixture.
2. Define each scenario as versioned data, not as a button hardcoded to set the verdict. Each definition must include inputs, initial conditions, expected policy behavior, known blind spots, evidence provenance and reset requirements.
3. Add a normal authorized withdrawal as a positive control.
4. Add software fixtures for illegal state transition, sequence divergence, stale/duplicate frame, heartbeat timeout, reported profile mismatch, privileged path outside maintenance, policy limit denial, controller restart and dispenser-empty/jam conditions.
5. Label any board-injected fixture as synthetic. The existing Uno `FIXTURE_MISMATCH` reports a synthetic profile-mismatch event; it is not an actual exploit or evidence that malware was found.
6. For protocol-corruption scenarios, prefer the host-side fault simulator. Do not encourage manual shorting, overvoltage, real attacks, or writing random bytes to the board as a classroom demo.
7. Separate evidence injection from policy evaluation and the final virtual-gate result.
8. Reset to identical account balance, cassette, session and seed before baseline/protected replay.
9. Require at least five software repetitions of each scenario, preserving per-run metrics and failures.
10. Present false positives/false negatives and limitations alongside detection outcomes; don't suppress a run where unauthorized virtual cash moved.

**Deliverables:** scenario registry, reset/replay action, expected-results table.  
**Exit gate:** scenario choice doesn't choose the verdict; the gate's actual money-state delta matches the displayed outcome.

### Phase 6 — Finish the host-side serial transport in Electron

**Current gap:** `electron/serial-manager.cjs` only opens a port and emits newline-delimited incoming text. The preload exposes no write operation.

1. Keep all serial port ownership in Electron's main process. The renderer must not access Node SerialPort or raw IPC.
2. Extend the main-process serial adapter with a bounded `writeLine`/typed-command operation that confirms port-open state and reports errors/timeouts.
3. Expose only narrow operations through `electron/preload.cjs`; never expose raw arbitrary `ipcRenderer`, filesystem, shell, or unrestricted serial writes.
4. Validate board role, selected path, allowed command enum, field types, length/ranges, and line termination in the main process. Reject embedded newlines/control characters and unknown commands.
5. Prevent the same physical serial path being assigned simultaneously to both device roles; handle disconnect/close/error consistently.
6. Keep USB-console baud at 115200 distinct from inter-board peer baud at 4800.
7. Preserve bounded incoming lines and add tests for fragmented chunks, CRLF, multiple lines per chunk, overlong lines, empty lines, malformed UTF-8, port removal, double connect, and write failure.
8. Add request IDs and a timeout/response matcher where a command expects a response. One pending customer command/transaction per board unless the protocol explicitly supports concurrency.
9. Make reconnect explicit. A closed/reopened port or board reset invalidates readiness and requires the readiness/session sequence to be re-established.
10. Record serial errors as transport events, not as a security verdict and not as a successful command.

**Deliverables:** typed main-process transport API, safe command allowlist, SerialManager tests.  
**Exit gate:** all serial operations are serialized/validated, errors observable, and no untrusted renderer input can send arbitrary board bytes.

### Phase 7 — Add a typed board-command and telemetry contract

1. Write the supported host-to-Uno command schema and host-visible response schema. Start from existing firmware commands: fictional account provisioning, cash/policy configuration, CARD/PIN, balance, withdrawal, cancel/logout, status, journal and the clearly labelled synthetic `FIXTURE_MISMATCH`.
2. Do not permit desktop actions to configure unknown board addresses, arbitrary pins, bootloaders, or real peripherals. This project has no physical dispenser and should remain that way.
3. Add structured command success/failure replies with request ID, session/run correlation, known command type and sanitized reason. Existing `ATM_EVENT`/`ATM_STATUS` lines can be supported during migration, but free-form log strings are not the final contract.
4. Ensure host-facing output contains no PIN or other credential content. A PIN may be transiently sent to the Uno as a fictional demo value but must not be included in events, errors, export logs, or crash text.
5. Add a read-only demo-state/status command or adequate structured reports so the app can reconcile fictional balance, cassette, active session and transaction count without reading hidden PIN values.
6. Ensure the ESP32's report can identify session, guardian mode, recent valid heartbeat age, current pending transaction, last decision/reason and commit reconciliation status. A self-reported string remains BOARD-REPORTED, not cryptographic proof.
7. Keep local USB commands separate from the ESP32 peer protocol. A host command may not forge peer ACK/PERMIT frames or clear a latched REVOKE.
8. Define behavior on command timeout: don't blindly resend a non-idempotent withdrawal. First query its status by request/transaction ID; if state is uncertain, require reconciliation or a paired reset.
9. Confirm current baud/routing in the docs: Uno USB console 115200; Uno peer AltSoftSerial D8/D9 at 4800; ESP32 USB console 115200; ESP32 UART2 GPIO16/17 at 4800.
10. Make fixture commands visibly labelled “SIMULATED FIXTURE” in UI and journal.

**Deliverables:** host protocol spec and typed command/response types.  
**Exit gate:** each host action has a bounded documented response; PINs remain redacted; unknown commands fail without board state mutation.

### Phase 8 — Add the hardware readiness and lifecycle coordinator

1. Replace the single UI boolean `connected` with the explicit device/link/authority states defined in Phase 0.
2. Distinguish USB port open, expected boot banner observed, peer handshake completed, fresh HEALTHY status accepted, guardian OBSERVING, guardian REVOKED, and HIL transaction reconciliation.
3. Require both Uno and ESP32 consoles to be connected/identified before enabling HIL withdrawal operations.
4. Treat board boot/reset as a new session; clear any old pending request, permit, status freshness and HIL transaction expectation.
5. Display live session identity, last accepted status age, current guardian state, last receive/command error, firmware banner (self-reported) and whether RAM state requires commissioning.
6. When either board becomes stale, closes its USB port, reports a protocol fault, or loses the peer, disable new HIL withdrawals immediately. Leave existing transaction result as unresolved until reconciled; don't silently switch to simulation.
7. If the ESP32 reports REVOKED or the Uno reports GUARDIAN_LOCKED, latch the app HIL run into DENY/LOCKDOWN. Clearing the UI alone must not clear the boards.
8. Add a deliberate paired-reset/recommission workflow with an explanation that the firmware's accounts, PINs, balances and policy are RAM-only and are lost on reset.
9. The HIL UI must never equate “last line received” with “guardian healthy.”
10. Keep simulation usable even with no boards connected.

**Deliverables:** HIL lifecycle controller and a status panel driven by validated state.  
**Exit gate:** disconnect/reset/stale inputs always disable HIL permission, and readiness never depends only on a visual indicator.

### Phase 9 — Connect the ATM OS actions to the Uno

1. In HIL mode, route operator setup and customer UI events through the typed host adapter instead of mutating the local simulation state directly.
2. When the operator commissions a demo, provision only fictional card ID, PIN, starting balance, note counts and matching transaction limits. Show a concise confirmation before provisioning.
3. Confirm successful provisioning before making the customer terminal ready. If the Uno resets, mark the demo as uncommissioned and require re-provisioning.
4. For a customer session, send the relevant CARD/PIN commands and wait for the Uno's accepted/rejected response before the HIL UI updates its state.
5. For balance, request the Uno's read-only state and display the returned controller-reported value with provenance; never silently substitute the local simulation balance.
6. For withdrawal, create an app correlation/request ID and record the board transaction ID assigned by the Uno. Show the workflow as PENDING while the Uno and ESP32 decide.
7. Never send a second withdrawal command while the first is pending or uncertain.
8. On an explicit board denial, link timeout, revoke, mismatched ID/amount or missing commit, show a denial/incident and keep desktop virtual cash unchanged.
9. Keep the software-only reducer as a separate mode; do not run it in parallel with HIL and then merge two sets of money values implicitly.
10. Expose `STATUS` and `JOURNAL` actions as diagnostics only; they never confer permission.

**Deliverables:** fully usable HIL terminal actions and explicit commission/reconnect/recovery flows.  
**Exit gate:** pressing a supported customer action actually issues a validated Uno command and displays a result derived from correlated board responses, not merely a local reducer transition.

### Phase 10 — Integrate the complete permit/commit lifecycle with the virtual gate

1. Define the exact transaction ID/amount lifecycle across app request, Uno REQUEST, ESP32 PERMIT/DENY, Uno controller commit, ESP32 commit observation and desktop shadow update.
2. Verify the ESP32's observed PERMIT report is linked to the exact pending transaction; ensure its current protocol/session/freshness gate is true when the decision is issued.
3. Verify Uno's `WITHDRAWAL_APPROVED` event carries matching transaction ID, amount and final reported balance. Add safe structured cassette/transaction state reporting as needed.
4. Verify the ESP32's matching-commit observation is tied to that same ID and amount, not just to an arbitrary EVENT payload containing `id=`.
5. The desktop gate requires: HIL mode, current paired session, guardian not revoked, fresh accepted status, matching request ID/transaction ID/amount, a reported allowed decision, matching Uno commit, matching guardian reconciliation, and no prior desktop commit for that transaction.
6. Commit the desktop shadow balance/cassette once and only once after the required evidence arrives. Store a committed-ID set for the run and ignore an exact duplicate outcome without repeating the money mutation.
7. Treat a mismatch, repeated ID with different amount, late permit, stale session, missing commit or port drop as DENY/RECONCILIATION REQUIRED. The screen must say what is unknown rather than displaying a successful dispense.
8. If Uno committed internally but a USB event was lost, do not invent a second command or claim success. Freeze HIL withdrawals, query state if supported, and recover through the documented reconciliation process.
9. Make timeout ordering explicit. Retries reuse request identity; a timeout cannot be converted into a new transaction ID that evades the guardian's budget/replay checks.
10. Verify baseline/off behavior is inaccessible from HIL. The UI can run a separate baseline simulation after resetting into Simulation mode, but may not disable guardian checks on connected boards.
11. Keep the physical dispenser out of scope. The only release effect is a software-rendered virtual cash result and fictional account/cassette update.
12. Add logs showing the transaction's full transition timeline and source/provenance for each assertion.

**Deliverables:** integrated transaction coordinator and HIL virtual gate.  
**Exit gate:** no HIL virtual cash changes on any missing/mismatched/revoked/stale decision; one allowed transaction changes each software shadow exactly once and reconciles against board-reported state.

### Phase 11 — Expand the Sentinel console and safe control surface

1. Show actual HIL board status and software-simulation status in separate clearly labelled panels.
2. Provide mode controls with the guardrails defined in Section 2.3. The protected HIL mode cannot be switched to an unprotected hardware mode.
3. Add an operator commissioning screen and a “Run synthetic fixture” action enabled only when its prerequisite state is satisfied.
4. The fixture runner should explain which signals are synthetic, which are board-reported, what the ESP32 is expected to do, and whether the virtual gate actually changed.
5. Cover these minimum cases:
   - S-000: normal authorized virtual withdrawal (positive control).
   - S-001: synthetic controller-profile mismatch via an explicit fixture.
   - S-002: guardian heartbeat/status loss or ESP32 disconnect.
   - S-003: illegal-state-transition fixture.
   - S-004: duplicate/replayed transaction ID through the host protocol simulator.
   - S-005: stale/CRC-invalid frame through the host protocol simulator.
   - S-006: privileged-path-outside-maintenance synthetic fixture.
   - S-007: controller or guardian reset during an active session.
   - S-008: account/policy/cassette limit denial.
   - S-009: empty/insufficient virtual cassette.
   - S-010: software-only baseline comparison where the controlled unauthorized virtual release is intentionally demonstrated.
6. Never claim every fixture is a real on-board attack. Mark which cases are simulator-only, host-simulated transport cases, and actual two-board observations.
7. Every case defines prerequisites, run ID, starting account/cassette, fault injection, expected decision, expected state delta, timeout, recovery, evidence provenance and known limitations.
8. On HIL fixture REVOKE, show authority revoked and require the documented paired reset/recommission before subsequent protected transactions.

**Deliverables:** scenario catalogue, safe operator actions, linked experiment results.  
**Exit gate:** each fixture is repeatable and accurately labelled; selected fixture does not itself force the detector result.

### Phase 12 — Finish journal, evidence, metrics and replay

1. Use stable event IDs, run IDs, session IDs, transaction IDs and monotonic elapsed time for ordering/latency.
2. Store raw diagnostic lines separately from parsed events; preserve the original line for review but never treat it as verified protocol evidence automatically.
3. Tag every item as SIMULATED, BOARD-REPORTED, PROTOCOL-VALIDATED or INDEPENDENTLY OBSERVED. Document precisely how each tag is earned.
4. Redact PINs and credential-bearing command values at source before logs enter React state, IPC events, app-data records or exports.
5. Include software/firmware build banner, source commit, board configuration, port role, mode, fixture version and policy configuration in each run record.
6. Capture starting/final account balance and cassette; requested amount; permit/deny/revoke reason; decision/gate result; unauthorized successful virtual dispenses; reset/timeout/recovery; and any reconciliation mismatch.
7. Measure decision latency only using a monotonic clock and report missing data as unavailable rather than zero. Never use serial log arrival as proof of exact time spent in the guardian.
8. Persist completed experiment records in the OS application-data path with schema versioning; support JSON/CSV export and replay of the fixture configuration.
9. Replay must preserve evidence provenance and clearly state that replay does not re-run the physical hardware.
10. Keep prior runs immutable; resetting the active simulation should not erase exported/persisted research evidence without explicit operator action.

**Deliverables:** versioned run schema, safe persistence, export and deterministic software replay.  
**Exit gate:** an exported run explains what was injected, what was observed, why the decision occurred, what the gate did and what changed.

### Phase 13 — Complete the ATM OS experience and safety states

1. Connect existing ATM Terminal, Machine Model, Sentinel Console, Experiment Lab, Event Journal and Hardware Bridge to the common mode/session coordinator.
2. Ensure each screen displays whether it is in Simulation or HIL and gives accurate source/provenance labels.
3. In HIL mode, display pending, denied, revoked, disconnected, timeout and reconciliation-required screens before allowing a new withdrawal.
4. Add explicit operator actions for scan ports, connect/disconnect, provision demo, start/reset scenario, issue a safe fixture, clear a *simulation* run, and perform paired board recommissioning. Do not expose arbitrary serial commands.
5. Keep PIN input masked and clear the UI buffer on submit/cancel/disconnect/error. Do not log PIN keystrokes or the submitted value.
6. Show the virtual cash amount only after the gate result is final; use a conspicuous pending state before it is final.
7. Make “SENTINEL OFF” visibly software-only. If hardware is attached and HIL is selected, show that guard-unavailable status blocks transactions rather than offering bypass.
8. Keep Machine Model descriptions truthful: simulated cabinet sensors, EPP, backup power, etc. must not appear connected to hardware when they are only models.
9. Make state reset and board reset meanings explicit; do not show “READY” after a one-sided reboot until re-handshake/recommission passes.
10. Keep the interface functional without boards or internet; optional HIL controls should not break Simulation mode.

**Deliverables:** unified interaction flows and visible safety/provenance states.  
**Exit gate:** no screen can accidentally mix simulation money with hardware-reported transactions or render a success while the gate denied the request.

### Phase 14 — Comprehensive automated verification

**Domain and UI tests**
- Normal protected withdrawal requires a policy permit that predates the gate mutation.
- Missing, expired, stale, wrong-ID, wrong-amount, replayed and revoked authority leaves all money counters unchanged.
- Baseline release occurs only in explicit software-only baseline mode.
- Duplicate click, duplicate event, duplicate transaction ID and late response cannot double-commit.
- User PIN is masked/redacted; logs/exports never contain it.
- Reset, disconnect or mode switch clears pending decisions and old session authority.
- Cash arithmetic, denomination constraints, policy limits and balance/cassette invariants hold.

**Transport and protocol tests**
- Port scan/no devices/port already occupied/double connect/unplug during read/write.
- Fragmented serial chunks, CRLF, concatenated frames, overlong lines, invalid encodings, missing delimiter, bad CRC and malformed payload.
- Handshake duplicates/retries, lost ACK, delayed or corrupt STATUS, status acknowledgement, retry exhaustion and peer restart.
- No protocol gap is silently skipped; stale permits are rejected.
- The USB console parser does not misinterpret boot text or arbitrary lines as READY/PERMIT/COMMIT.

**End-to-end tests**
- Connect both emulated serial endpoints; run provision → CARD → PIN → WITHDRAW → status/permit/commit → desktop gate.
- Run a fixture and prove a revoke blocks the software virtual gate with unchanged money state.
- Disconnect either board at every step of a pending transaction; test no false success and deterministic recovery.
- Confirm the transaction ID displayed in UI, Uno response and ESP32 report is the same.
- Run the software-only baseline/protected comparison independent of physical ports.
- Confirm simulation can be used with no board and no network.

**CI deliverables**
- Keep Uno/ESP32 compilation and protocol contract tests.
- Add host fault simulation and domain gate property tests.
- Add SerialManager/preload/main IPC tests with mocked ports.
- Keep main-process security checks and renderer build tests.
- Validate generated macOS and Windows artifacts; run available offline startup smoke tests.
- Track compiler warnings and Uno flash/SRAM usage; do not treat warnings as harmless by default.

**Exit gate:** every automated check passes on the current main SHA. CI pass is necessary but does not substitute for physical acceptance.

### Phase 15 — Physical bench qualification

1. Use only fictional data and the existing one-Uno/one-ESP32 setup.
2. Confirm the final documented level shifting and common ground; do not connect Uno 5 V TX directly to ESP32 RX.
3. Run 100 paired startup/reconnect cycles in the release qualification suite. Record all handshake, accepted status, reset and revoke outcomes.
4. Run at least 30 minutes with the boards connected but no transactions; track status age, CRC/framing errors, timeouts, spontaneous revokes and resets.
5. Test ESP32 first, Uno first, simultaneous power, staggered power, paired restart, Uno-only reset, ESP32-only reset, USB console close/reopen, and disconnected cable.
6. After the idle link is stable, provision a fictional account/cassette and test normal withdrawal, each policy denial, the synthetic mismatch fixture, timeout/revoke, duplicate/mismatched transaction, lost report, and recovery.
7. For each failed or denied transaction, compare Uno report, guardian report, desktop shadow and journal. No unexplained balance/cassette divergence is accepted.
8. Confirm a physical link fault cannot leave the desktop HIL gate permissive or allow a normal withdrawal to proceed in local simulation behind the operator's back.
9. Save the exact current commit, firmware build banner, wiring/level shifter details, test procedure and redacted paired logs.
10. Report FAIL/NOT RUN honestly; never convert missing hardware evidence to PASS.

**Deliverables:** signed-off test matrix and redacted evidence package.  
**Exit gate:** all prescribed physical cases pass with no unexplained timeout, duplicate release, or unauthorized virtual-cash update.

### Phase 16 — Packaging and operator-ready release

1. Build the macOS Apple Silicon DMG/ZIP and Windows x64 installer/ZIP from the same tested commit.
2. Verify each archive/install target exists and contains the local renderer, Electron main/preload and native serial dependencies.
3. Run app launch, navigate all six areas, use Simulation mode offline, export JSON/CSV, and exit cleanly.
4. On the Mac target, enumerate/assign the actual Uno and ESP32 ports; confirm the correct 115200 console settings and that Arduino IDE Serial Monitor has released the port.
5. On Windows, verify USB port enumeration and adapter handling when a Windows device is available; do not claim hardware qualification from Linux CI alone.
6. Make unsigned-build warnings and installer provenance clear until signing/notarization credentials are legitimately configured.
7. Keep a release manifest containing source SHA, artifact checksums, package versions, firmware hashes/build banners, and whether physical testing passed.
8. Store no credentials/secrets in the repo or build logs.

**Deliverables:** validated installers, checksums, release notes and tested operator workflow.  
**Exit gate:** installed app works offline; actual artifacts are verified and trace back to the tested SHA.

### Phase 17 — Prepare the demonstration and research report

1. Begin with a normal permitted software transaction to show the positive control.
2. Show the software-only baseline fixture and the intentional unauthorized virtual release. Label it as a controlled simulation.
3. Reset to the same synthetic starting state, switch to protected simulation, replay the exact fixture, and show the evaluated findings and unchanged cash inventory.
4. If and only if the physical status gate passes, demonstrate HIL: connect boards, establish current session, provision fictional data, run the synthetic `FIXTURE_MISMATCH`, show the ESP32's reported revoke and Uno lock, and show the desktop HIL gate remaining unchanged.
5. Do not run a normal HIL withdrawal while link status is unhealthy; do not present the current broken status trace as a successful protection demo.
6. Export the journal and show the event correlation, provenance, decision reason and state delta.
7. Report per-fixture results, including failures and false positives/negatives. Do not remove a failed run from the report.
8. State the limitations: no real cash, no bank network, no physical actuator/interlock, no secure element or protected key, no cryptographic peer authentication, and no proof of arbitrary malware detection.
9. Prepare a backup simulation-only demonstration so a physical cable/USB/driver failure does not cause the team to claim that hardware was verified.
10. The presenter must be able to explain the authority chain: Uno requests, ESP32 evaluates/permits/revokes, and the desktop virtual gate alone updates the displayed virtual inventory after its own checks.

**Deliverables:** reproducible run pack, short presenter flow, source commit and honest limitations.  
**Exit gate:** every spoken security claim matches a test or is explicitly labelled a simulation.

## 6. Priority order and dependencies

| Priority | Work | Depends on | Why it is first |
|---|---|---|---|
| P0 | Resolve status UART issue and correct level translation | Current V3.3 firmware + paired boards | HIL cannot be demonstrated until valid status is repeatedly accepted |
| P0 | Repair protected-mode virtual-dispenser authorization | Existing domain engine/tests | The software product must never mark a normal withdrawal as permitted without an actual policy decision |
| P1 | Protocol acknowledgement/retry + fault simulator | P0 root-cause trace | Avoid another unverified timing-only fix |
| P1 | Electron allowlisted serial-write and typed event API | Command/telemetry contract | OS currently cannot control the Uno |
| P1 | HIL lifecycle/session coordinator | P0 UART + protocol contract + serial API | Connection, READY, REVOKED and reset are different states |
| P1 | End-to-end transaction correlation and final gate | Domain gate + host adapter + board telemetry | Joins the three components into a single authority flow |
| P2 | Safe scenario catalogue, journal, metrics/replay | Scenario and HIL coordinators | Makes the demonstration repeatable and evidence-backed |
| P2 | UI completion and accurate provenance labels | Integrated domain/HIL state | Prevents a disconnected simulation panel from looking like live control |
| P2 | Automation + physical acceptance matrix | Implemented flows | Proves negative cases and money-state invariants |
| P3 | Release packaging/qualification and presentation flow | Gates above | Produces an honest, supportable final product |

## 7. Non-negotiable safety and product invariants

1. No guardian, no fresh authority, no virtual release.
2. A USB connection or banner is not proof that the peer protocol is healthy.
3. A local UART write success is not a receiver acknowledgement.
4. A heartbeat/status frame is not a withdrawal permit.
5. A valid permit is transaction-specific, session-specific, time-bounded, and single-use.
6. Any denied, timed-out, revoked, stale, malformed or mismatched transaction changes no desktop balance/cassette value.
7. Repeated actions/responses cannot produce duplicate cash release.
8. The software-only baseline cannot control physical hardware or bypass HIL protection.
9. All account/PIN/cash data is fictional, RAM-only on the boards, and re-provisioned after reset.
10. No credential appears in logs, event journal, IPC diagnostics or exports.
11. Simulated sensors/fixtures remain labelled simulated; board reports remain labelled board-reported unless a parser/check actually validated the specific protocol data.
12. CRC and sequence checks detect accidental corruption/replay patterns but do not authenticate a malicious peer.
13. There is no physical cash dispenser in this prototype. Virtual cash presentation is the only dispense effect.
14. Security policy cannot be weakened to make a failing test look successful.
15. Current source changes must be made on the active `main` baseline and the final build/test/hardware evidence must refer to one traceable SHA.

## 8. Definition of done

SENTINEL is ready to be presented as the **integrated prototype** only when all of the following are true:

- [ ] Uno accepts valid ESP32 HEALTHY status repeatedly; no unexplained guardian timeout.
- [ ] Correct level translation and documented pins/baud are verified.
- [ ] Both board builds and expanded protocol/fault tests pass on the final SHA.
- [ ] Protected simulation requires explicit prior authorization; unauthorized scenario cannot mutate money state.
- [ ] Electron sends only allowlisted commands through main-process IPC; incoming board reports are parsed and correlated.
- [ ] The OS can commission fictional Uno demo state and drive CARD/PIN/BALANCE/WITHDRAW through the board in HIL.
- [ ] ESP32 decision, Uno commit and desktop shadow update correlate to one ID/amount/session and happen at most once.
- [ ] Lost status, disconnect, timeout, reset, duplicate and mismatched event all fail closed without a desktop virtual dispense.
- [ ] Simulation baseline and protected simulation are repeatable and explicitly separated from physical HIL.
- [ ] Scenario journal/export records provenance, decisions, outcome, state delta and known limitations.
- [ ] Packaging and offline operation are verified on the supported OS targets.
- [ ] Required hardware qualification and honest limitation review are recorded; any unrun tests remain NOT RUN.

**The plan's critical path is:** prove UART → prove the protocol under loss/delay → fix the software authorization gate → add the safe desktop serial command/telemetry layer → orchestrate a correlated HIL transaction → run failure-injection and physical acceptance → qualify the installer and demonstration.

Until that path is complete, describe the project as **a native ATM simulation plus a board-firmware prototype under hardware-integration testing**, not a finished OS that already controls the Uno end to end.
