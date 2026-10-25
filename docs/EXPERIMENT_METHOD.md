# SENTINEL Controlled Experiment Method

## Research question

Can an independent guardian policy detect the specified controller-integrity or behavior violations and prevent a compromised primary controller from causing the simulator's dispenser to release virtual cash?

## Independent variable

- **Baseline:** intentionally unprotected software simulation; the same controller fixture is replayed without independent Sentinel enforcement.
- **Protected:** deterministic Sentinel policy evaluates the fixture and the domain-owned dispenser gate enforces its current permit/revoke decision.

Baseline is never a hardware mode and must never operate a physical actuator.

## Controlled inputs

For every comparison, reset to the same synthetic account balance, cassette inventory, session preconditions and scenario seed. Replay the same fixture in both modes. Scenario evidence is input to the policy; selecting a scenario does not itself set the final verdict.

Initial fixture catalogue:
1. Normal authorized withdrawal.
2. Illegal controller state transition.
3. Stale, duplicate or skipped sequence.
4. Heartbeat timeout / guardian disconnect.
5. Privileged service path outside maintenance.
6. Reported profile mismatch (weak signal).
7. Simulated cabinet alarm.
8. Dispenser jam or empty cassette.
9. Sentinel absent/stale while protected mode is selected.

Each fixture should define its injected evidence, expected policy behavior, severity, known blind spots and whether the evidence is synthetic or board-reported.

## Measurements

- Scenario and run identifier.
- Detection/decision latency where a reliable monotonic clock is available.
- Decision and reason.
- Number of attempted virtual dispenses.
- Number of unauthorized successful virtual dispenses.
- Virtual amount released.
- Account balance and cassette inventory before/after.
- Guardian availability and evidence provenance.
- Final system state and any recovery requirement.

The primary outcome is whether unauthorized virtual cash was released, not the number of alerts. A “blocked” label without unchanged cassette inventory is a failed protection result.

## Procedure

1. Start a clean simulation run and record version/configuration.
2. Confirm the account and cassette starting values.
3. Apply one documented fixture.
4. Execute the same request in baseline mode; record the gate result and final balances.
5. Reset to the exact initial state and replay the same fixture in protected mode.
6. Record Sentinel findings and the independent gate result.
7. Verify the invariant: a denied dispense does not reduce account balance or cassette inventory and does not increment the dispense count.
8. Export the complete run with fixture definition, evidence provenance, metrics and limitations.
9. Repeat each fixture at least five times before making claims about repeatability.

## Interpretation and reporting

Report per-fixture outcomes and failure cases. Do not average away a successful unauthorized dispense. Distinguish deterministic synthetic evidence from board-reported telemetry and protocol-validated frames. A passing software experiment supports only the defined simulation claim; it is not proof of production ATM security, universal compromise detection or physical interlocking.
