# SENTINEL Firmware Engineering Plan — V3 Reliability and Hardening

**Status:** Hardening backlog for the current V3 firmware; CI and physical bench evidence remain required  
**Baseline:** Current V3 firmware on main; verify main HEAD before every change  
**Hardware constraint:** one Arduino Uno + one ESP32 DevKit; current peer UART is Uno AltSoftSerial D8 RX / D9 TX and ESP32 UART2 GPIO16 RX / GPIO17 TX at 4800 8N1; common ground and proper level shifting are required  
**Release rule:** a successful compile is necessary, never proof of successful hardware integration

---

## 1. Mission and engineering standard

Turn the two sketches from a feature-rich demonstration into a deliberately designed, testable, recoverable embedded system. The highest priorities are predictable state transitions, reliable communication, transaction idempotency, observable failure, bounded resource use, and a testable fail-closed authority boundary.

“More secure” does not mean locking on every harmless byte error, and “more reliable” does not mean accepting unexplained sequence gaps. SENTINEL must distinguish recoverable transport faults from protocol/state violations, retry safely where the protocol permits it, and refuse every action whose authorization cannot be established.

Implement this plan in small reviewable phases. Do not replace both firmware files in one giant rewrite. Each phase should leave a buildable state and add tests before expanding behavior.

### Non-negotiable invariants

1. **No guardian, no permit.** A missing, stale, revoked, or inconsistent guardian must never authorize a virtual withdrawal.
2. **The Uno cannot grant itself guardian authority.** Its local validation is necessary but insufficient for a withdrawal.
3. **The ESP32 is the independent policy observer/guardian, not a transaction-auditing product.** It checks protocol integrity, reported state transitions, liveness, policy evidence, and the current permit/commit lifecycle. Matching commit evidence is safety reconciliation for one pending permit, not a general audit engine.
4. **Exactly-once state effect.** One accepted transaction ID may cause at most one virtual balance/cash mutation, including when messages are duplicated or acknowledgements are lost.
5. **No silent protocol recovery.** A peer restart, unexplained session change, conflicting duplicate, unsafe state transition, or exhausted exchange requires explicit fail-closed handling and a clean paired restart/recommission path.
6. **Do not weaken sequence/replay rules to hide the current bug.** Design safe retransmission and idempotency first; never simply skip sequence values or accept stale permits.
7. **No authority shortcuts.** ACK, HEARTBEAT, STATE, STATUS, logs, and self-reported firmware identity are not transaction permits.
8. **No secret leakage.** PINs and credential-bearing buffers must not be printed in logs, diagnostics, fixtures, or crash output. Use only fictional test data.
9. **Hardware stays within the available two-board setup.** Use one Uno plus one ESP32; the Uno peer UART uses AltSoftSerial RX D8 / TX D9, the ESP32 uses UART2 RX GPIO16 / TX GPIO17, peer baud is 4800 8N1, USB diagnostics remain 115200, and grounds must be common. Use verified 5 V-to-3.3 V level shifting on Uno TX; do not connect the Uno's 5 V TX directly to an ESP32 GPIO.
10. **Claims match evidence.** This remains a classroom prototype without a secure element, protected key, trusted PIN-entry device, verified secure boot, physical dispenser interlock, or cryptographic peer authentication. Do not claim production ATM security, arbitrary malware detection, or resistance to an attacker able to forge peer frames.

## 2. Current baseline and incident analysis

### Current responsibilities

| Component | Current responsibility | Engineering priority |
|---|---|---|
| Arduino Uno | Fictional RAM-only accounts/PINs, customer state machine, withdrawal validation and denomination planning, outbound protocol frames, waits for matching guardian decision before virtual balance/note mutation | Keep critical paths bounded and make authority/transaction invariants explicit |
| ESP32 | Validates framed UART messages, checks reported state/heartbeat/transaction policy, responds with one-shot PERMIT or DENY, latches REVOKE on detected violations | Make startup, receive errors, retries, state checks and permit lifecycle deterministic |
| Desktop simulator (future integration) | UI and virtual-cash presentation | Independently enforce its own authorization gate; this firmware plan does not implement the desktop app |

