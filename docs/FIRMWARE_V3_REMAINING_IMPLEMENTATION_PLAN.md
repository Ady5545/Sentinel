# SENTINEL V3 Remaining Implementation Plan

**Purpose:** This is the residual work extracted from `docs/FIRMWARE_V3_IMPLEMENTATION_PLAN.md` and `docs/SENTINEL_PROTOCOL.md` after auditing the actual firmware, host tests, CI, and available physical evidence. It is not a replacement for either source document; the two source documents remain authoritative.

**Audited baseline:** `cd7d9c3606e99ddfe86189b22d8c0697d726862a` (main at audit time)  
**Firmware revision:** source banners report V3.4  
**Last CI evidence checked:** firmware build + V3 contract tests and desktop tests passed at the preceding commit `cd7d9c3606e99ddfe86189b22d8c0697d726862a`. Packaging for the newer source revisions must be rechecked.  
**Physical qualification:** NOT RUN / NOT VERIFIED in this audit. A successful CI run is not proof that the connected boards communicate reliably.

## 1. Baseline classification

| Area | Status | Evidence / remaining limit |
|---|---|---|
| S3 frame format, newline framing, CRC-16/CCITT-FALSE, bounded parsing | PARTIAL PASS | Both sketches compile; contract and host reference tests cover important cases. Host reference parser is not yet the actual C++ parser compiled to host. |
| Four-message V3 startup handshake and fixed-identity retry cases | PARTIAL PASS | Firmware and source-contract tests cover expected startup identities and duplicate handshake paths. Full endpoint-to-endpoint fault sweep remains outstanding. |
| Per-heartbeat STATUS correlation | IMPLEMENTED IN CODE / HARDWARE UNVERIFIED | STATUS carries `ack_seq`; Uno checks it against its one outstanding heartbeat; retries reuse a STATUS sequence. Actual physical stability remains unproven. |
| Bounded RX work | IMPLEMENTED IN CODE / HARDWARE UNVERIFIED | Both peer receive loops process at most 64 bytes per loop. Timing sufficiency must be checked on the physical pair. |
| Exact schemas for ESP32 STATE, HEARTBEAT, REQUEST, typed EVENT | PARTIAL PASS | Implemented for key state-changing message families; every message (including ACK, STATUS, PERMIT, DENY, REVOKE and diagnostic payloads) still needs one canonical table and exhaustive malformed-input tests. |
| PERMIT/DENY correlation | IMPLEMENTED IN CODE / CI PENDING FOR LATEST COMMIT | V3.4 decision payloads include transaction ID and amount; Uno verifies both against its pending transaction; DENY also requires a recognised reason. Must be verified against the latest CI and on hardware. |
| Typed `TX_COMMITTED` report | IMPLEMENTED IN CODE / DELIVERY NOT RELIABLE | ESP32 requires exact `event=TX_COMMITTED;id=…;amount=…` fields. The commit event is not yet protected by a general message ACK/retry/dedup protocol. |
| Exactly-once mutation under lost/duplicate commit reports | INCOMPLETE — PRIORITY 0 | Uno mutates RAM state before reporting the commit. If the event is lost, guardian reconciliation times out/revokes while the Uno already changed its own RAM state. A safe, explicit commit acknowledgement/retry lifecycle is needed; never repeat the balance mutation. |
| Stop-and-wait ACK/retry for all critical messages | INCOMPLETE — PRIORITY 0 | Startup and STATUS retries exist, but REQUEST/PERMIT/DENY/commit are not all protected by a complete acknowledged-delivery state machine. |
| Guardian budget reservations and release rules | PARTIAL | Approved amount is budgeted when PERMIT is issued. Lost decision / timeout / revoked-session accounting and reboot semantics require a written table and tests; do not create a retry path that bypasses the budget. |
| Transaction ID and counter exhaustion | PARTIAL | Guards have been added on some paths; audit every unsigned counter, sequence allocator, transaction ID formatter, budget multiplication/addition and commit counter. |
| Uno/ESP32 state-transition matrix | INCOMPLETE | Some explicit checks exist; no complete host-tested table covers every current state/message pair and auth/state consistency. |
| Configuration atomicity and validation | PARTIAL | Policy parser uses temporary values in the current sketch; all supported short/full command forms and cross-policy timeouts need host or source-contract coverage. |
| PIN handling and secret clearing | PARTIAL | PIN buffers use clearing helpers in selected paths. Audit every parse buffer, rejected command, timeout, reset, and log path. Never print a PIN. |
| Recovery/reset behavior | PARTIAL | Revoke latches within a runtime and startup changes are guarded. A formal paired-reset/recommission contract and tests are still required for each board resetting alone, both restarting, and pending transactions. |
| Host protocol model | IMPLEMENTED AS A REFERENCE MODEL / NOT A FIRMWARE EMULATOR | `.github/protocol-v3-model.node.mjs` covers CRC, framing, fault injection primitives, STATUS correlation, sequence/session rules, transaction properties and timer rollover. It does not execute the embedded C++ state machines, and all planned fault kinds are not yet exercised end-to-end through both endpoint models. |
| CI: board compile + source-contract tests | PASS AT LAST VERIFIED REVISION | Re-run on current head. Add model test path to both push and pull-request path filters. |
| Flash/RAM and timing measurements | NOT RUN | Add reproducible build-size output and measure Uno flash/SRAM margin and worst-case loop/RX timing. |
| Physical startup/link/transaction qualification | NOT RUN | Actual Uno + ESP32 tests are required: both start orders, paired reset, single-board resets, repeated startup, idle observation, transactions, and fault cases. |
| Desktop HIL integration | SEPARATE PRODUCT SCOPE / NOT QUALIFIED BY THIS FIRMWARE PLAN | Desktop is not a physical safety interlock; its shadow ledger must only update from current, exact reconciliation evidence and must quarantine on board reconnect/reset. This source plan treats desktop integration as a separate workstream. |

