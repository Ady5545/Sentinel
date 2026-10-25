# SENTINEL ATM Simulator — Full Implementation Plan

**Type:** Engineering implementation plan  
**Status:** Implementation source of truth; phase exit gates are mandatory  
**Date:** 25 October 2026  
**Repository:** [Ady5545/Sentinel](https://github.com/Ady5545/Sentinel)  
**Target:** Native desktop software for macOS (Apple Silicon first) and Windows x64  
**Runtime posture:** Offline-first; local simulation always available; optional UNO + ESP32 hardware-in-the-loop

---

## 1. Product definition

SENTINEL is a **desktop ATM simulator/emulator**, not a website, bank portal, transaction page, cloud dashboard, or online service. It must install and launch as a normal Mac or Windows application. After installation, the app must operate without a network connection. A web browser is not part of the user's workflow.

The application models the full *educational ATM system* around the customer terminal: host, sessions, virtual card/PIN interfaces, transaction engine, primary controller, independent Sentinel layer, cabinet/safe, cassette inventory, dispenser, modeled tamper inputs, incident journal, and repeatable experiments. The customer-facing ATM terminal is only one subsystem.

**Research question:** Can an independent guardian detect defined controller-integrity/behavior violations and prevent a compromised primary controller from causing the simulator's dispenser to release virtual cash?

The baseline and protected experiments must replay the **same fault fixture** with the same initial balance and cassette inventory. The fixture supplies evidence; the Sentinel rules determine the verdict; the dispenser gate's resulting state determines the outcome. The attack button must not itself dictate a detection result.

### 1.1 Authority model

- **Arduino Uno:** the physical stand-in for the ATM's primary control microcontroller. Its research firmware will have a deliberately controlled compromise/test state. The UNO is the observed controller, not the ultimate dispensing authority.
- **ESP32 / SENTINEL:** the separate security authority. It monitors the available evidence and maintains the independent permit/revoke state.
- **Desktop application:** emulates the ATM host, customer interface, synthetic accounts, peripherals not present in hardware, safe/cabinet, virtual cash and experiment recording.
- **Virtual dispenser gate:** authoritative domain component. Protected dispensing must consult Sentinel's current permit/revoke state immediately before changing inventory. No UI label or UNO-reported “OK” can bypass this gate.
- **Available hardware:** exactly one Arduino Uno and one ESP32 DevKit, with the current UART connection. No Raspberry Pi, second ESP32, extra sensor kit, real ATM, real card, or real cash is assumed.

### 1.2 Meaning of “full ATM” in this prototype

The first complete demonstrator must support:
1. Welcome/idle, virtual card insert/eject, masked PIN, clear/enter/cancel, retry limit, timeout, and session cleanup.
2. Synthetic account lookup, balance inquiry, cash withdrawal, mini statement, local funds-transfer demonstration, and PIN-change demonstration.
3. Transaction authorization, primary-controller states, dispenser requests, virtual cassette inventory, receipt output, faults and cancellation.
4. Cabinet model: host/controller area, card reader, EPP/PIN-pad model, printer, safe/vault, cassettes, dispenser, alarm monitor, and backup-power state.
5. Sentinel console: controller status, protocol/heartbeat state, evidence, decision reasoning, authority state, and incident history.
6. Experiment lab: baseline/protected comparison, controlled scenario fixtures, deterministic reset/replay, metrics and exports.
7. Optional native USB serial connection to the two boards. Hardware must not be necessary to open the app or run the core experiment.

This is a complete educational emulation of selected ATM components and security boundaries, **not a vendor-exact recreation or a certified production ATM**.

---

## 2. Existing repository and migration decision

The current repository is a small React + Vite proof of concept designed to publish as a static browser page. The current React screen owns most of the simulation state, the current Vite setup targets the GitHub Pages subpath, and a GitHub Actions workflow publishes a website. That is not the required final product.

The repo is the only project home. There will be no second repository and no separate source of truth.

### Migration rules
- Replace the website delivery path with a packaged Electron desktop application.
- Load local renderer assets in production; never depend on the GitHub Pages URL for runtime.
- Reuse React/TypeScript where helpful, but rebuild the experience as an actual ATM/emulator application with separate Customer Terminal, Machine Model, Sentinel Console, Experiment Lab, and Journal areas.
- Extract transaction/security logic out of React and into independently tested domain modules.
- Move USB serial operations into Electron's main process behind a small typed IPC API.
- Stop deploying the product through GitHub Pages once desktop build CI exists. Deleting a deploy workflow alone does not guarantee an already-published Pages artifact is removed; Pages settings may also need to be disabled.
- Leave README.md unchanged in this phase; this plan is the detailed implementation reference.
- Keep all changes, firmware, protocol documentation, tests and CI in Ady5545/Sentinel.

---

## 3. Technology choice and alternatives

### Recommendation: Electron + React + TypeScript + a plain domain core

Use Electron for native desktop packaging/window/process control, React and TypeScript for the local UI, plain TypeScript modules for the ATM/security rules, Node SerialPort for the USB adapter, and electron-builder for OS-specific distributables.

Rationale:
- React/TypeScript/Vite are already in the repository, so the migration can preserve useful code without preserving the website product.
- Electron provides a Node-capable main process to own serial ports and native application lifecycle.
- A single source tree can create a macOS Apple Silicon package and a Windows x64 package.
- The entire renderer and its dependencies are bundled locally, allowing offline use.
- The existing code and developer environment are more naturally served by TypeScript than by introducing a separate Rust command layer now.

Electron is not permission to treat the renderer as privileged web content. Isolation, narrow IPC, local assets, validated messages and dependency maintenance are required.

### Alternatives considered

| Approach | Strength | Trade-off / decision |
| --- | --- | --- |
| Browser or GitHub Pages | Easy to publish | Rejected: it remains a website and complicates access to native serial ports. |
| Tauri | Smaller native package | Viable, but introduces a Rust/native-plugin layer not present in the repo and adds serial integration/toolchain risk for this prototype. |
| Electron | Reuses the current stack, Node serial access, mature packaging | Selected. Bundle size is higher, so the app must follow Electron's security recommendations. |

Use the current stable Electron release when implementation dependencies are locked, not alpha/nightly. Pin resolved versions in the lockfile and keep them current through reviewed dependency updates.

**Reference docs**
- [Electron releases](https://releases.electronjs.org/)
- [Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model)
- [Electron IPC](https://www.electronjs.org/docs/latest/tutorial/ipc)
- [Electron security recommendations](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)
- [Electron packaging](https://www.electronjs.org/docs/latest/tutorial/tutorial-packaging)
- [electron-builder](https://www.electron.build/docs/)
- [SerialPort](https://serialport.io/docs/)
- [Arduino UNO Rev3 technical limits](https://store.arduino.cc/products/arduino-uno-rev3)

---

## 4. Goals, non-goals and failure conditions

### Goals
- Native application installers for macOS Apple Silicon and Windows x64 from this repo.
- Offline, deterministic customer-ATM workflow.
- A coherent machine model whose component states affect actual behavior.
- A controlled compromise experiment with an honest baseline and an independently enforced protected outcome.
- Native serial integration for the existing UNO/ESP32 setup.
- Traceable evidence provenance: simulated vs board-reported vs protocol-validated.
- Repeatable runs, incident replay, measured metrics and JSON/CSV exports.
- A restrained industrial ATM/software-lab interface, not a generic SaaS dashboard.
- Cross-platform CI and tests around state transitions, transaction invariants and the dispenser authority boundary.

### Non-goals
- No live bank, card network, online account, real payment, real customer PIN, real cash or production cash dispenser.
- No claim that this prototype is PCI PTS/FIPS certified, banking-grade, tamper-resistant, or suitable for production ATMs.
- No claim that UNO can prove its own integrity by reporting a version string.
- No real active tamper mesh, EPP, seismic/temperature/voltage sensors, backup battery, ink/gas neutralization, or real cryptographic-key destruction.
- No real malware or instructions for exploiting commercial ATM firmware.
- No AI requirement. Begin with deterministic, explainable rules.
- No web login, cloud backend or remote dependency for the app to run.

### This project is wrong if
- The delivery is just another website with an installer wrapper.
- UI components, rather than a tested domain engine, own security decisions.
- Clicking “attack” automatically sets the detector verdict with no evidence evaluation.
- The displayed outcome says “blocked” while the virtual cassette/inventory changes.
- UNO remains the ultimate dispenser authority in protected mode.
- CRC, a serial message, or an ordinary reported build ID is described as cryptographic attestation.
- Simulated sensors/zeroization appear to be live physical features.
- Protected hardware-in-the-loop mode silently allows a dispense when Sentinel disappears.
- Simulation mode requires boards, internet, or a special browser.

---

## 5. System architecture

### 5.1 Three areas

**A. Electron host and adapters**
- Main process: application lifecycle, windows/menus, data path, serial-port ownership, native dialogs, validated IPC and structured diagnostics.
- Preload: narrow, typed methods exposed through contextBridge. Never expose raw ipcRenderer, unrestricted filesystem, arbitrary shell calls or Node APIs to the renderer.
- Serial adapter: port enumeration, open/close, bounded framing, line/frame parsing, timeouts, reconnect and normalized device events.
- Persistence/export adapter: sanitized settings and experiment records under the OS application-data directory; native save dialogs for exports.

**B. Plain TypeScript domain core**
- ATM state machine and session manager.
- Synthetic account/card store and transaction engine.
- EPP/PIN-pad, card-reader and receipt-printer models.
- Primary controller model and protocol-message interpreter.
- Cassette inventory and virtual dispenser gate.
- Cabinet/environment model and simulated tamper signals.
- Sentinel evidence/policy evaluator and authority state machine.
- Scenario fixture runner, event journal and metric evaluator.

This layer must not import React, Electron, DOM APIs or platform-specific modules. It must be unit-testable without launching a window.

**C. Local renderer**
- Customer terminal
- Machine/cabinet explorer
- Sentinel console
- Experiment/scenario lab
- Incident journal, results comparison and export controls

The renderer requests domain actions and displays state. It is never itself the security authority.

### 5.2 End-to-end action path

1. Customer terminal or experiment lab requests an action.
2. The domain engine validates the session and emits a typed controller request.
3. The selected adapter is simulation-only, board-assisted, or explicitly selected baseline.
4. In protected mode the Sentinel evaluator checks the evidence available to it and the authority manager updates state.
5. Immediately before dispensing, the domain-owned gate checks the current permit, mode, request freshness and dispenser state.
6. Only an allowed transition changes account/cassette state.
7. The journal records the input, evidence, decision, gate result and outcome using correlated IDs.
8. UI screens render the resulting state.

### 5.3 Domain model

At minimum:
- **ATM instance:** identity, build/profile, selected run mode, version.
- **Session:** ID, virtual card/account, failed PIN count, inactivity deadline, current transaction, card-return state.
- **Account:** synthetic ID, balance, limits, lock state and statement entries.
- **Transaction:** ID/type/amount, checks, controller request ID, Sentinel decision, dispense result and final status.
- **Controller evidence:** source, reported state/profile, expected and observed sequence, privilege/service state, heartbeat age, freshness and limitations.
- **Sentinel state:** startup self-test, monitoring, suspect, authority revoked, recovery required, maintenance.
- **Dispenser state:** allowed/denied/faulted, cassette inventory, denomination plan, dispense count, request ID.
- **Cabinet state:** door/safe/service-window state, simulated backup power and environmental flags.
- **Evidence record:** timestamp, provenance, rule, value, freshness and correlation references.
- **Experiment run:** ID, seed, starting state, mode, events, metrics, final state and export metadata.

A request ID links transaction → controller request → Sentinel decision → gate result. Do not infer authority only from UI event order.

---

## 6. Application screens and behavior

The product should feel like a purpose-built machine emulator. Use compact app navigation, a persistent connection/security strip, clear machine status and task-specific panels. No website hero, marketing copy, cloud banner, general-purpose analytics cards or browser navigation.

### 6.1 Customer ATM terminal
- Welcome/idle screen; insert/eject virtual card.
- Masked PIN keypad with enter, clear, cancel, retry limit, lockout and inactivity timeout.
- Synthetic demo account; account menu and session lifecycle.
- Balance inquiry, cash withdrawal, mini statement, local transfer demonstration, PIN-change demonstration and end/cancel.
- Withdrawal amount selection; custom amount only if cassette/denomination feasibility can be calculated.
- Authorization progress, dispense progress, receipt preview/print simulation, card return.
- Rejections for wrong PIN, locked account, insufficient balance, cassette shortage, dispenser jam, host/controller fault, session timeout and security lockdown.
- Demo credentials only. PIN digits never appear in event logs. EPP encryption/certification must not be claimed.

### 6.2 Machine/cabinet explorer
Selectable, stateful module diagram:
- Upper cabinet: host computer, display, card reader, PIN/EPP model, receipt printer and primary controller.
- Control/communication: host-controller path, UNO-to-ESP32 UART, independent Sentinel decision path.
- Lower safe/vault: virtual cassettes, dispenser, safe door/bolt state and alarm/tamper monitor.
- Modeled sensor inputs: door/case, light, temperature, voltage/clock anomaly, vibration/tilt and backup-power status.
- Each module explains its responsibility, current state and data provenance.
- Unconnected sensors must be labeled **SIMULATED**; no decorative graphic may imply actual telemetry.

### 6.3 Sentinel console
Show board presence separately from trust:
- UNO/ESP32 USB status, serial-link health and last valid frame.
- Protocol version, sequence/freshness status, heartbeat age and rejected-frame reason.
- Controller state and legal/illegal transition.
- Sentinel state, active evidence findings and reasoned decision.
- Dispenser authority and last rejected request.
- Whether balance/cassette state changed on the last decision.
- Source labels: simulated, board-reported, protocol-validated or independently observed.
- Opening a serial port alone must never render the system “secure”.

### 6.4 Scenario and experiment lab
Initial reproducible fixtures:
- Normal authorized withdrawal.
- Illegal controller state transition.
- Sequence gap or stale/replayed frame.
- Heartbeat timeout/disconnect.
- Privileged service path outside maintenance.
- Reported controller profile mismatch (weak signal).
- Simulated cabinet/tamper alarm.
- Dispenser jam/empty cassette.
- Sentinel absent or stale while protected mode is selected.

The fixture supplies inputs; the policy evaluates evidence. A scenario must state prerequisites, exact injected signals, expected behavior, severity and known blind spots. Baseline/protected comparison resets to the same starting account/cassette state and replays the same fixture seed. Display detection time, decision, attempted requests, successful unauthorized dispenses, virtual amount released and final state.

### 6.5 Event journal and export
Each event records wall-clock time, monotonic elapsed time, run/session/transaction/request IDs, component/source, severity, event kind, previous/new state, decision, reason and evidence provenance. Support filtering, detail inspection, incident replay and native JSON/CSV export. The report must include the scenario definition and version, run mode, start/end state, metrics and limitations. All data is synthetic.

---

## 7. State machines

### ATM customer and transaction flow
IDLE → CARD_PRESENT → PIN_ENTRY → AUTHENTICATED → TRANSACTION_MENU → TRANSACTION_INPUT → HOST_AUTHORIZATION → CONTROLLER_REQUESTED → SENTINEL_CHECK → DISPENSER_AUTHORIZATION → DISPENSING → RECEIPT → SESSION_END.

Additional explicit states: CANCELLED, SESSION_TIMEOUT, ACCOUNT_LOCKED, SECURITY_LOCKDOWN and DISPENSER_FAULT.

Every transition is validated. Withdrawal cannot jump from PIN entry directly to dispensing.

### Primary controller
Represent normal, service/maintenance and controlled research-compromise states explicitly. A compromised controller may lie about its own health; its self-report is not sufficient evidence.

### Sentinel
STARTUP_SELF_TEST → MONITORING → SUSPECT → AUTHORITY_REVOKED → RECOVERY_REQUIRED, with an explicitly authorized MAINTENANCE_MODE path.

High-severity failures may immediately revoke; other findings may enter SUSPECT according to a documented deterministic policy. No opaque AI verdicts in the first version.

### Recovery
Stop new requests; preserve the incident; require operator acknowledgement; reset the test fixture; re-establish an acceptable controller/guardian state; record why recovery was permitted. A generic reset must not silently erase evidence or imply that real firmware was repaired.

---

## 8. Detection model and scientific limitations

The available hardware does not include a secure element, physical safe, actual EPP, tamper mesh or cash actuator. This project can demonstrate defined test cases and a narrow hypothesis, not universal compromise detection.

### Evidence provenance
1. **Simulation-only:** injected controller profile mismatch, service state, sequence anomaly, virtual sensor/tamper input.
2. **Board-reported:** values/events sent by UNO or ESP32. These are useful telemetry but are not automatically trustworthy.
3. **Protocol-validated:** supported version, bounded complete frame, correct checksum, expected session, fresh sequence and legal transition.
4. **Independently observed by Sentinel/app:** Sentinel's own elapsed heartbeat timer, its local freshness/sequence tracking and the simulator-owned dispenser decision.
5. **Out of scope:** certified secure boot/attestation, non-extractable keys, silicon-level tamper detection, calibrated physical sensors, bank-host authentication and a physically interlocked cash dispenser.

### Protocol truths
- CRC detects accidental frame corruption; it does **not** authenticate a sender.
- Sequence, session, freshness and state checks can detect stale, missing, duplicated, replayed or nonsensical traffic within defined assumptions.
- A secret in ordinary UNO flash does not make a trustworthy hardware root. Compromised firmware may read or misuse it.
- A reported build string may be spoofed; mismatch is a useful weak signal/test fixture, not conclusive real firmware attestation.
- Every rule and known blind spot must be shown in documentation and experiment results.

### Dispenser boundary
- In simulation mode, tested domain-core policy controls the virtual dispenser.
- Baseline mode intentionally removes independent protection only for the research comparison; it must never operate real dispensing hardware.
- In protected hardware-in-the-loop mode, missing/stale Sentinel permission, invalid frame, lost heartbeat, revocation or disallowed state means **no virtual dispense**.
- The desktop display is not a physical safety interlock. No physical dispenser or actuator exists in the current kit.
- Future physical actuators require a separate safety/design review and independent hardware interlock; that is outside this plan.

### Cabinet sensors and zeroization
The UI may model a security mesh, door switches, optical/light input, temperature, voltage/clock, seismic/tilt, backup power and alarm/key-zeroization response. They must be labeled simulated unless the exact sensor is physically connected and calibrated. Zeroization is a simulated state transition, not real key destruction.

---

## 9. UNO–ESP32 protocol

Write a protocol specification before integrating the boards. The UNO Rev3 uses an ATmega328P with 32 KB flash and 2 KB SRAM, so frames and parsing must be bounded and small.

Requirements:
- Versioned, framed messages with bounded length.
- Message type, boot/session identifier, sequence/counter, controller state/flags, payload and CRC for link error detection.
- Maximum frame length and fixed parser buffer.
- Heartbeat interval and timeout; reconnect handshake; explicit freshness.
- Legal controller transition table.
- Typed status/heartbeat/event/acknowledgement/permit/revoke/recovery messages as needed.
- Unique dispense request IDs; duplicate requests must not dispense twice.
- Unknown versions, invalid fields, oversized/truncated frames, bad CRC, stale/replayed sequence and illegal transitions are rejected; malformed input must not crash the firmware or create a permit.
- Reconnect creates a new session and never silently restores revoked authority.
- Board USB console baud is configured separately from the UNO↔ESP32 UART baud.

Any challenge-response idea must document nonce generation, key storage, replay assumptions and limits. Do not advertise strong authentication without a trustworthy key/verification root. Prioritize independently checkable liveness, freshness, legal transitions, observable test anomalies and fail-closed authority.

### Hardware modes
- **Simulation only:** no boards needed; software Sentinel and dispenser gate are authoritative.
- **Observe hardware:** read USB console/frames and display provenance; serial text alone is not proof of integrity.
- **Controlled hardware-in-the-loop:** only supported firmware/protocol versions; scenario is explicitly enabled; board evidence and result recorded; outcome is still the virtual dispenser.
- **Disconnected/faulted:** show clear fault; protected mode denies dispensing.
- **Baseline:** deliberately unprotected *simulation comparison only*, never real machinery.

---

## 10. Intended repo layout

Names may shift slightly, but separation is mandatory:

    docs/
      ATM_SIMULATOR_IMPLEMENTATION_PLAN.md
      SENTINEL_PROTOCOL.md
      THREAT_MODEL.md
      EXPERIMENT_METHOD.md

    electron/
      main.ts
      preload.ts
      ipc/
      hardware/
        serial-manager.ts

    src/
      app/
      components/
        terminal/
        cabinet/
        sentinel/
        experiment/
        journal/
      core/
        atm/
        devices/
        sentinel/
        scenarios/
        journal/
        metrics/
      adapters/
        simulation/
        hardware/
        persistence/
      assets/
      styles/

    firmware/
      uno/
      esp32/

    protocol/
      SENTINEL_PROTOCOL.md

    tests/
      unit/
      integration/
      hardware-in-the-loop/
      fixtures/

    .github/workflows/
      build-test.yml
      desktop-release.yml

Add only the files needed for the current milestone; keep every committed milestone buildable.

---

## 11. Detailed implementation phases

Every phase has a gate. Do not assume a phase works because a later screen looks correct.

### Phase 0 — Transition and product contract
- Commit this plan.
- Replace the website publish workflow with desktop build/release workflows.
- Define package metadata, application ID, version policy, icons and scripts.
- Pin the runtime/toolchain and produce a lockfile.
- Keep the repo as the sole project home.
- Do not rewrite README as an unrelated task.

**Gate:** GitHub Pages is no longer treated as product delivery, and the repository is clearly a desktop app project.

### Phase 1 — Electron application foundation
- Create Electron main/preload entry points and local renderer loading.
- Set context isolation on, Node integration off, sandbox on where compatible.
- Add restrictive CSP, navigation restrictions, deny arbitrary new windows, validate IPC sender and payloads.
- Expose minimal typed methods only.
- Add native app lifecycle, menu, version/build display, minimum window size and app-data path.
- Add development, test, build, package and make scripts.
- Test offline launch and packaged local assets.

**Gate:** One-window native app can launch in development and be packaged without remote product content.

### Phase 2 — Pure ATM domain engine
- Implement typed states/actions and legal transitions.
- Add synthetic account/card records, PIN checks/retry lockout, sessions/timeouts.
- Add transaction authorization, limits, balance/statement operations, and cassette arithmetic.
- Model the dispenser and its fault outcomes.
- Add correlated event IDs.
- Unit-test before UI wiring.

**Gate:** Domain core imports no UI/Electron/DOM code; tests validate state transitions and money/cassette invariants.

### Phase 3 — Customer terminal
- Implement the full customer menu/withdrawal/inquiry/statement flow and simulated transfer/PIN-change demonstrations.
- Add masked PIN, cancel/clear/enter, card return, timeout and simulated receipts.
- Display errors/faults and recovery.
- Ensure PIN digits never enter logs.

**Gate:** End-to-end customer flow works with mouse/keyboard and all account changes result from accepted domain transitions.

### Phase 4 — Cabinet/peripheral models
- Add selectable host, controller, card reader, EPP/PIN pad, printer, cassette/dispenser, safe/door, alarm and backup-power models.
- Add simulated tamper/environment controls and provenance labels.
- Connect module faults to actual state-machine outcomes.

**Gate:** Each control either changes a tested model or is clearly informational; simulation is visually distinguishable from real boards.

### Phase 5 — Sentinel and dispenser authority
- Implement typed evidence/provenance, monitor/suspect/revoke/recovery states.
- Add rules for illegal state transition, sequence/freshness anomaly, heartbeat loss, duplicate request, invalid protocol, service path outside maintenance, reported identity mismatch and simulated tamper.
- Make the gate check current permission immediately before dispensing.
- Enforce duplicate prevention and fail-closed protected mode.
- Test normal allows, valid denials and each documented rule independently.

**Gate:** Same compromised fixture succeeds in the explicitly unprotected baseline and is blocked in protected mode; denial keeps account/cassette state unchanged and gives a specific reason.

### Phase 6 — Scenario runner
- Store scenarios as versioned data with seed, setup, injected input facts, prerequisites, expected behavior and known blind spots.
- Start with state transition, stale/replay, heartbeat, service-window, profile mismatch, tamper and dispenser fault cases.
- Separate fault setup from detector decision.
- Add identical-state reset/replay and baseline/protected comparison.

**Gate:** Scenario runs are reproducible; no hardcoded attack-button verdict; software-only demonstration works without boards.

### Phase 7 — Protocol and board firmware
- Commit protocol spec and golden test fixtures first.
- Implement compact bounded parsing/state logic in UNO firmware.
- Implement independent heartbeat/freshness/policy and authority state in ESP32 firmware.
- Provide readable serial console logs plus machine-parseable frames.
- Add request IDs, handshake, duplicate/replay rejection, reconnect and recovery.
- Label reported firmware identity as self-reported, not attested.

**Gate:** Firmware compiles for the correct boards; golden frames match the parser; malformed/stale/duplicate messages never grant protected authority.

### Phase 8 — Native USB serial adapter
- Use SerialPort in Electron main only.
- Add user-initiated port discovery and selection for each board. Do not rely on enumeration order.
- Keep USB console baud separate from UART baud.
- Add bounded parsing, timeouts, reconnect/unplug handling, port contention diagnostics and clean shutdown.
- Expose allowlisted operations only; do not expose arbitrary renderer serial writes.
- Keep simulation functional without either board.

**Gate:** Mac package can observe the actual boards; Windows package builds and USB paths are tested when Windows hardware is available; disconnected protected mode fails closed.

### Phase 9 — Journal, metrics and replay
- Persist experiment records under app data.
- Measure detection-to-decision and decision-to-gate delays using a monotonic clock.
- Count requests, blocked requests, unauthorized successful dispenses, false positives and false negatives for the declared fixtures.
- Export JSON/CSV and a compact report with scenario/versions/provenance/limitations.
- Add incident replay from saved run definitions.

**Gate:** Results can be regenerated from recorded fixtures; no invented latency or hardcoded percentages.

### Phase 10 — Packaging and release
- Build macOS Apple Silicon DMG/ZIP and Windows x64 installer/ZIP from the same commit.
- Use OS-native CI runners; rebuild native dependencies for each target.
- Add icons, version metadata, checksums and artifact validation.
- Add launch/offline smoke tests on each OS runner.
- Add signing/notarization only when legitimate credentials are available; never commit secrets.
- Clearly identify unsigned builds and their possible Gatekeeper/SmartScreen warnings.

**Gate:** CI produces valid artifacts for both platforms. CI packaging is recorded separately from manual physical hardware testing.

### Phase 11 — Research validation/demo
- Publish threat model and experiment method.
- Run the same seeded scenarios in baseline and protected modes with equal starting conditions.
- Include positive allow cases and negative deny cases to measure false positives.
- Prepare the judge demonstration: normal transaction, baseline attack, protected attack, incident record and measurements.
- Explain what the prototype cannot prove.

**Gate:** Every security claim has an implementation/test reference or is explicitly marked as a simulated model.

---

## 12. Testing plan

### Unit tests
- ATM/session/controller/Sentinel state transitions.
- PIN retries, lockout, cancellation and timeouts.
- Account balance and cassette accounting.
- Denomination feasibility and amount limits.
- Sentinel policy rules and recovery.
- Dispenser authorization, duplicate request prevention and fail-closed behavior.
- Scenario determinism.
- Protocol parser, CRC, sequence/freshness, version/length limits.
- Event correlation and metric calculations.

### Integration tests
- Card insert → PIN → menu → withdrawal → receipt.
- Controller request → evidence → Sentinel decision → gate → cassette mutation/denial.
- Same seeded baseline/protected scenario.
- Cassette-empty, jam, host fault, cancellation and timeout.
- Sentinel disconnect, heartbeat timeout, malformed frame, reconnect and recovery.
- Export/read-back of an experiment.

### Desktop tests
- App remains one native window; no unexpected browser or remote content.
- Mouse and keyboard workflows work.
- PIN input remains masked and is absent from event logs.
- App launches and supports simulation with Wi-Fi off and no hardware.
- Restart does not silently restore authority after a revoked incident.
- Window resizing, minimum dimensions and display scaling are checked.

### Platform matrix

| Test | macOS Apple Silicon | Windows x64 |
| --- | --- | --- |
| Type-check, unit and integration tests | Required | Required |
| Package build and startup smoke test | Required | Required |
| Offline operation | Required | Required |
| USB list/connect/disconnect/reconnect | Physical hardware test | Physical hardware test when Windows hardware is available |
| UNO-to-ESP32 protocol on bench | Required on existing kit | Repeat when available |
| Baseline/protected deterministic scenario | Required | Required |
| JSON/CSV export | Required | Required |

CI output must never be described as a physical hardware test.

---

## 13. Security and reliability checklist

- Local packaged content only; no online runtime dependency.
- Electron current stable and actively maintained.
- Renderer: context isolation, no Node integration, sandbox where compatible, restrictive CSP.
- IPC: validate sender, schema, allowed operation, lengths and state preconditions.
- No unrestricted filesystem, shell, raw Electron API or general-purpose serial writer exposed to renderer.
- USB devices open only after user action; close all ports/streams on quit.
- Bounded parsers; malformed frames cannot grow memory or accidentally permit dispensing.
- Protected mode fails closed when trust/permission is absent or stale.
- Scenario fixture cannot write the security verdict directly.
- Domain core exclusively owns balance, cassettes and dispenser mutations.
- Never log entered PIN; synthetic account data only.
- Persist under app user-data path; enable explicit export/delete of local experiment data.
- Document the limits of reported IDs, CRC, software secrets and missing physical sensors.

---

## 14. Build and delivery contract

### Development
- Install dependencies from the lockfile.
- Run Vite and Electron together via a cross-platform development script.
- The local Vite server is development-only; packaged builds load bundled local files.
- Simulation is usable without internet, boards or hardware permissions.

### Packaging
- macOS: Apple Silicon DMG and optional ZIP; build on a macOS runner.
- Windows: x64 installer (NSIS) and optional ZIP/portable output; build on Windows runner.
- Do not assume cross-OS packaging of native dependencies is reliable.
- Verify artifact name/version/target architecture and generate SHA-256 checksums.

### GitHub Actions
- Pull requests: type-check, tests, renderer build, Electron main/preload syntax validation and packaging checks.
- Desktop build workflow: macOS and Windows jobs, with artifacts uploaded separately.
- Firmware compile workflow: UNO and ESP32 compile checks.
- Delete/retire the Pages deployment workflow when desktop artifact CI replaces it.

### Signing
No signing credentials are assumed. Unsigned packages are acceptable for the initial school demonstrator if identified clearly. Public distribution should add macOS signing/notarization and Windows code signing when valid credentials are available. Secrets must not be committed to the repository.

---

## 15. Acceptance criteria

The first complete demonstrator is done only when all items pass:

1. Launches as native desktop software on macOS and Windows, not a browser page.
2. Opens and runs offline without a remote server.
3. Completes customer demo flows for authentication, inquiry, withdrawal, statement, simulated transfer/PIN-change, cancel, receipt and errors.
4. Account balance and cassette inventory change only on accepted domain transitions.
5. Cabinet model makes simulated inputs visually and textually distinct from physical data.
6. Valid protected transactions are allowed.
7. The identical seeded compromise scenario allows the virtual unauthorized dispense in baseline mode and blocks it in protected mode.
8. A protected denial leaves account and cassette balances unchanged.
9. Every implemented detector fixture has an explicit reason and matching test; ordinary valid behavior is also tested for false positives.
10. Missing/stale Sentinel, invalid frame, duplicate/replayed request or illegal transition cannot grant protected dispensing authority.
11. Event journal correlates scenario, request, evidence, decision, gate result and outcome.
12. Metrics/reports are reproducible from saved run fixtures and disclose provenance.
13. UNO and ESP32 firmware compile, protocol fixtures pass, and hardware-in-the-loop results are recorded separately.
14. GitHub Actions produces platform-specific Mac and Windows artifacts from the same revision.
15. No claim of certified ATM security, universal intrusion detection, real zeroization or physical cash protection is made.

---

## 16. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| UI becomes the entire product again | Domain-first architecture; the UI only invokes/test-displays the ATM engine. |
| UNO lies about its own health | Treat UNO reports as untrusted; use independently tracked freshness/state and state limitations. |
| CRC is marketed as security | Document error detection separately from authentication. |
| USB attached equals “secure” | Separate presence, link health, protocol validity, integrity decision and dispenser authority states. |
| Native serial fails after packaging | Use OS-specific builds and smoke tests; rebuild native modules per Electron target. |
| Mac success masks Windows failure | Separate Windows runner and artifact checks. |
| Simulated sensors mislead judges | Persistent SIMULATED badges and provenance in every report. |
| Reset hides incidents | Keep incident records and require explicit recovery acknowledgement. |
| Releases are unsigned | Label unsigned builds; add signing later through protected CI secrets. |

---

## 17. Initial coding order

1. Desktop Electron shell and safe preload/IPC.
2. Pure ATM types/state machine and unit tests.
3. Sentinel policy + authoritative virtual dispenser gate.
4. Customer terminal connected to the domain engine.
5. Security console and deterministic baseline/protected experiment.
6. Cabinet/peripheral models.
7. Protocol spec and shared frame fixtures.
8. UNO/ESP32 firmware and native serial manager.
9. Journal, metrics and export.
10. OS-specific packages, smoke tests and research validation.

Do not start by polishing the old browser screen, adding decorative 3D, or adding many sensors. None of those prove the research question.

---

## 18. Definition of done

This project is complete when the packaged Mac and Windows ATM emulator can perform a complete local customer session, show the modeled machine and its limits, demonstrate a repeatable controller-compromise experiment, make SENTINEL's decision through tested logic, enforce the protected virtual dispenser gate, record traceable evidence, export results, and interface with the existing two-board setup through a versioned protocol.

A polished interface alone is not completion. A connected serial port alone is not completion. An “attack” button alone is not completion.

**The deliverable is the testable ATM-emulation experiment: customer terminal + domain model + primary controller + independent SENTINEL policy + enforced virtual dispenser boundary + reproducible evidence + cross-platform desktop package.**