### Confirmed code facts behind the latest UART-status failure

- Current V3 firmware uses 4800 baud, 8N1 on the peer link; HELLO retries reuse sequence 1 and the handshake is explicitly completed by a final ACK.
- The latest paired-board logs show handshake completion and a valid Uno heartbeat arriving at the ESP32; the ESP32 schedules/sends HEALTHY STATUS, while the Uno does not log an accepted HEALTHY status. The current diagnostic patch adds Uno receive-byte/complete-line counters and flushes the ESP32 UART after STATUS transmit.
- An ESP32 `sendFrame_return=true` means the UART write was accepted locally; it does not prove the Uno received a valid frame.
- The current V3.3 transport uses AltSoftSerial on fixed D8 RX / D9 TX; the response/retry schedule is bounded. Receiver-side byte/line counts are needed to distinguish no signal, incomplete framing, and parser rejection.
- The equal 2.2 kΩ / 2.2 kΩ divider previously described gives roughly 2.5 V at ESP32 RX from a 5 V Uno TX, leaving almost no margin above the ESP32's specified minimum HIGH threshold. It is not a robust level-shifting design; a proper level shifter or correctly calculated divider is preferred.

**Not yet proven:** the exact cause is not established from logs alone. UART timing and input signal margin are plausible contributors; only the next paired-board test can confirm whether this firmware and the actual electrical link are stable.

### First engineering task

Reproduce the startup sequence in a deterministic protocol test and instrument frame metadata on both boards. Capture direction, type, sequence, session, CRC validity, receive/ack/retry result and time delta. Never log PINs or customer secrets. Determine whether the failure is a missed frame, unexpected sequence advance, reset timing, parser rejection, or another state-machine path before changing policy semantics.

## 3. Target architecture

Separate four concerns, even if AVR memory constraints mean some functions remain in the current sketch files:

1. **Transport/framing:** bounded line receive, line overflow handling, CRC, exact schema parsing and transmit scheduling.
2. **Session/protocol engine:** session negotiation, per-direction sequence state, message acknowledgement/retry, duplicate handling, peer liveness and protocol fault classification.
3. **Domain state machines:** Uno ATM/customer/withdrawal state machine; ESP32 guardian/policy state machine.
4. **Diagnostics/test seams:** structured redacted events and deterministic seams for tests, separate from authority decisions.

Consider a shared portable header/module for constants, frame rules, CRC vectors and field validation. Do not force a large abstraction onto the Uno if it raises SRAM/flash usage or obscures timing. Prefer simple static bounded C/C++ and explicit state enums over dynamic allocation, exceptions, STL containers or an elaborate framework.

### Authority boundaries

- **Uno business authority:** owns fictional account balance and virtual note inventory; checks account/session/PIN, amount, stock, balance, local limits and pending transaction conditions.
- **ESP32 guardian authority:** independently checks received protocol session, allowed reported state, liveness, request format, monotonic transaction identity within a session, configured guardian-side limits, and the one pending permit/commit lifecycle. It may issue one transaction-correlated permit or denial, or latch revocation.
- **Desktop authority:** when implemented, independently checks permit/decision state and blocks virtual cash animation/account mutation on timeout, denial, revocation, malformed serial data, stale state or disconnection. It must not infer permission from a green badge or console string.

The ESP32 only sees information reported by the Uno. A valid CRC, monotonic counter, reported PIN success and reported state do not prove that the Uno firmware is genuine or uncompromised.

## 4. Communication protocol V3 design

The protocol redesign is the first code milestone because transactions cannot be trustworthy until message exchange is deterministic. Update the protocol specification and both firmware implementations together in one reviewable migration; never leave one board running V2 while the other expects V3.

### 4.1 Transport contract