## 2. Remaining implementation backlog — ordered

### P0 — Make transaction delivery and commit reconciliation reliable

- [ ] Define one exact, bounded, per-direction stop-and-wait contract for REQUEST, PERMIT, DENY, TX_COMMITTED, and the acknowledgements for those messages.
- [ ] ACKs identify exact message type, original sequence and transaction ID; ACK must never grant transaction authority.
- [ ] Retries retransmit the identical encoded frame with the same session, sequence and payload. Do not allocate a new sequence for retry.
- [ ] UNO retains a small, explicit committed-transaction record after the one permitted mutation. If TX_COMMITTED delivery is not acknowledged, retry the report; do not re-debit balance or notes.
- [ ] ESP32 recognizes an identical duplicate TX_COMMITTED for the already-recorded pending transaction and replays the same acknowledgement idempotently. A conflicting duplicate, ID/amount/session mismatch, or impossible order revokes.
- [ ] Define how one side can safely retransmit an ACK without creating a sequence gap. No unrelated outbound frame may overtake a critical stop-and-wait exchange.
- [ ] Specify outcomes for lost REQUEST, PERMIT, DENY, TX_COMMITTED and ACK, including timeout and budget accounting.
- [ ] Extend `.github/protocol-v3-model.node.mjs` to simulate every loss point and prove the Uno mutation count never exceeds one and no unpermitted transaction mutates money.
- [ ] Update `.github/protocol-v3-handshake-contract.mjs`, `docs/SENTINEL_PROTOCOL.md`, and this checklist with the exact contract.

**Exit gate:** Each loss/duplication/mismatch scenario has a deterministic test. Cash state mutates at most once only after exact permit; guardian reconciliation completes only after the exact commit report; incomplete delivery ends in an explicit safe fault without repeating the mutation.

### P1 — Canonical schemas for every peer message

- [ ] Add a canonical schema table with required fields, order/canonical encoding, value/range bounds, unknown/duplicate-field behavior and legal peer state for every message type.
- [ ] Strictly validate ACK, STATUS, PERMIT, DENY and REVOKE payloads as well as current STATE, HEARTBEAT, REQUEST and EVENT handling.
- [ ] Reject empty/trailing fields, duplicate keys, duplicate separators, signed/overflowed numbers, unsupported reason codes and oversized data.
- [ ] Add golden wire vectors (including expected CRC) used by the contract tests and reference-model tests.
- [ ] Verify Uno and ESP32 frame limits, payload limits and output buffer sizes agree exactly.

**Exit gate:** every message family has positive and negative schema tests; both board compiles and contract CI pass.

### P2 — Deterministic state-machine and policy accounting

