# SENTINEL Four-Quarter Implementation Plan

**Created:** 26 October 2026  
**Repository:** `Ady5545/Sentinel`  
**Working branch:** `feat/implementation-quarter-1-2026-10-26`  
**Rule:** Deliver the remaining work in four approximately equal 25% quarters. Each quarter must be reviewed and verified before the next begins. Existing implemented work is preserved; only audited gaps are changed.

## Quarter 1 — Authority and protocol reliability (0–25%)

**Goal:** Establish fail-closed transaction authority and a testable reliable peer-message contract before expanding integration.

- [x] Audit current `main` implementation and distinguish code/CI evidence from physical hardware evidence.
- [x] Tighten the software virtual-dispenser permit window: a permit cannot be used before its issue time, at/after its expiry, or with an invalid time window.
- [x] Add regression tests for future-issued, mismatched transaction/amount, and exact-expiry permits; every denial must leave account balance, cassette cash, and dispensed total unchanged.
- [ ] Audit all software-gate edge cases: missing/stale/wrong-session/wrong-transaction/wrong-amount/replayed/revoked decisions, reset invalidation, duplicate actions, and money-state invariants.
- [ ] Define the critical peer-message delivery contract for REQUEST, PERMIT, DENY, TX_COMMITTED and ACK, including same-sequence retries, idempotent duplicate handling, and fail-closed timeout outcomes.
- [ ] Implement and test the reliable commit-report lifecycle without ever applying the Uno balance/cassette mutation twice.
- [ ] Extend deterministic protocol tests to prove drops, duplicates and timeouts cannot create an unauthorized or duplicate transaction.
- [ ] Re-run desktop/domain tests, Uno build, ESP32 build and protocol contract tests on this quarter's exact commit.

**Quarter 1 exit gate:** Automated tests prove the virtual gate requires a current explicit transaction-specific permit and protocol retries never repeat a money mutation. Hardware liveness is reported separately and remains **NOT VERIFIED** until paired-board logs prove it.

## Quarter 2 — Host bridge and explicit readiness (25–50%)

- Add a bounded, typed, allowlisted serial-write API in Electron main; do not expose arbitrary renderer IPC or raw serial writes.
- Add typed board-event parsing and structured response correlation with redaction before renderer state/logging.
- Implement device-role assignment, port ownership protection, connection/session/readiness states, reset invalidation and timeout/reconciliation states.
- Add serial-manager tests for fragmented/concatenated lines, CRLF, overlong/malformed lines, unplug, write failure, double-connect and port-role collisions.
- Keep the software-only simulation usable offline and separate from protected HIL; never silently fall back between modes.

**Quarter 2 exit gate:** The desktop can safely observe and issue only documented commands, and connection alone never grants HIL readiness.

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
| Permit time-window validation tightened | Implemented on this branch; CI pending | `src/core/atm-engine.ts` |
| Three permit-boundary regressions added | Implemented on this branch; CI pending | `src/core/atm-engine.test.ts` |
| Quarter 1 overall | **IN PROGRESS** | Remaining protocol delivery, fault-model and full test gates above |
| Physical UART qualification | **NOT VERIFIED** | Requires actual Uno + ESP32 paired logs; code changes cannot establish it |

No later quarter should begin until Quarter 1's exit gate is satisfied and reviewed.
