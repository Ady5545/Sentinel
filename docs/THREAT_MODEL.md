# SENTINEL ATM Research Prototype — Threat Model

**Status:** Research scope and assumptions  
**System:** Local desktop ATM emulation with one Arduino Uno and one ESP32 DevKit  
**Security objective:** Demonstrate that an independent guardian policy can deny a virtual dispenser request when defined controller-integrity or protocol violations are observed.

## Assets and security boundaries

- Synthetic account balance, transaction history and virtual cassette inventory.
- Customer-session state and the masked demonstration PIN flow.
- Controller-request identity, sequence/freshness state and the Sentinel permit/revoke decision.
- Incident evidence and experiment reproducibility.
- The domain-owned virtual dispenser gate, which is the final authority for changing virtual inventory.

No real bank, customer data, payment rail, production ATM, physical cash or actuator is in scope.

## Components and trust assumptions

| Component | Role | Trust treatment |
|---|---|---|
| Desktop domain core | Runs simulation, rules, transaction invariants and virtual dispenser gate | Authoritative for this software simulation; not a hardware root of trust |
| Arduino Uno | Primary controller stand-in | Untrusted when its state conflicts with observed protocol or test fixture evidence |
| ESP32 | Separate guardian stand-in | Board-reported messages are not automatically trusted; local policy/freshness still applies |
| Serial link | Carries bounded status/event frames | Can lose, corrupt, duplicate, delay or replay data; CRC is error detection, not authentication |
| Renderer/UI | Presents controls and results | Never decides whether cash may be dispensed |
| Simulated sensors | Represent cabinet/tamper signals | Synthetic unless explicitly connected and calibrated |

## Threat scenarios

1. **Controller state/profile mismatch:** a reported profile differs from the configured expected profile. This is a weak signal, not cryptographic attestation.
2. **Illegal transition:** the observed controller transition violates the documented state machine.
3. **Stale, duplicated or skipped frame:** sequence/freshness checks identify traffic outside the accepted window.
4. **Heartbeat loss or guardian disconnect:** protected mode fails closed and denies virtual dispensing.
5. **Privileged service path outside maintenance:** deterministic fixture supplies evidence; Sentinel policy evaluates it.
6. **Dispenser replay:** duplicate request identifiers must not result in a second dispense.
7. **UI spoofing or ordering bug:** the domain-owned gate remains the final check; labels alone cannot authorize a dispense.
8. **Malformed serial input:** bounded parsing rejects overlong, incomplete or invalid frames without crashing or granting authority.

## Attacker capabilities and exclusions

The research fixture may model an untrusted or deliberately inconsistent controller. It does not implement malware, exploit real ATM firmware, or prove detection of arbitrary compromise. The prototype does not claim resistance to physical attacks, invasive hardware modification, malicious host operating systems, compromised desktop builds, ESP32 compromise, key extraction or denial of service.

## Evidence provenance

Every displayed finding must be marked as one of: **SIMULATED**, **BOARD-REPORTED**, **PROTOCOL-VALIDATED**, or **INDEPENDENTLY OBSERVED**. A serial port opening or a self-reported build string is never sufficient to mark a controller secure. The current software fixture is synthetic and must not be presented as a live board compromise.

## Fail-safe rule

In protected mode, unknown, invalid, stale or missing required guardian authority means **deny the virtual dispense**. The gate checks current authority immediately before mutating account/cassette state. Baseline mode exists only as an unprotected simulation comparison and must never be connected to real machinery.

## Research limitations

A successful result supports only the narrow tested claim: under the specified fixtures and assumptions, the independent policy denied the modeled unauthorized dispense. It does not establish universal compromise detection, certified ATM security, cryptographic attestation, PCI/FIPS compliance or physical interlocking. Real actuators would require a separate safety review and independent hardware interlock.
