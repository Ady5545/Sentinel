export type HilTransactionPhase =
  | 'REQUESTED'
  | 'PERMIT OBSERVED'
  | 'UNO COMMITTED'
  | 'GUARDIAN COMMIT OBSERVED'
  | 'RECONCILED'
  | 'DENIED'
  | 'REVOKED'
  | 'MISMATCH';

export interface HilTransaction {
  id: string;
  amount: number;
  phase: HilTransactionPhase;
  unoCommitSeen: boolean;
  guardianCommitSeen: boolean;
  balance?: number;
  message: string;
}

export type BoardRole = 'uno' | 'sentinel';

export function parseKeyValueText(value: string): Record<string, string> {
  return Object.fromEntries(value.split(';')
    .map(part => {
      const index = part.indexOf('=');
      return index < 1 ? ['', ''] : [part.slice(0, index), part.slice(index + 1)];
    })
    .filter(([key]) => key));
}

function mismatch(id: string, amount: number, message: string): HilTransaction {
  return {
    id: id || 'UNKNOWN',
    amount: Number.isFinite(amount) ? amount : 0,
    phase: 'MISMATCH',
    unoCommitSeen: false,
    guardianCommitSeen: false,
    message
  };
}

/**
 * Convert a *board-reported USB console line* into the active HIL transaction
 * lifecycle. This does not attest firmware identity and never authorizes cash.
 */
