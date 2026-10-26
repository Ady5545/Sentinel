import { describe, expect, it } from 'vitest';
import { initialHilTerminalState, reduceHilTerminalLine, applyHilTransactionStatus } from './hil-terminal';
import type { HilTransaction } from './hil-evidence';

const requested: HilTransaction = {
  id: 'T0000012', amount: 500, phase: 'REQUESTED',
  permitSeen: false, unoCommitSeen: false, guardianCommitSeen: false,
  message: 'Uno reported a pending withdrawal.'
};

describe('HIL customer terminal', () => {
  it('moves through card, PIN, authentication and board-reported balance states', () => {
    let state = initialHilTerminalState();
    state = reduceHilTerminalLine(state, 'uno', 'ATM_EVENT|PIN_REQUIRED|tries=3;timeout_ms=30000');
    expect(state.screen).toBe('pin');
    state = reduceHilTerminalLine(state, 'uno', 'ATM_EVENT|AUTHENTICATED|card=CARD01');
    expect(state.screen).toBe('menu');
    state = reduceHilTerminalLine(state, 'uno', 'ATM_EVENT|BALANCE|amount=49500');
    expect(state.screen).toBe('receipt');
    expect(state.boardBalance).toBe(49500);
  });

  it('does not claim a withdrawal is complete until guardian reconciliation', () => {
    let state = reduceHilTerminalLine(initialHilTerminalState(), 'uno',
      'ATM_EVENT|WITHDRAWAL_PENDING|id=T0000012;amount=500');
    expect(state.screen).toBe('pending');
    state = reduceHilTerminalLine(state, 'uno',
      'ATM_EVENT|WITHDRAWAL_APPROVED|id=T0000012;amount=500;balance=49000');
    expect(state.screen).toBe('pending');
    state = applyHilTransactionStatus(state, { ...requested, phase: 'UNO COMMITTED', unoCommitSeen: true, balance: 49000 });
    expect(state.screen).toBe('pending');
    state = applyHilTransactionStatus(state, { ...requested, phase: 'RECONCILED', permitSeen: true, unoCommitSeen: true, guardianCommitSeen: true, balance: 49000 });
    expect(state.screen).toBe('receipt');
    expect(state.boardBalance).toBe(49000);
    expect(state.message).toContain('correlated by ID and amount');
  });

  it('denies mismatched or revoked transactions instead of showing a dispense success', () => {
    let state = applyHilTransactionStatus(initialHilTerminalState(), { ...requested, phase: 'MISMATCH', message: 'Mismatched transaction.' });
    expect(state.screen).toBe('lockdown');
    expect(state.message).toContain('No desktop virtual-cash mutation');
    state = reduceHilTerminalLine(initialHilTerminalState(), 'sentinel', '[REVOKE] guardian fault');
    expect(state.screen).toBe('lockdown');
  });

  it('invalidates an unresolved transaction on a board restart', () => {
    const pending = { ...initialHilTerminalState(), screen: 'pending' as const };
    const state = reduceHilTerminalLine(pending, 'uno', 'SENTINEL ATM CONTROLLER V3.3 READY');
    expect(state.screen).toBe('lockdown');
  });
});