- Use the documented current peer link: Uno AltSoftSerial RX D8 / TX D9, ESP32 UART2 RX GPIO16 / TX GPIO17, 4800 baud 8N1. Keep the application-level stop-and-wait schedule even though AltSoftSerial improves timing.
- Maintain newline-delimited ASCII framing and strict maximum frame/payload lengths. Define one authoritative maximum and verify every serializer fits it before transmitting bytes.
- Keep CRC-16/CCITT-FALSE with published test vectors unless a separately reviewed change justifies another checksum. CRC detects accidental corruption, not forgery.
- Separate a **bad/incomplete frame** from a **well-formed but invalid protocol command**. Never process a partial frame. A failed CRC cannot change state. A transport error may be retried within a bounded policy; a validly framed wrong-session command, conflicting duplicate, unknown state-changing message or illegal transition remains a security fault.
- Drain receive buffers in bounded work per loop. Do not let continuous traffic starve timeout checks; do not silently discard buffered bytes either. Measure on hardware before tuning.
- Define behavior for CRLF, empty lines, non-ASCII bytes, overlong frames, missing newline, concatenated frames, malformed hexadecimal CRC and zero-length payloads.

### 4.2 Session and handshake state machine

Implement explicit states rather than letting one string imply a complete link:

- BOOT → WAIT_PEER → HELLO_SENT/RECEIVED → NEGOTIATING → READY → OBSERVING.
- FAULT_LATCHED is terminal until the documented paired-reset/recommission sequence.
- Define which board initiates; what each side is waiting for; and the exact exchange that completes negotiation. No transaction or healthy status is allowed before both sides confirm the same session and protocol revision.
- A retry of the same handshake operation reuses the same session, message identity and sequence. A repeated identical handshake frame is an **idempotent retry**, not a new command. The receiver may repeat the matching acknowledgement but must not apply the side effect twice.
- A duplicate sequence carrying different content is a protocol fault. An unexpected session change mid-session is a fault. A reboot during an established session must not silently attach to the old one.
- Set finite retry counts and deadlines. Exhaustion reports a specific handshake/link fault and grants no permit. Do not retry forever or hide timeouts by widening deadlines indefinitely.
- Specify startup permutations: ESP32 first, Uno first, simultaneous power-up, USB monitor opening/reopening, reset of either board alone, paired reset, noisy/partial initial frame and delayed first frame.

### 4.3 Sequence, acknowledgement and idempotency

Replace the current implicit “every frame arrives exactly once” assumption with a documented, testable reliability policy.

- Use per-direction sequence space and one defined rule for when a sequence number is allocated.
- For protocol-critical state-changing messages, use bounded stop-and-wait acknowledgement/retransmission (or an equivalent design proven for SoftwareSerial). Keep at most one unacknowledged reliable message per direction; specify turn-taking so the boards do not unexpectedly begin bursts simultaneously.
- Retransmit the **identical original frame** with the same sequence/message ID. Do not allocate a fresh sequence number for a retransmission.
- A receiver remembers the last accepted message identity and outcome required for deduplication. An exact duplicate is acknowledged again but never re-applied; a conflicting duplicate or unexplained gap is not silently accepted.
- ACK must identify the exact message acknowledged (sequence plus type/message ID). ACK never grants transaction authority. Specify NACK/timeout behavior and whether a corrupted frame is ignored while the sender retries.
- A sequence gap may trigger recovery only when the protocol can identify the missing outstanding message and safely recover it. Otherwise it remains a fault. Do not “fix” this bug by accepting arbitrary gaps.
- Define sequence exhaustion/wrap. Either establish a new session well before wrap or use a rigorously tested modular comparison; never let overflow turn into a permanent unexplained lock.
- Keep parsing independent of state effects: validate format, version, session, sequence/duplicate status, type schema and state preconditions before mutating controller or guardian state.

### 4.4 Message contract

The V3 specification must define every message's direction, exact fields, allowed states, response, retry behavior, deadline and idempotency key. Review at least these semantic messages:

