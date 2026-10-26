# SENTINEL Four-Quarter Implementation Plan

**Created:** 26 October 2026  
**Repository:** `Ady5545/Sentinel`  
**Working branch:** `feat/implementation-quarter-3-2026-10-27`  
**Rule:** Deliver the remaining work in four approximately equal 25% quarters. Existing implemented work is preserved; only audited gaps are changed. By explicit user direction, Quarter 2 began while Quarter 1's separate audit remains open; this does not mark Quarter 1 complete. Quarter 3 must not begin until Quarter 2's exit gate is verified.

## Quarter 1 — Authority and protocol reliability (0–25%)

**Goal:** Establish fail-closed transaction authority and a testable reliable peer-message contract before expanding integration.

- [x] Audit current `main` implementation and distinguish code/CI evidence from physical hardware evidence.
- [x] Tighten the software virtual-dispenser permit window: a permit cannot be used before its issue time, at/after its expiry, or with an invalid time window.
- [x] Bind every simulated permit to the originating run ID so a permit from a prior/reset run cannot authorize a later transaction.
- [x] Add regression tests for future-issued, mismatched transaction/amount, exact-expiry, and cross-run permits; every denial must leave account balance, cassette cash, and dispensed total unchanged.
- [ ] Audit all software-gate edge cases: missing/stale/wrong-session/wrong-transaction/wrong-amount/replayed/revoked decisions, reset invalidation, duplicate actions, and money-state invariants.
- [x] Audit the existing TX_COMMITTED/ACK implementation: the Uno already retains and retries the same commit event sequence, while the ESP32 stores and replays the matching ACK for an exact duplicate event. Do not rewrite these existing paths without evidence.
- [x] Add deterministic model coverage for a lost commit event, a lost ACK, idempotent duplicate commit reports, and retry exhaustion; assert the controller mutation count remains one.
- [ ] Finish the critical-message contract audit for REQUEST, PERMIT, DENY, TX_COMMITTED and ACK, including same-sequence retries, idempotent duplicate handling, and fail-closed timeout outcomes.
- [x] Add source-contract assertions that the Uno uses bounded retries of the original TX_COMMITTED sequence and the ESP32 replays the original ACK without recounting a duplicate commit.
- [ ] Compare the model against both actual firmware implementations and complete the remaining source/contract edge audit; model tests alone do not prove embedded behavior.
- [ ] Re-run desktop/domain tests, Uno build, ESP32 build and protocol contract tests on this quarter's exact commit. A stale Vitest discovery issue was found: repository `.agent/**.test.cjs` files use Node's test runner, so the desktop Vitest script is now scoped to `src` while Electron's Node tests remain in `check:main`.

**Quarter 1 exit gate:** Automated tests prove the virtual gate requires a current explicit transaction-specific permit and protocol retries never repeat a money mutation. Hardware liveness is reported separately and remains **NOT VERIFIED** until paired-board logs prove it.

## Quarter 2 — Host bridge and explicit readiness (25–50%)

- [x] Replace renderer-to-main raw command strings with structured `{ name, args }` requests; the main process canonicalizes and validates each role-specific command before serial write.
- [x] Add a narrow board-event parser for boot, link, HEALTHY/OBSERVING, revoke, ATM_EVENT, permit, denial and commit-reconciliation records; redact sensitive serial text in the main process before it reaches renderer state/logging.
- [x] Add an explicit serial-readiness snapshot and a host-side 3.5-second freshness gate. Protected commands fail closed unless both assigned board roles are connected and report fresh HEALTHY/OBSERVING states.
- [x] Preserve per-connection session IDs and port-role ownership. Reconnect, disconnect, write errors, malformed/non-ASCII/overlong input and board boot records invalidate readiness and unresolved HIL transaction evidence.
- [x] Latch HIL MISMATCH/REVOKED clearance until both boards have emitted new boot/session-start records after the fault and fresh paired readiness is re-established; fresh status alone cannot clear the fault.
- [x] Add an 8-second HIL reconciliation timeout that moves unresolved transactions into a visible mismatch/reconciliation state without mutating desktop cash.
- [x] Add serial-manager tests for fragmented/concatenated lines, CRLF, actual firmware permit/reconcile output, overlong/malformed/non-ASCII input, unplug, write failure, double-connect, role/port collisions, stale readiness, structured command validation and sensitive-data redaction.
- [x] Add domain tests that prove a HIL fault cannot be cleared by readiness alone; both boards must reboot after the fault before the paired-ready state can clear it.
- [x] Keep the software-only simulation usable offline and separate from protected HIL; connection alone never grants readiness.