export function reduceHilTransaction(
  current: HilTransaction | null,
  device: BoardRole,
  line: string
): HilTransaction | null {
  if (!line) return current;

  if (line.includes('SENTINEL ATM CONTROLLER V3.3 READY') ||
      line.includes('SENTINEL ESP32 GUARDIAN V3.3 READY') ||
      line.startsWith('SESSION: ')) {
    if (current && !['RECONCILED', 'DENIED'].includes(current.phase)) {
      return {
        ...current,
        phase: 'MISMATCH',
        message: 'A board reboot/session-start line was observed during an unresolved transaction. Any previous permit/session is invalid; reconcile and recommission before continuing.'
      };
    }
    return current;
  }

  if (line.includes('[SECURITY_LOCK]') || line.includes('[REVOKE]') ||
      line.includes('GUARDIAN_STATUS|mode=REVOKED') || line.includes('GUARDIAN_REVOKED')) {
    return current ? {
      ...current,
      phase: 'REVOKED',
      message: 'A board reported a lock or revocation. Protected HIL remains denied until the pair is safely reset and recommissioned.'
    } : current;
  }

  if (device === 'uno' && line.startsWith('ATM_EVENT|')) {
    const [, eventName, ...detailParts] = line.split('|');
    const fields = parseKeyValueText(detailParts.join('|'));
    if (eventName === 'WITHDRAWAL_PENDING') {
      const amount = Number(fields.amount);
      if (!fields.id || !Number.isSafeInteger(amount) || amount <= 0) {
        return mismatch(fields.id || 'UNKNOWN', amount, 'Malformed board-reported withdrawal-pending event; no desktop authorization is inferred.');
      }
      if (current && !['RECONCILED', 'DENIED'].includes(current.phase)) {
        return mismatch(fields.id, amount, 'A second Uno withdrawal appeared before the previous HIL transaction reached a terminal state.');
      }
      return {
        id: fields.id,
        amount,
        phase: 'REQUESTED',
        unoCommitSeen: false,
        guardianCommitSeen: false,
        message: 'Uno reported a pending fictional withdrawal; waiting for the guardian decision.'
      };
    }

    if (eventName === 'WITHDRAWAL_APPROVED') {
      const amount = Number(fields.amount);
      const balance = Number(fields.balance);
      if (!current || current.id !== fields.id || current.amount !== amount ||
          current.phase === 'DENIED' || current.phase === 'REVOKED' || current.phase === 'MISMATCH') {
        return mismatch(fields.id || 'UNKNOWN', amount, 'Uno commit report does not match the active, permitted HIL transaction. No desktop virtual-cash update is allowed.');
      }
      const reconciled = current.guardianCommitSeen;
      return {
        ...current,
        unoCommitSeen: true,
        balance: Number.isFinite(balance) ? balance : current.balance,
        phase: reconciled ? 'RECONCILED' : 'UNO COMMITTED',
        message: reconciled
          ? 'Uno commit and guardian reconciliation reports match this transaction ID and amount.'
          : 'Uno reports a commit; waiting for the guardian commit-reconciliation report.'
      };
    }

    if (eventName === 'WITHDRAWAL_DENIED') {
      if (!current) return current;
      if (fields.id && fields.id !== current.id) {
        return mismatch(fields.id, Number(fields.amount), 'Uno denial ID differs from the active HIL transaction.');
      }
      return { ...current, phase: 'DENIED', message: 'Uno reported a withdrawal denial. No desktop virtual-cash update is inferred.' };
    }

    if (eventName === 'GUARDIAN_REVOKED') {
      return current ? {
        ...current,
        phase: 'REVOKED',
        message: 'Uno reported guardian revocation; protected HIL is closed.'
      } : current;
    }
    return current;
  }

  if (device === 'sentinel' && line.startsWith('[PERMIT] One-shot observation issued for ')) {
    const details = line.slice(line.indexOf('for ') + 4).split(';');
    const id = details[0] || '';
    const amount = Number((details[1] || '').replace('amount=', ''));
    if (!current || current.id !== id || current.amount !== amount ||
        ['DENIED', 'REVOKED', 'MISMATCH'].includes(current.phase)) {
      return mismatch(id, amount, 'Guardian permit report does not match the active pending Uno transaction. No desktop virtual-cash update is allowed.');
    }
    return {
      ...current,
      phase: current.unoCommitSeen ? 'UNO COMMITTED' : 'PERMIT OBSERVED',
      message: 'Guardian permit report matches the pending transaction ID and amount; waiting for the Uno commit and guardian reconciliation.'
    };
  }

  if (device === 'sentinel' && line.startsWith('[DENY] ')) {
    const fields = parseKeyValueText(line.slice('[DENY] '.length));
    if (!current) return current;
    if (fields.id && fields.id !== current.id) {
      return mismatch(fields.id, Number(fields.amount), 'Guardian denial ID differs from the active HIL transaction.');
    }
    return {
      ...current,
      phase: 'DENIED',
      message: 'Guardian reported DENY' + (fields.reason ? ': ' + fields.reason : '') + '.'
    };
  }

  const auditMarker = '[AUDIT] Matching controller-reported virtual transaction commit observed';
  if (device === 'sentinel' && line.startsWith(auditMarker)) {
    const idStart = line.indexOf('id=');
    const fields = idStart < 0 ? {} : parseKeyValueText(line.slice(idStart));
    const amount = Number(fields.amount);
    if (!current || !fields.id || current.id !== fields.id || current.amount !== amount ||
        ['DENIED', 'REVOKED', 'MISMATCH'].includes(current.phase)) {
      return mismatch(fields.id || 'UNKNOWN', amount, 'Guardian commit-reconciliation report does not match the active Uno transaction ID and amount.');
    }
    return {
      ...current,
      guardianCommitSeen: true,
      phase: current.unoCommitSeen ? 'RECONCILED' : 'GUARDIAN COMMIT OBSERVED',
      message: current.unoCommitSeen
        ? 'Uno commit and guardian reconciliation reports match this transaction ID and amount.'
        : 'Guardian reports matching commit reconciliation; waiting for the Uno USB commit event before marking the HIL transaction reconciled.'
    };
  }

  return current;
}

export function canBeginHilWithdrawal(current: HilTransaction | null): boolean {
  return current === null || current.phase === 'RECONCILED' || current.phase === 'DENIED';
}

export function redactSensitiveSerialText(line: string): string {
  return line
    .replace(/\bCHANGE_PIN\s+\d{4,6}\s+\d{4,6}\s+\d{4,6}\b/gi, 'CHANGE_PIN [REDACTED]')
    .replace(/\bADD_ACCOUNT\s+\S+\s+\d{4,6}\s+\S+\b/gi, 'ADD_ACCOUNT [REDACTED]')
    .replace(/\bPIN\s+\d{4,6}\b/gi, 'PIN [REDACTED]');
}
