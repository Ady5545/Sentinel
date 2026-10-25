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
describe('ATM customer state machine', () => {
  it('authenticates a demo session without recording PIN digits', () => {
    let state = initialAtmState();
    state = atmReducer(state, { type: 'INSERT_CARD' });
    for (const digit of '1234') state = atmReducer(state, { type: 'PIN_DIGIT', digit });
    state = atmReducer(state, { type: 'PIN_SUBMIT' });
    expect(state.screen).toBe('menu');
    expect(state.authenticated).toBe(true);
    expect(state.pinBuffer).toBe('');
    expect(state.events.some(event => event.detail.includes('1234'))).toBe(false);
  });

  it('locks the demo session after three incorrect PIN attempts', () => {
    let state = initialAtmState();
    state = atmReducer(state, { type: 'INSERT_CARD' });
    for (let attempt = 0; attempt < 3; attempt++) {
      for (const digit of '0000') state = atmReducer(state, { type: 'PIN_DIGIT', digit });
      state = atmReducer(state, { type: 'PIN_SUBMIT' });
    }
    expect(state.screen).toBe('locked');
    expect(state.failedPinAttempts).toBe(3);
  });

  it('updates account and cassette balances only after an allowed withdrawal', () => {
    let state = initialAtmState('protected');
    state = atmReducer(state, { type: 'INSERT_CARD' });
    for (const digit of '1234') state = atmReducer(state, { type: 'PIN_DIGIT', digit });
    state = atmReducer(state, { type: 'PIN_SUBMIT' });
    state = atmReducer(state, { type: 'SELECT_SERVICE', service: 'withdrawal' });
    state = atmReducer(state, { type: 'SELECT_AMOUNT', amount: 1000 });
    const final = atmReducer(state, { type: 'CONFIRM_AMOUNT' });
    expect(final.accountBalance).toBe(state.accountBalance - 1000);
    expect(final.cassetteCash).toBe(state.cassetteCash - 1000);
    expect(final.dispensedTotal).toBe(1000);
    expect(final.lastDecision).toBe('PERMIT');
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