- Session start, session acknowledgement and READY/negotiation confirmation.
- Controller state snapshot and heartbeat/liveness exchange.
- Guardian liveness acknowledgement/status bound to the specific heartbeat/message acknowledged.
- Transaction REQUEST, PERMIT, DENY, COMMIT reconciliation and REVOKE.
- Diagnostic/configuration messages that are explicitly non-authorizing.
- ACK/NACK used for reliable-message handling.

Do not overload a generic STATUS|HEALTHY string with multiple meanings. Healthy link is not a permit; a permit is not proof a commit occurred; a commit report is not permission for a second mutation.

### 4.5 Payload schemas

- Write a schema table for every message: required fields, allowed values, maximum lengths, range checks, duplicate-field behavior, unknown-field behavior and cross-field invariants.
- Reject missing fields, duplicate keys, empty prohibited values, trailing junk, integer overflow, signed/negative numbers, invalid characters and out-of-range values.
- Replace fragile substring event inspection with typed event codes and parsed fields. Use exact identifiers such as PIN_FAIL, PIN_OK and TX_COMMITTED, not strstr() over arbitrary text.
- Keep payload parsing bounded and allocation-free. Ensure every output is NUL-terminated and every copy checks destination length.
- Decide whether unknown noncritical diagnostic fields can be ignored; never ignore a field that affects authorization or transaction semantics.

## 5. Transaction correctness and fail-closed behavior

Treat a withdrawal as a stateful transaction, not an isolated permit string.

### Required lifecycle

1. **Validate locally:** Uno verifies customer session, balance, amount multiple, controller limits, denomination plan and current guardian freshness.
2. **Create one pending transaction:** allocate a unique transaction ID within the session; record amount, plan, state-entry timestamp and deadline. Do not mutate account/cash state here.
3. **Send REQUEST reliably:** keep exact request identity and retry state. A resend is the same request, not a new withdrawal.
4. **Guardian validates independently:** require ready session, fresh heartbeat, permitted state/authentication flag, increasing transaction ID, positive allowed amount, no other pending permit, and guardian policy headroom.
5. **Issue one correlated decision:** PERMIT must name the exact pending transaction and bind to request session/message identity and amount. DENY must identify the same request and a typed reason. Healthy status never substitutes for either.
6. **Uno validates before commit:** permit freshness, matching session, matching transaction ID and amount, deadline, no latched revoke, and outstanding pending withdrawal are all required. Recheck balance/cash preconditions.
7. **Commit once:** perform a single bounded mutation of account balance, denomination inventory, budget counters and commit counter. Check arithmetic cannot wrap. Clear pending state carefully and emit a typed commit event.
8. **Reconcile:** guardian accepts only the matching commit for its pending permit. A duplicate commit must not increment its counter twice. Wrong transaction, amount, session or state triggers revocation; missing commit by deadline triggers revocation.
9. **Define ordering:** specify mutation, state publication and commit-message ordering so message loss/retry cannot cause a second mutation or false mismatch.
10. **Deny/timeout/revoke:** no balance/cash mutation. Specify when guardian-side budget is reserved, committed or released for denials, timeouts and revocation. A timed-out transaction cannot be retried as a new transaction to bypass controls.

### Decisions that must be explicit

- **Exactly-once mutation versus at-least-once delivery:** transport may retry; domain mutations must deduplicate by transaction identity.
- **Lost PERMIT / DENY / COMMIT / ACK:** specify the next action for every case and verify both sides converge safely.
- **Transaction ID lifecycle:** monotonic within a session, no reuse after denial, no ambiguous wrap. A session ID is not cryptographic freshness.
- **Guardian budget accounting:** amount reservation/commit/release rules must prevent retries evading a window limit or consuming the same amount twice by accident.
- **Commit identity:** accept only the intended explicit transaction event. Do not allow unrelated event payloads with an id field to satisfy reconciliation.
- **State snapshots:** define ordering when state publication is delayed or repeated; heartbeats and state reports must agree.
- **Scope:** guardian tracks protocol/policy state and commit reconciliation for the outstanding permit; it must not become an unconstrained event collector or infer compromise from unrelated volume telemetry.

