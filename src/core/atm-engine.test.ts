import { describe, expect, it } from 'vitest';
import { assessControllerEvidence, atmReducer, initialAtmState, type ControllerEvidence } from './atm-engine';

const healthy: ControllerEvidence = {
  expectedProfile: 'UNO-LAB-01', reportedProfile: 'UNO-LAB-01',
  privilegedPathRequested: false, maintenanceWindowOpen: false,
  observedSequence: 42, expectedSequence: 42, heartbeatAgeMs: 200,
  heartbeatLimitMs: 3000, frameFresh: true, legalStateTransition: true
};

describe('controller evidence policy', () => {
  it('accepts a healthy model observation', () => {
    expect(assessControllerEvidence(healthy)).toEqual([]);
  });
  it('explains independent fixture findings', () => {
    const findings = assessControllerEvidence({
      ...healthy, reportedProfile: 'UNO-LAB-01/ALTERED', privilegedPathRequested: true,
      observedSequence: 43, heartbeatAgeMs: 4000, frameFresh: false, legalStateTransition: false
    });
    expect(findings).toHaveLength(6);
  });
});
describe('virtual dispenser authority boundary', () => {
  it('blocks the controlled compromise fixture in protected mode', () => {
    const initial = initialAtmState('protected');
    const final = atmReducer(initial, { type: 'RUN_COMPROMISE_SCENARIO' });
    expect(final.sentinelStatus).toBe('AUTHORITY REVOKED');
    expect(final.lastDecision).toBe('REVOKE');
    expect(final.cassetteCash).toBe(initial.cassetteCash);
    expect(final.dispensedTotal).toBe(initial.dispensedTotal);
    expect(final.accountBalance).toBe(initial.accountBalance);
  });
  it('reproduces the unauthorized virtual dispense in baseline mode', () => {
    const initial = initialAtmState('baseline');
    const final = atmReducer(initial, { type: 'RUN_COMPROMISE_SCENARIO' });
    expect(final.sentinelStatus).toBe('MONITORING');
    expect(final.cassetteCash).toBe(initial.cassetteCash - 2000);
    expect(final.dispensedTotal).toBe(2000);
    expect(final.accountBalance).toBe(initial.accountBalance);
  });
});
