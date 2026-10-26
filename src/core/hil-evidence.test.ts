import { describe, expect, it } from 'vitest';
import {
  canBeginHilWithdrawal,
  canClearHilFaultAfterPairedReset,
  initialHilShadowState,
  invalidateHilShadow,
  parseKeyValueText,
  planHilNotes,
  reconcileHilShadowCommit,
  redactSensitiveSerialText,
  reduceHilShadowObservation,
  reduceHilTransaction,
  reduceStructuredHilTransaction,
  type HilTransaction
} from './hil-evidence';

const requested: HilTransaction = {
  id: 'T0000007',
  amount: 500,
  phase: 'REQUESTED',
  permitSeen: false,
  unoCommitSeen: false,
  guardianCommitSeen: false,
  guardianAckSentSeen: false,
  unoAckAcceptedSeen: false,
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
    expect(guardianCommit?.phase).toBe('GUARDIAN COMMIT OBSERVED');
    expect(guardianCommit?.guardianCommitSeen).toBe(true);

    const ackSent = reduceStructuredHilTransaction(guardianCommit, 'sentinel', {
      type: 'COMMIT_ACK_SENT', id: 'T0000007', amount: 500
    });
    expect(ackSent?.phase).toBe('GUARDIAN ACK SENT');
    expect(ackSent?.guardianAckSentSeen).toBe(true);

    const ackAccepted = reduceStructuredHilTransaction(ackSent, 'uno', {
      type: 'UNO_ACK_ACCEPTED', id: 'T0000007', amount: 500
    });
    expect(ackAccepted?.phase).toBe('RECONCILED');
    expect(ackAccepted?.unoAckAcceptedSeen).toBe(true);
    expect(canBeginHilWithdrawal(ackAccepted)).toBe(true);
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
    const denied = reduceHilTransaction(requested, 'sentinel', '[DENY] id=T0000007;amount=500;reason=TX_LIMIT');
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

  it('requires exact ID and amount for UNO or guardian denial decisions', () => {
    const missingAmount = reduceHilTransaction(requested, 'sentinel', '[DENY] id=T0000007;reason=TX_LIMIT');
    expect(missingAmount?.phase).toBe('MISMATCH');
    expect(missingAmount?.id).toBe(requested.id);

    const wrongAmount = reduceHilTransaction(requested, 'sentinel', '[DENY] id=T0000007;amount=1000;reason=TX_LIMIT');
    expect(wrongAmount?.phase).toBe('MISMATCH');
    expect(wrongAmount?.unoCommitSeen).toBe(false);

    const wrongId = reduceHilTransaction(requested, 'uno', 'ATM_EVENT|WITHDRAWAL_DENIED|id=T0000008;amount=500;reason=TX_LIMIT');
    expect(wrongId?.phase).toBe('MISMATCH');

    const missingId = reduceHilTransaction(requested, 'uno', 'ATM_EVENT|WITHDRAWAL_DENIED|reason=TX_LIMIT');
    expect(missingId?.phase).toBe('MISMATCH');
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


describe('HIL desktop shadow dispenser gate', () => {
  const commissioned = () => reduceHilShadowObservation(
    reduceHilShadowObservation(initialHilShadowState(),
      'ATM_EVENT|ACCOUNT_PROVISIONED|card=CARD01;balance=50000'),
    'ATM_EVENT|CASH_CONFIGURED|currency=INR;notes500=20;notes200=20;notes100=20;notes50=20;total=17000'
  );

  it('commissions a shadow from board-reported counts and updates only after full reconciliation', () => {
    let shadow = commissioned();
    expect(shadow.status).toBe('COMMISSIONED');
    expect(shadow.cassetteCash).toBe(17000);
    expect(shadow.accountBalance).toBe(50000);

    const tx: HilTransaction = {
      id: 'T0000007', amount: 500, phase: 'RECONCILED', permitSeen: true,
      unoCommitSeen: true, guardianCommitSeen: true,
      guardianAckSentSeen: true,
      unoAckAcceptedSeen: true, balance: 49500, message: 'matched'
    };
    shadow = reconcileHilShadowCommit(shadow, tx);
    expect(shadow.accountBalance).toBe(49500);
    expect(shadow.cassetteCash).toBe(16500);
    expect(shadow.dispensedTotal).toBe(500);
    expect(shadow.committedTransactionIds).toEqual(['T0000007']);

    const duplicate = reconcileHilShadowCommit(shadow, tx);
    expect(duplicate).toBe(shadow);
    expect(duplicate.dispensedTotal).toBe(500);
  });

  it('does not change shadow money when a transaction is not fully reconciled', () => {
    const shadow = commissioned();
    const tx: HilTransaction = {
      id: 'T0000007', amount: 500, phase: 'UNO COMMITTED', permitSeen: true,
      unoCommitSeen: true, guardianCommitSeen: false, balance: 49500, message: 'awaiting guardian'
    };
    expect(reconcileHilShadowCommit(shadow, tx)).toBe(shadow);
  });

  it('marks an unexplained balance mismatch and leaves virtual inventory untouched', () => {
    const shadow = commissioned();
    const tx: HilTransaction = {
      id: 'T0000007', amount: 500, phase: 'RECONCILED', permitSeen: true,
      unoCommitSeen: true, guardianCommitSeen: true,
      guardianAckSentSeen: true,
      unoAckAcceptedSeen: true, balance: 123, message: 'matched'
    };
    const result = reconcileHilShadowCommit(shadow, tx);
    expect(result.status).toBe('RECONCILIATION REQUIRED');
    expect(result.accountBalance).toBe(50000);
    expect(result.cassetteCash).toBe(17000);
    expect(result.dispensedTotal).toBe(0);
  });

  it('quarantines a commissioned shadow after a board/session failure without altering money state', () => {
    const shadow = commissioned();
    const invalidated = invalidateHilShadow(shadow, 'Board reset observed.');
    expect(invalidated.status).toBe('RECONCILIATION REQUIRED');
    expect(invalidated.accountBalance).toBe(shadow.accountBalance);
    expect(invalidated.cassetteCash).toBe(shadow.cassetteCash);
    expect(invalidated.error).toContain('Board reset');
  });

  it('denomination planner agrees with the 500/200/100/50 virtual cassette rules', () => {
    expect(planHilNotes(750, { notes500: 1, notes200: 1, notes100: 0, notes50: 1 }))
      .toEqual({ notes500: 1, notes200: 1, notes100: 0, notes50: 1 });
    expect(planHilNotes(750, { notes500: 1, notes200: 0, notes100: 0, notes50: 0 })).toBeNull();
  });
});


describe('structured board-event correlation', () => {
  it('reconciles the exact typed ID and amount without parsing raw renderer text', () => {
    const pending = reduceStructuredHilTransaction(null, 'uno', {
      type: 'ATM_EVENT', eventName: 'WITHDRAWAL_PENDING', id: 'T0000007', amount: 500
    });
    expect(pending?.phase).toBe('REQUESTED');

    const permit = reduceStructuredHilTransaction(pending, 'sentinel', {
      type: 'PERMIT', id: 'T0000007', amount: 500
    });
    expect(permit?.phase).toBe('PERMIT OBSERVED');

    const guardianCommit = reduceStructuredHilTransaction(permit, 'sentinel', {
      type: 'COMMIT_RECONCILIATION', id: 'T0000007', amount: 500
    });
    expect(guardianCommit?.phase).toBe('GUARDIAN COMMIT OBSERVED');

    const unoCommit = reduceStructuredHilTransaction(guardianCommit, 'uno', {
      type: 'ATM_EVENT', eventName: 'WITHDRAWAL_APPROVED',
      id: 'T0000007', amount: 500, balance: 49500
    });
    expect(unoCommit?.phase).toBe('GUARDIAN COMMIT OBSERVED');
    const ackSent = reduceStructuredHilTransaction(unoCommit, 'sentinel', {
      type: 'COMMIT_ACK_SENT', id: 'T0000007', amount: 500
    });
    const reconciled = reduceStructuredHilTransaction(ackSent, 'uno', {
      type: 'UNO_ACK_ACCEPTED', id: 'T0000007', amount: 500
    });
    expect(reconciled?.phase).toBe('RECONCILED');
    expect(reconciled?.balance).toBe(49500);
  });

  it('quarantines typed transaction evidence that mismatches the active amount', () => {
    const pending = reduceStructuredHilTransaction(null, 'uno', {
      type: 'ATM_EVENT', eventName: 'WITHDRAWAL_PENDING', id: 'T0000007', amount: 500
    });
    const wrongPermit = reduceStructuredHilTransaction(pending, 'sentinel', {
      type: 'PERMIT', id: 'T0000007', amount: 1000
    });
    expect(wrongPermit?.phase).toBe('MISMATCH');
    expect(wrongPermit?.unoCommitSeen).toBe(false);
  });

  it('does not change the transaction from unrelated console observations', () => {
    expect(reduceStructuredHilTransaction(requested, 'uno', { type: 'CONSOLE_LINE' })).toBe(requested);
  });
});


describe('paired-reset fault clearing', () => {
  const baseline = { uno: 3, sentinel: 6 };

  it('does not clear a HIL fault merely because both boards look ready again', () => {
    expect(canClearHilFaultAfterPairedReset('MISMATCH', true, baseline, baseline)).toBe(false);
    expect(canClearHilFaultAfterPairedReset('REVOKED', true, baseline, { uno: 4, sentinel: 6 })).toBe(false);
    expect(canClearHilFaultAfterPairedReset('MISMATCH', false, baseline, { uno: 4, sentinel: 7 })).toBe(false);
  });

  it('clears only after both boards boot again and paired readiness is fresh', () => {
    expect(canClearHilFaultAfterPairedReset('MISMATCH', true, baseline, { uno: 4, sentinel: 7 })).toBe(true);
    expect(canClearHilFaultAfterPairedReset('DENIED', true, baseline, { uno: 4, sentinel: 7 })).toBe(false);
    expect(canClearHilFaultAfterPairedReset('RECONCILED', true, baseline, { uno: 4, sentinel: 7 })).toBe(false);
  });
});


describe('post-commit shadow integrity', () => {
  const committed = () => {
    const shadow = reduceHilShadowObservation(
      reduceHilShadowObservation(initialHilShadowState(),
        'ATM_EVENT|ACCOUNT_PROVISIONED|card=CARD01;balance=50000'),
      'ATM_EVENT|CASH_CONFIGURED|currency=INR;notes500=20;notes200=20;notes100=20;notes50=20;total=17000'
    );
    return reconcileHilShadowCommit(shadow, {
      id: 'T0000007', amount: 500, phase: 'RECONCILED', permitSeen: true,
      unoCommitSeen: true, guardianCommitSeen: true,
      guardianAckSentSeen: true,
      unoAckAcceptedSeen: true, balance: 49500, message: 'matched'
    });
  };

  it('quarantines a changed cassette after commit without overwriting the reduced inventory', () => {
    const afterCommit = committed();
    const changed = reduceHilShadowObservation(afterCommit,
      'ATM_EVENT|CASH_CONFIGURED|currency=INR;notes500=20;notes200=20;notes100=20;notes50=20;total=17000');
    expect(changed.status).toBe('RECONCILIATION REQUIRED');
    expect(changed.accountBalance).toBe(afterCommit.accountBalance);
    expect(changed.cassetteCash).toBe(afterCommit.cassetteCash);
    expect(changed.dispensedTotal).toBe(afterCommit.dispensedTotal);
  });

  it('quarantines account balance reprovisioning after commit', () => {
    const afterCommit = committed();
    const changed = reduceHilShadowObservation(afterCommit,
      'ATM_EVENT|ACCOUNT_PROVISIONED|card=CARD01;balance=50000');
    expect(changed.status).toBe('RECONCILIATION REQUIRED');
    expect(changed.accountBalance).toBe(49500);
    expect(changed.cassetteCash).toBe(16500);
    expect(changed.dispensedTotal).toBe(500);
  });

  it('rejects duplicate and malformed key-value fields instead of silently taking the last value', () => {
    expect(parseKeyValueText('id=T0000007;amount=500;amount=1')).toEqual({});
    expect(parseKeyValueText('id=T0000007;amount=500;unexpected field')).toEqual({});
  });

  it('redacts PIN values in structured key-value diagnostics', () => {
    expect(redactSensitiveSerialText('ATM_EVENT|PIN_STATE|pin=4826;tries=1')).toContain('pin=[REDACTED]');
    expect(redactSensitiveSerialText('ATM_EVENT|PIN_STATE|pin=4826;tries=1')).not.toContain('4826');
  });
});