## 6. Uno firmware workstream

### 6.1 State-transition discipline

- Centralize state changes through one transition function with allowed transitions and explicit entry/exit effects.
- Prevent paths that skip guardian-lock checks, pending transaction cleanup or state publication.
- Assert/test invariants: active account is valid only in authenticated/pending states; pending amount and note plan exist only in WITHDRAW_PENDING; no commit is possible after guardian revoke; no withdrawal mutates cash before valid permit.
- Make transition publication explicit and avoid duplicate STATE bursts on the same logical change.
- Define normal LOCKED recovery separately from GUARDIAN_LOCKED. Ordinary PIN lockout may expire; guardian revocation may not auto-clear.

### 6.2 Transaction/account path

- Audit every uint32_t balance, amount, total-note, window, transaction-counter and committed-count operation for overflow before addition/multiplication/subtraction.
- Test the denomination planner against an exhaustive small-inventory reference and randomized bounded cases. The plan must sum to the requested amount and never exceed available notes.
- Clear PINs and credential-bearing command buffers on every path, including parser errors and early returns. Never echo a PIN or include it in a diagnostic.
- Validate command field count before dispatch; centralize numeric parsing/ranges. Reject unknown/extra fields consistently.
- Keep accounts, PINs, balances, cash stock, policies, lockout state and journal clearly RAM-only. Reset returns to safe uncommissioned state; never imply persistence.
- Audit timers using unsigned elapsed-time arithmetic. Test near millis() wrap and near maximum supported counters.
- Preserve the fictional-only model. No pin or signal is connected to a real cash mechanism.

### 6.3 Embedded resource discipline

- Track flash, static SRAM and worst-case stack/local-buffer use in CI or reproducible release notes. Uno SRAM is only 2 KB.
- Keep constant strings in PROGMEM where appropriate; avoid accidental RAM copies and large stack arrays.
- Keep frame/USB buffers single-purpose, statically bounded and documented. Measure stack depth in the longest receive/parse/command path.
- Avoid blocking delay() calls in the safety-critical loop. Define maximum expected work per loop and keep liveness/timeout checks responsive under sustained serial traffic.
- Every send path must report failure to its caller; output overflow/truncated frame must never look like a successful protocol action.
- Audit format strings, integer specifiers and buffer sizes for AVR/ESP32 portability.

## 7. ESP32 guardian workstream

### 7.1 Explicit guardian states

Replace implicit combinations of booleans where feasible with named protocol and authority states, while keeping separate flags for genuinely independent facts. Define at least startup/waiting, session negotiation, ready/observing, request pending/permit awaiting commit, denied request completed, and fault/revoke latched.

Specify allowed transitions and prohibit PERMIT unless all preconditions are true at the instant of issue. A previous healthy heartbeat cannot bypass later session, state, policy or pending-transaction checks.

### 7.2 Independent policy checks

- Validate exact state names and allowed transitions, auth/state consistency, heartbeat freshness, monotonic transaction IDs, amount format, amount ceiling and rolling-window budget.
- Validate fields and ranges before writing guardian state.
- Define handling for repeated/inconsistent state reports. A heartbeat must not silently mask a missed required state transition.
- Distinguish policy from observation. Say “reported by controller” when evidence is controller-originated rather than independently measured.
- Test PIN-failure window reset/rollover. A labelled simulated fixture is not evidence of a real attacker.
- Permit only one pending transaction. A second request before reconciliation must never produce another permit.

### 7.3 Permit and revoke semantics

