import { describe, expect, it } from 'vitest';
import {
  canBeginHilWithdrawal,
  parseKeyValueText,
  redactSensitiveSerialText,
  reduceHilTransaction,
  type HilTransaction
} from './hil-evidence';

const requested: HilTransaction = {
  id: 'T0000007',
  amount: 500,
  phase: 'REQUESTED',
  unoCommitSeen: false,
  guardianCommitSeen: false,
  message: 'Uno reported a pending fictional withdrawal.'
};

describe('HIL evidence correlation', () => {
  it('reconciles only when permit, Uno commit, and guardian reconciliation match ID and amount', () => {
    const permit = reduceHilTransaction(requested, 'sentinel',
      '[PERMIT] One-shot observation issued for T0000007; amount=500');
    expect(permit?.phase).toBe('PERMIT OBSERVED');

    const unoCommit = reduceHilTransaction(permit, 'uno',
      'ATM_EVENT|WITHDRAWAL_APPROVED|id=T0000007;amount=500;balance=49500');
    expect(unoCommit?.phase).toBe('UNO COMMITTED');
    expect(unoCommit?.unoCommitSeen).toBe(true);
    expect(unoCommit?.balance).toBe(49500);

    const guardianCommit = reduceHilTransaction(unoCommit, 'sentinel',
      '[AUDIT] Matching controller-reported virtual transaction commit observed id=T0000007;amount=500');
    expect(guardianCommit?.phase).toBe('RECONCILED');
    expect(guardianCommit?.guardianCommitSeen).toBe(true);
    expect(canBeginHilWithdrawal(guardianCommit)).toBe(true);
  });

  it('does not reconcile a commit from the wrong ID or amount', () => {
    const wrongId = reduceHilTransaction(requested, 'sentinel',
      '[AUDIT] Matching controller-reported virtual transaction commit observed id=T0000008;amount=500');
    expect(wrongId?.phase).toBe('MISMATCH');
    expect(wrongId?.guardianCommitSeen).toBe(false);

    const wrongAmount = reduceHilTransaction(requested, 'sentinel',
      '[AUDIT] Matching controller-reported virtual transaction commit observed id=T0000007;amount=1000');
    expect(wrongAmount?.phase).toBe('MISMATCH');
  });

  it('marks a new request during an unresolved transaction as a mismatch', () => {
    const next = reduceHilTransaction(requested, 'uno',
      'ATM_EVENT|WITHDRAWAL_PENDING|id=T0000008;amount=500');
    expect(next?.phase).toBe('MISMATCH');
    expect(canBeginHilWithdrawal(next)).toBe(false);
  });

  it('marks deny and revoke as terminal-but-not-successful states', () => {
    const denied = reduceHilTransaction(requested, 'sentinel', '[DENY] id=T0000007;reason=TX_LIMIT');
    expect(denied?.phase).toBe('DENIED');
    expect(canBeginHilWithdrawal(denied)).toBe(true);

    const revoked = reduceHilTransaction(requested, 'sentinel', '[REVOKE] UNO heartbeat timeout.');
    expect(revoked?.phase).toBe('REVOKED');
    expect(canBeginHilWithdrawal(revoked)).toBe(false);
  });

  it('does not claim completion from uncorrelated console text', () => {
    expect(reduceHilTransaction(null, 'sentinel', 'sendFrame_return=true')).toBeNull();
    expect(reduceHilTransaction(null, 'sentinel', '[AUDIT] Matching controller-reported virtual transaction commit observed id=T0000007;amount=500')?.phase).toBe('MISMATCH');
  });
});

describe('HIL diagnostic text safety', () => {
  it('redacts PIN-bearing command text before it reaches journal/export surfaces', () => {
    expect(redactSensitiveSerialText('PIN 4826')).toBe('PIN [REDACTED]');
    expect(redactSensitiveSerialText('ADD_ACCOUNT CARD01 4826 50000')).toBe('ADD_ACCOUNT [REDACTED]');
    expect(redactSensitiveSerialText('CHANGE_PIN 4826 1357 1357')).toBe('CHANGE_PIN [REDACTED]');
    expect(redactSensitiveSerialText('ATM_EVENT|PIN_REQUIRED|tries=3;timeout_ms=30000')).toContain('PIN_REQUIRED');
  });

  it('parses key/value fields without treating unrelated output as transaction evidence', () => {
    expect(parseKeyValueText('id=T0000007;amount=500;balance=49500')).toEqual({
      id: 'T0000007', amount: '500', balance: '49500'
    });
    expect(parseKeyValueText('no key value fields')).toEqual({});
  });
});
