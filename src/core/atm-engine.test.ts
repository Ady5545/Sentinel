import { describe, expect, it } from 'vitest';
import { assessControllerEvidence, atmReducer, initialAtmState, type AtmState, type ControllerEvidence } from './atm-engine';

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

  it('requires a separate explicit simulation permit before a protected withdrawal commits', () => {
    let state = initialAtmState('protected');
    state = atmReducer(state, { type: 'INSERT_CARD' });
    for (const digit of '1234') state = atmReducer(state, { type: 'PIN_DIGIT', digit });
    state = atmReducer(state, { type: 'PIN_SUBMIT' });
    state = atmReducer(state, { type: 'SELECT_SERVICE', service: 'withdrawal' });
    state = atmReducer(state, { type: 'SELECT_AMOUNT', amount: 1000 });
    state = atmReducer(state, { type: 'CONFIRM_AMOUNT', nowMs: 1000 });
    expect(state.screen).toBe('pending');
    expect(state.pendingWithdrawal?.id).toBeTruthy();
    expect(state.accountBalance).toBe(25000);
    expect(state.cassetteCash).toBe(50000);
    expect(state.dispensedTotal).toBe(0);
    expect(state.lastDecision).toBe('NONE');

    state = atmReducer(state, { type: 'AUTHORIZE_PENDING_WITHDRAWAL', nowMs: 1010 });
    expect(state.simulationPermit?.transactionId).toBe(state.pendingWithdrawal?.id);
    expect(state.simulationPermit?.amount).toBe(1000);
    expect(state.simulationPermit?.evidenceSource).toBe('SIMULATED');
    expect(state.accountBalance).toBe(25000);
    expect(state.cassetteCash).toBe(50000);

    state = atmReducer(state, { type: 'COMMIT_PENDING_WITHDRAWAL', nowMs: 1020 });
    expect(state.accountBalance).toBe(24000);
    expect(state.cassetteCash).toBe(49000);
    expect(state.dispensedTotal).toBe(1000);
    expect(state.lastDecision).toBe('PERMIT');

    const repeated = atmReducer(state, { type: 'COMMIT_PENDING_WITHDRAWAL', nowMs: 1030 });
    expect(repeated.accountBalance).toBe(24000);
    expect(repeated.cassetteCash).toBe(49000);
    expect(repeated.dispensedTotal).toBe(1000);
  });

  it('denies commit without a permit and leaves money state unchanged', () => {
    const state = {
      ...initialAtmState('protected'), screen: 'pending' as const, authenticated: true, service: 'withdrawal' as const,
      pendingWithdrawal: { id: 'TX-1', amount: 1000, requestedAtMs: 1 }
    };
    const denied = atmReducer(state, { type: 'COMMIT_PENDING_WITHDRAWAL', nowMs: 2 });
    expect(denied.accountBalance).toBe(state.accountBalance);
    expect(denied.cassetteCash).toBe(state.cassetteCash);
    expect(denied.dispensedTotal).toBe(0);
    expect(denied.lastDecision).toBe('BLOCK');
    expect(denied.events.at(-1)?.title).toContain('no current matching permit');
  });

  it('rejects an expired permit without changing money state', () => {
    const state = {
      ...initialAtmState('protected'), screen: 'pending' as const, authenticated: true, service: 'withdrawal' as const,
      pendingWithdrawal: { id: 'TX-2', amount: 1000, requestedAtMs: 1 },
      simulationPermit: { id: 'P-1', transactionId: 'TX-2', amount: 1000, issuedAtMs: 1, expiresAtMs: 10, evidenceSource: 'SIMULATED' as const },
      lastDecision: 'PERMIT' as const
    };
    const denied = atmReducer(state, { type: 'COMMIT_PENDING_WITHDRAWAL', nowMs: 11 });
    expect(denied.accountBalance).toBe(state.accountBalance);
    expect(denied.cassetteCash).toBe(state.cassetteCash);
    expect(denied.dispensedTotal).toBe(0);
    expect(denied.lastDecision).toBe('BLOCK');
  });

  it('rejects a permit issued in the future', () => {
    const state = {
      ...initialAtmState('protected'), screen: 'pending' as const, authenticated: true, service: 'withdrawal' as const,
      pendingWithdrawal: { id: 'TX-FUTURE', amount: 1000, requestedAtMs: 1 },
      simulationPermit: { id: 'P-FUTURE', transactionId: 'TX-FUTURE', amount: 1000, issuedAtMs: 20, expiresAtMs: 30, evidenceSource: 'SIMULATED' as const },
      lastDecision: 'PERMIT' as const
    };
    const denied = atmReducer(state, { type: 'COMMIT_PENDING_WITHDRAWAL', nowMs: 10 });
    expect(denied.accountBalance).toBe(state.accountBalance);
    expect(denied.cassetteCash).toBe(state.cassetteCash);
    expect(denied.dispensedTotal).toBe(0);
    expect(denied.lastDecision).toBe('BLOCK');
  });

  it('rejects a permit bound to another transaction or amount', () => {
    const base = {
      ...initialAtmState('protected'), screen: 'pending' as const, authenticated: true, service: 'withdrawal' as const,
      pendingWithdrawal: { id: 'TX-CURRENT', amount: 1000, requestedAtMs: 1 },
      simulationPermit: { id: 'P-MISMATCH', transactionId: 'TX-OTHER', amount: 2000, issuedAtMs: 1, expiresAtMs: 100, evidenceSource: 'SIMULATED' as const },
      lastDecision: 'PERMIT' as const
    };
    const denied = atmReducer(base, { type: 'COMMIT_PENDING_WITHDRAWAL', nowMs: 10 });
    expect(denied.accountBalance).toBe(base.accountBalance);
    expect(denied.cassetteCash).toBe(base.cassetteCash);
    expect(denied.dispensedTotal).toBe(0);
    expect(denied.lastDecision).toBe('BLOCK');
  });

  it('treats the exact expiry instant as expired', () => {
    const state = {
      ...initialAtmState('protected'), screen: 'pending' as const, authenticated: true, service: 'withdrawal' as const,
      pendingWithdrawal: { id: 'TX-EDGE', amount: 1000, requestedAtMs: 1 },
      simulationPermit: { id: 'P-EDGE', transactionId: 'TX-EDGE', amount: 1000, issuedAtMs: 1, expiresAtMs: 10, evidenceSource: 'SIMULATED' as const },
      lastDecision: 'PERMIT' as const
    };
    const denied = atmReducer(state, { type: 'COMMIT_PENDING_WITHDRAWAL', nowMs: 10 });
    expect(denied.accountBalance).toBe(state.accountBalance);
    expect(denied.cassetteCash).toBe(state.cassetteCash);
    expect(denied.dispensedTotal).toBe(0);
    expect(denied.lastDecision).toBe('BLOCK');
  });

  it('keeps the intentionally unprotected dispense only in baseline simulation', () => {
    let state: AtmState = {
      ...initialAtmState('baseline'), screen: 'pending' as const, authenticated: true, service: 'withdrawal' as const,
      pendingWithdrawal: { id: 'BASE-1', amount: 2000, requestedAtMs: 1 }
    };
    state = atmReducer(state, { type: 'AUTHORIZE_PENDING_WITHDRAWAL', nowMs: 2 });
    expect(state.simulationPermit).toBeNull();
    expect(state.lastDecision).toBe('NONE');
    state = atmReducer(state, { type: 'COMMIT_PENDING_WITHDRAWAL', nowMs: 3 });
    expect(state.cassetteCash).toBe(48000);
    expect(state.dispensedTotal).toBe(2000);
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