- A permit authorizes one transaction only, never a general healthy lease.
- Revoke is latched; ordinary messages cannot clear it. Define which diagnostics are accepted afterward and whether REVOKE is retried.
- If a REVOKE frame is lost, the Uno must still fail closed on missing guardian freshness/deadline. Safety must not depend on one one-shot REVOKE reaching the peer.
- Make status distinguish session readiness, heartbeat age, last receive error, pending transaction, revoke reason code and commit observation count. Status must not imply a physical interlock or certain malware detection.
- Do not send status frames independently at a rate that competes with controller receive/transmit windows. Tie link responses to the protocol scheduler.

### 7.4 ESP32 runtime resilience

- Review watchdog/brownout/reset handling against the selected ESP32 Arduino core. Add a watchdog only with a clear recovery policy tested against UART, startup and latched safety state.
- Document what resets clear: Uno volatile account state; session and policy/budget counters on both boards; and the in-RAM revoke latch.
- On reboot, never reuse the previous in-RAM session as continuous. Require new negotiation and safe recommissioning.
- Keep diagnostics bounded and avoid printing untrusted full payloads or secret fields.

## 8. Commands, configuration and observability

- Keep USB commands separate from peer protocol. USB commands configure local RAM policy/demo account and must never forge peer ACK, permit, session-ready state or clear a latched revoke.
- Specify/test short and full SET_POLICY forms, all bounds, and relationship between Uno transaction-decision timeout and guardian commit timeout.
- Validate a new configuration atomically: parse into temporary variables, validate everything, then apply all values or change nothing.
- Emit stable structured diagnostic codes instead of testing free-form reason strings. Include board role, phase/state, reason code, session suffix if useful, sequence/message identity, retry count and elapsed time; never log PINs.
- STATUS should distinguish waiting for peer, negotiating, ready/no heartbeat, fresh heartbeat, pending transaction, policy denial, link timeout and revoke.
- Use wrap-safe elapsed durations, not millis() as wall-clock time.
- Diagnostics are not authority. A serial line saying PERMIT or HEALTHY does not prove the UI's virtual-dispenser gate is correctly implemented.

## 9. Verification strategy

Testing is a required deliverable, not something postponed until all code is written.

### 9.1 Host-native unit tests

Extract the smallest portable pieces possible and test without hardware:

- CRC-16/CCITT-FALSE reference vectors and identical results on both board targets.
- Encode/decode round trips; exact frame boundaries; malformed separators; invalid CRC/version; field overflow; missing newline; extra fields; truncation and overlong frames.
- Numeric parser boundaries, signs, leading/trailing junk, empty strings and overflow.
- Exact schemas, duplicate keys and unknown fields.
- Sequence progression, exact duplicate retransmission, conflicting duplicate, gap, wrap/exhaustion and session mismatch.
- Handshake retries, lost/delayed acknowledgements, duplicate HELLO, reset of either peer and retry exhaustion.
- State-transition table and authentication/state consistency.
- Withdrawal/denomination plans, insufficient funds/stock, amount/window limits and arithmetic overflow.
- Lost request ACK, duplicated REQUEST, lost PERMIT, duplicated PERMIT, lost DENY, lost COMMIT, duplicated COMMIT, mismatched amount/ID, deadline expiry, revoke while pending and restart during pending.
- Timer behavior near 32-bit millisecond rollover.
- Fixed-buffer boundary conditions and secret-buffer clearing where observable.

Include golden protocol vectors so a refactor cannot silently change CRC/framing semantics.

### 9.2 Deterministic protocol simulation

Add a host-side UART/link simulator that can drop, delay, duplicate, corrupt, truncate, concatenate, reorder and overrun a frame; pause one endpoint; reset either endpoint; and sweep timing. It should model both UART directions and the Uno's constrained SoftwareSerial scheduling sufficiently to reproduce the known failure class.

**Required property:** no injected transport failure may produce an unauthorized transaction mutation. A recoverable dropped/CRC-bad frame may recover through defined retry; exhausted retry or irrecoverable protocol fault ends with no permit and an explicit fault.

### 9.3 Build and static checks

Extend GitHub Actions beyond compilation:

