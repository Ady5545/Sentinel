# SENTINEL Four-Quarter Implementation Plan

**Created:** 26 October 2026  
**Repository:** `Ady5545/Sentinel`  
**Working branch:** `feat/implementation-quarter-2-2026-10-26`  
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
- [x] Preserve per-connection session IDs and port-role ownership. Reconnect, disconnect, write errors, malformed/overlong input and board boot records invalidate readiness and unresolved HIL transaction evidence.
- [x] Add an 8-second HIL reconciliation timeout that moves unresolved transactions into a visible mismatch/reconciliation state without mutating desktop cash.
- [x] Add serial-manager tests for fragmented/concatenated lines, CRLF, overlong/malformed input, unplug, write failure, double-connect, role/port collisions, stale readiness, structured command validation and sensitive-data redaction.
- [x] Keep the software-only simulation usable offline and separate from protected HIL; connection alone never grants readiness.

**Quarter 2 exit gate:** The main-process bridge accepts only structured allowlisted commands; protected commands are blocked without fresh paired readiness; framing/session failures invalidate readiness; and sensitive command/serial text is redacted before renderer diagnostics. These automated checks and the renderer build passed on the corrected parser/test revision in [run 40372831708](https://github.com/Ady5545/Sentinel/actions/runs/40372831708). A source-to-firmware audit also corrected the guardian reconciliation marker to the actual ESP32 output, `[RECONCILE] Matching controller-reported virtual commit id=...;amount=...`. Physical paired-board behavior remains separately NOT VERIFIED.

## Quarter 3 — End-to-end HIL and research evidence (50–75%)

- Route operator/customer setup and withdrawal actions through the typed Uno adapter only in HIL mode.
- Correlate request, decision, Uno commit, ESP32 commit acknowledgement and desktop shadow update by exact session/transaction ID/amount.
- Make the desktop virtual-cash gate idempotent; unresolved or mismatched evidence freezes further HIL withdrawals.
- Connect the terminal, Sentinel console, experiment lab, journal and hardware bridge to one explicit mode/session coordinator.
- Add repeatable, versioned synthetic scenarios, provenance labels, immutable run records, safe PIN redaction, JSON/CSV export and software-only replay.

**Quarter 3 exit gate:** A supported HIL transaction either reconciles end-to-end exactly once or visibly ends denied/fault/reconciliation-required with no desktop virtual cash mutation.

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
| Quarter 2 host bridge/readiness | **Implemented and automated CI passed** | `electron/serial-manager.cjs`, `electron/main.cjs`, `electron/preload.cjs`, `src/vite-env.d.ts`, `src/App.tsx`; includes parsing the current firmware `[RECONCILE]` output |
| Quarter 2 test coverage | **Passed on corrected source/test revision** | `electron/serial-manager.node-test.cjs`, `src/core/hil-evidence.test.ts`; [latest workflow run 40372831708](https://github.com/Ady5545/Sentinel/actions/runs/40372831708) passed |
| Quarter 2 overall | **IMPLEMENTED — automated CI PASS** | Corrected bridge, tests and parser/firmware-output alignment passed on `d22cfce9e5a8f6c39953b7b5c6744c38c9a36a12` in [run 40372831708](https://github.com/Ady5545/Sentinel/actions/runs/40372831708). The later plan-ledger-only commit triggers its own verification run. |
| Physical UART qualification | **NOT VERIFIED** | Requires actual Uno + ESP32 paired logs; code changes cannot establish it |

Quarter 1's open audit remains explicitly tracked and must not be represented as complete. No Quarter 3 work should begin until Quarter 2's exit gate is satisfied and reviewed.