- [ ] Write a state × message transition table for startup, observing, authenticated, pending, denied, committed, locked and revoked conditions.
- [ ] Add tests for auth/state inconsistency, state-report order, second pending request, transaction replay, denial followed by a higher ID, pending timeout, reset while pending and revoke racing with a decision.
- [ ] Document exactly when guardian-side window budget is reserved, committed or released after policy denial, transport failure, transaction timeout, commit timeout and paired reset.
- [ ] Audit arithmetic/counter edges: sequence exhaustion, transaction-ID formatter maximum, commit/deny counters, cassette total multiplication, balances, and window remaining calculations.
- [ ] Confirm every policy/configuration command validates into temporary values and commits atomically only after all cross-field constraints pass.
- [ ] Audit PIN buffer clearing on every success, failure, timeout, cancel, reset and malformed input path; retain redacted diagnostics only.
- [ ] Review all loop work budgets and serial output for blocking behavior and verify the Uno can service timers and UART within protocol deadlines.
- [ ] Record Uno flash/SRAM output and assess realistic stack/buffer margin.

**Exit gate:** state-transition, accounting, overflow, secret-handling and static/resource checks pass before new protocol features are added.

### P3 — Embedded runtime resilience and reproducible fault model

- [ ] Extend deterministic model to model two endpoints and two serial directions, not only utility gates: independent sequences, session changes, response scheduling, timeouts, retry windows and latched fault state.
- [ ] Exercise drop, delay, duplicate, conflicting duplicate, corrupt CRC, truncation, concatenation, reordering, line overrun, RX pause, board reset and USB-monitor open/reopen.
- [ ] Add deterministic randomized/fixed-seed schedules with a key property: **no injected fault may produce unauthorized or duplicated virtual-cash mutation**.
- [ ] Review ESP32 watchdog/brownout policy before adding a watchdog; define reset consequences and verify no stale permit/session survives reboot.
- [ ] Keep logs bounded, redacted and structured; log fault codes and sequence/session metadata, never credential text.
- [ ] Pin down retry-exhaustion and wrap-safe timer semantics with tests at unsigned boundaries.

**Exit gate:** the reference model reaches READY or a named fault for every schedule; no mystery READY state and no unsafe transaction effects.

### P4 — Physical bench qualification (cannot be marked done by code/CI)

- [ ] Verify proper 5 V-to-3.3 V translation on Uno D9 TX → ESP32 GPIO16 RX. Never connect Uno 5 V TX directly to ESP32 GPIO; replace the marginal equal-resistor divider with a verified level-shifting solution.
- [ ] Confirm current wiring and common ground: Uno AltSoftSerial D8 RX / D9 TX; ESP32 UART2 GPIO16 RX / GPIO17 TX; peer 4800 8N1; USB monitors at 115200. Do not use digital pins as ground.
- [ ] Capture both USB logs and record the outcome of every clean paired start, with frame direction/type/session/sequence/CRC/retry metadata.
- [ ] Test Uno-first, ESP32-first, simultaneous/staggered start, paired reset, Uno-only reset, ESP32-only reset, USB console reconnect, interrupted wire and noisy startup line.
- [ ] Perform the plan's 100 clean startup/reconnect cycles.
- [ ] Perform the plan's 30-minute idle observation.
- [ ] After stable link only, provision fictional RAM-only account and cassette and test success, policy DENY, wrong PIN, lockout, malformed input, replay, duplicated/lost messages, timeout, pending reboot and revocation.
- [ ] Record outcomes PASS / FAIL / NOT RUN with logs. Never turn not-run physical items into a CI-based PASS.

**Exit gate:** actual physical logs support gates A–C. If any step fails, remain fail-closed and fix from the evidence.

### P5 — Product/release integration checks

- [ ] Reconcile all active documentation with V3.4 and then the final reliable-message protocol revision. Remove stale baud/pin/software-serial references.
- [ ] Ensure the desktop/USB command path is clearly observation/configuration, not attestation; do not display a completed HIL withdrawal without exact board/guardian reconciliation.
- [ ] Keep software-only baseline clearly separate from hardware mode. No silent HIL-to-simulation fallback.
- [ ] Run domain/unit tests, renderer build, native serial-manager tests, firmware contract tests, host protocol-model tests, Uno compile, ESP32 compile and macOS/Windows packaging workflow on the same commit.
- [ ] Publish the residual checklist alongside evidence and record exact tested firmware/revision. Do not claim production ATM security or malware detection beyond the evidence.

## 3. Current stopping point

At the audited baseline, the V3.4 paired firmware compiles, current source-contract CI and desktop test CI are green, STATUS is correlated to the exact heartbeat, and PERMIT/DENY bind the exact pending ID and amount. The protocol reference model is present. **This does not mean the two source plans are complete.** The highest-risk remaining code item is the absence of a general reliable-message ACK/retry/dedup lifecycle for transaction-critical frames, followed by exhaustive schemas/state-machine tests. Hardware qualification remains NOT RUN until the actual boards are tested.