1. Compile Uno for arduino:avr:uno using the pinned AVR core.
2. Compile ESP32 for esp32:esp32:esp32 using the pinned ESP32 core.
3. Run portable parser/protocol/state-machine unit tests.
4. Run protocol simulation and transaction invariants.
5. Fail on test errors; preserve useful test output and build-size measurements where feasible.
6. Add compiler warnings and portable static checks for suspicious integer conversion, buffer bounds and unsafe string calls. Resolve warnings rather than merely printing them.

CI passing proves compilation and deterministic tests only. It cannot prove UART wiring, signal levels, receive-window timing, USB monitor behavior or physical bench reliability.

### 9.4 Physical bench matrix

Use the actual Uno + ESP32 with the documented wiring: Uno AltSoftSerial D8 RX / D9 TX, ESP32 UART2 GPIO16 RX / GPIO17 TX, shared GND, and appropriate 5 V-to-3.3 V level shifting. Begin with no configured account/cash; do not commission fictional customer data until the link is stable.

- Both boards start together; ESP32 first; Uno first; staggered power-on.
- Clean paired reset after latched failure.
- Reset Uno alone while ESP32 observes; reset ESP32 alone while Uno observes; verify no stale session/permit survives.
- At least 100 repeated clean startup/reconnect cycles before declaring handshake stable.
- At least 30 minutes of observing with no transactions; inspect heartbeat age, unexpected sequence faults, buffer overflow and resets.
- Confirm link loss, disconnect/reconnect, malformed/CRC-invalid frame and peer restart deny withdrawals and converge to safe state.
- After stable handshake, provision fictional data and test successful withdrawal, DENY, policy limits, wrong PIN/lockout, state timeout, transaction timeout, mismatched/duplicate transaction messages and forced revoke.
- Save both USB logs with timestamps where possible; record board reset, command, expected result and actual result.

Do not intentionally drive unsafe voltage levels or connect real accounts, payment systems or physical cash hardware.

## 10. Release acceptance gates

A milestone is complete only when evidence is recorded in its PR or release notes.

### Gate A — Protocol correctness

- A written V3 message/state/retry contract matches both implementations.
- Both builds pass with warnings reviewed.
- All parser/CRC/sequence/handshake unit tests pass.
- Every state-changing message has a documented idempotency and timeout rule.
- The startup failure is reproduced or the leading failure class is ruled out with trace-backed tests.

### Gate B — Transaction safety

- No balance/cash mutation without a fresh, exact, transaction-correlated permit.
- Deny, timeout, lost ACK, link loss, reset or revoke leaves virtual account/cash unchanged unless a commit completed exactly once under the defined protocol.
- Duplicate messages cannot duplicate mutation or guardian commit counting.
- Mismatched commit or expired permit causes fail-closed behavior.
- Arithmetic-boundary and denomination-plan tests pass.

### Gate C — Robustness

- Protocol fault-injection and randomized tests pass with no unauthorized mutation.
- 100 clean hardware startup/reconnect cycles pass on the actual unchanged wiring.
- The 30-minute observation run passes without unexplained revocation/liveness gaps.
- Link loss and single-board reset produce documented outcomes; recovery never accepts stale permit/session.
- Flash/SRAM and relevant timing budgets are recorded.

### Gate D — Product integration boundary

- When desktop simulator integration occurs, its own domain logic blocks virtual cash mutation on no permit, stale permit, denial, revoke, serial error, disconnect, timeout and duplicate commit.
- UI is a view of authorization state, not its source of truth.
- Firmware tests alone do not complete end-to-end system qualification.

Do not skip a gate because an exhibition date is near. Narrow the demo feature set rather than weakening safety checks.

## 11. Implementation sequence

Each phase should use a focused pull request or otherwise reviewable commit. Keep main buildable; do not merge untested protocol edits directly into the active firmware.