**Quarter 2 exit gate:** The main-process bridge accepts only structured allowlisted commands; protected commands are blocked without fresh paired readiness; framing/session failures invalidate readiness; and sensitive command/serial text is redacted before renderer diagnostics. These automated checks and the renderer build passed on [run 40373668284](https://github.com/Ady5545/Sentinel/actions/runs/40373668284). Source-to-firmware audit corrected the guardian reconciliation parser to the actual ESP32 output, `[RECONCILE] Matching controller-reported virtual commit id=...;amount=...`. Fault clearance now requires both board boot/session-start records after the fault plus fresh paired readiness. Physical paired-board behavior remains separately NOT VERIFIED.

## Quarter 3 — End-to-end HIL and research evidence (50–75%)

- [x] Route operator/customer setup and withdrawal actions through typed Uno commands only in active HIL mode; the generic free-text console blocks setup/customer/withdrawal commands and the typed adapter rechecks active mode plus fresh paired readiness.
- [x] Add a session coordinator that correlates request, permit, Uno commit, guardian ACK/reconciliation and the shadow-commit count by exact board session, transaction ID and amount.
- [x] Make coordinator commit correlation exactly-once; duplicate commit/ACK evidence is idempotent, reused transaction IDs and mismatched evidence freeze the run. Integrate the existing desktop virtual-cash shadow so it mutates only after full correlated reconciliation and quarantines on transport/reset/fault.
- [x] Connect app-level terminal events, Sentinel evidence, experiment lab, journal/export, and hardware observations to one append-only versioned research run record.
- [x] Add versioned synthetic scenarios for a clean withdrawal, amount mismatch and denial; replay is isolated from the serial bridge and marks board-like events SYNTHETIC_FIXTURE.
- [x] Add immutable event records, safe PIN redaction, versioned JSON run records and CSV evidence export with provenance labels.
- [ ] Complete source-to-UI audit for all HIL customer/setup commands and ensure all active/frozen states are visible consistently across modules.

**Quarter 3 exit gate:** A supported HIL transaction either reconciles end-to-end exactly once or visibly ends denied/fault/reconciliation-required with no desktop virtual cash mutation. The first implementation slice passes automated CI on [run 40381930063](https://github.com/Ady5545/Sentinel/actions/runs/40381930063), commit `4be8ac42b615f52d32cba9a177f22c59f299cf50`. Final source-to-UI and end-to-end HIL audit remains open. Physical paired-board validation remains separate.

## Quarter 4 — Qualification, packaging and demonstration (75–100%)

- Run the complete automated suite on one pinned commit and verify macOS Apple Silicon and Windows x64 artifacts.
- Complete the physical wire/logic-level check, paired startup/reconnect matrix, 100 clean starts, 30-minute idle observation, and allowed/denied transaction cases with redacted paired logs.
- Mark every physical test PASS / FAIL / NOT RUN; do not infer hardware success from compilation or simulated tests.
- Validate offline installed-app behavior, source/artifact checksums and operator flows.
- Prepare a truthful demonstration and report, clearly distinguishing software fixtures, board-reported events and protocol-validated evidence.

**Quarter 4 exit gate:** The release package and demo trace to the exact tested commit, with physical limitations and any unrun checks explicitly stated.

## Progress ledger

| Work item | Status | Evidence |
|---|---|---|
| Latest repository baseline audited | Done | `main` tree and current source files inspected before changes |
| Permit time-window and run-binding validation tightened | Implemented on this branch; latest CI pending | `src/core/atm-engine.ts` — permits carry the originating `runId` and must be current, unexpired, and transaction/amount matched |
| Five permit-boundary/run-binding regressions added | Implemented on this branch; latest CI pending | `src/core/atm-engine.test.ts` |
| Commit delivery fault-model cases added | Implemented on this branch; CI pending | `.github/protocol-v3-model.node.mjs` — lost event, lost ACK, exact retry identity and retry exhaustion |
| Firmware commit retry/ACK source contract | Added on this branch; CI pending | `.github/protocol-v3-handshake-contract.mjs` — bounded retries, identical sequence and idempotent ACK replay |
| Vitest discovery issue | Fixed on this branch; CI pending | `package.json` now scopes Vitest to `src`, avoiding Node-test files under `.agent` being treated as Vitest suites |
| Quarter 1 overall | **IN PROGRESS** | Remaining protocol delivery, fault-model and full test gates above; automated workflows passed on Q1 implementation commit `9cbebcdd41d00e33586706363876270d0b3ab3d7` in [desktop CI](https://github.com/Ady5545/Sentinel/actions/runs/40370144382) and [firmware CI](https://github.com/Ady5545/Sentinel/actions/runs/40370144343) |
| Quarter 2 host bridge/readiness | **Implemented and automated CI passed** | `electron/serial-manager.cjs`, `electron/main.cjs`, `electron/preload.cjs`, `src/vite-env.d.ts`, `src/App.tsx`; includes parsing the current firmware `[RECONCILE]` output, rejecting non-ASCII framing, and requiring paired reboot before clearing HIL faults |
| Quarter 2 test coverage | **Passed on corrected source/test revision** | `electron/serial-manager.node-test.cjs`, `src/core/hil-evidence.test.ts`; [latest workflow run 40373668284](https://github.com/Ady5545/Sentinel/actions/runs/40373668284) passed |
| Quarter 2 overall | **IMPLEMENTED — automated CI PASS** | Bridge hardening, typed parser, paired-reset fault latch, non-ASCII rejection, tests and renderer build passed on `b1698dc038258932723909711407afe3e284a0cc` in [run 40373835953](https://github.com/Ady5545/Sentinel/actions/runs/40373835953). Physical paired-board behavior remains NOT VERIFIED. |
| Physical UART qualification | **NOT VERIFIED** | Requires actual Uno + ESP32 paired logs; code changes cannot establish it |
| Quarter 3 coordinator/replay | **FIRST SLICE IMPLEMENTED — automated CI PASS** | `src/core/research-session.ts`, `src/core/research-session.test.ts`, app integration in `src/App.tsx`; immutable versioned run snapshots, typed HIL command gating, synthetic-only replay and provenance-labelled JSON/CSV export passed in [run 40381930063](https://github.com/Ady5545/Sentinel/actions/runs/40381930063) |
| Quarter 3 overall | **IN PROGRESS** | First slice passes automated CI. The actual desktop virtual-cash shadow now updates only through `reconcileHilShadowCommit` after exact permit/Uno commit/guardian reconciliation, and is quarantined on reset or transport loss. Remaining work: end-to-end UI/session audit and physical HIL qualification (not established by CI). |

Quarter 1's open audit remains explicitly tracked and must not be represented as complete. Quarter 2's automated exit gate was satisfied on its exact branch head by [run 40373835953](https://github.com/Ady5545/Sentinel/actions/runs/40373835953); Quarter 3 implementation is now underway by user direction. Physical UART/HIL behavior remains NOT VERIFIED.