| Phase | Deliverable | Exit criteria |
|---|---|---|
| 0. Baseline/incident reproduction | Record flash/RAM, enumerate messages/transitions, add redacted frame diagnostics or host reproduction without changing authority rules | Startup failure is reproduced or narrowed by evidence; regressions captured |
| 1. Protocol test foundation | Golden CRC/frame vectors, bounded parser tests, schema tests, timer/sequence boundaries | Tests run locally and in CI; both current targets compile |
| 2. V3 protocol/session engine | Reviewed V3 contract, explicit handshake, stop-and-wait retry, duplicate idempotency, bounded timeout/revoke | Simulated loss/duplicate/delay tests pass before transaction logic changes |
| 3. Guardian liveness/state reconciliation | Sequence/session integration, per-heartbeat acknowledgement, exact transitions, status semantics and fault codes | Simulation converges to READY or a defined fault; no unexplained ready state |
| 4. Transaction lifecycle | Explicit pending record, request/decision/commit identity, deduplicated commit, deadlines, atomic policy accounting, overflow protection | Loss/duplication matrix proves no double commit or unauthorized mutation |
| 5. Board hardening | State centralization, command/config validation, secret clearing, bounded-loop/resource review, reset/revoke rules, diagnostics | Static/resource review complete; unit and integration suites pass |
| 6. Physical bench qualification | Repeat starts, timed observation, link-loss/reset and fictional transaction tests on current hardware/wiring | Gates B/C recorded from real logs; no compile-only claims |
| 7. Desktop integration (separate scope) | Desktop authorization gate and V3 serial adapter, if/when simulator work starts | Gate D passes; UI cannot bypass domain authorization |

### Review discipline

- Start from current main; do not roll back to an older firmware.
- Keep changes narrow. Do not combine protocol migration, account-flow redesign and desktop UI work in one PR.
- Update protocol spec and tests with every behavior change.
- Require both board builds and relevant tests before merging.
- Compare flash/SRAM and timing impact, especially for Uno.
- Keep a checklist of PASS / FAIL / NOT RUN. Hardware tests not performed must be NOT RUN, never inferred from CI.
- After merge, flash and bench-test the targeted phase before proceeding.

## 12. Explicit exclusions and honest claims

This plan does not turn Uno/ESP32 into production ATM firmware. It does not add another ESP32, Raspberry Pi, sensor, physical dispenser, real bank network, persistent real account store, protected PIN pad, secure element, hardware-backed identity, cryptographic message authentication, or guaranteed secure-boot configuration. It does not promise arbitrary malware detection from two microcontrollers that partly rely on controller-reported state.

Cryptographic authentication is a future architecture decision requiring key provisioning, protected storage, rotation/lifecycle and a threat model—not simply a field added to ASCII frames. Without a trusted key/device root, a MAC/signature proposal must not be presented as a complete defense. Current session IDs and sequence numbers are bookkeeping, not proof of identity.

The near-term standard is narrower and meaningful: **a deterministic, thoroughly tested educational firmware pair that never grants virtual withdrawal authority on stale, duplicate, malformed, out-of-state, unreconciled or missing evidence—and that explains exactly why it refuses.**

## 13. First concrete implementation ticket

**Title:** Protocol V3 — deterministic handshake, retry and idempotent frame handling

Scope:
1. Add portable host tests for current CRC/frame parsing and a modeled startup exchange.
2. Instrument redacted transmit/receive/sequence/ack/retry/fault codes on both boards.
3. Specify the V3 handshake and stop-and-wait contract before coding.
4. Implement handshake and reliable-message primitives on both boards together.
5. Keep V2 transaction semantics unchanged until transport passes its test suite.
6. Verify both board builds; run simulated dropped/duplicated/delayed-frame cases; then open a PR.
7. Flash both boards and confirm repeated clean sessions on physical hardware before starting the transaction-lifecycle phase.

**Done means:** repeated clean startup is stable; one dropped handshake acknowledgement is retried without assigning a new message identity; an exact duplicate does not repeat side effects; a conflicting duplicate or exhausted retry remains fail-closed; and the Uno never declares a fresh guardian link or grants a permit before V3 negotiation completes.
