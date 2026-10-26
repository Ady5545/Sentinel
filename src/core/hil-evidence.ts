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
  permitSeen: boolean;
  unoCommitSeen: boolean;
  guardianCommitSeen: boolean;
  balance?: number;
  message: string;
}

export type BoardRole = 'uno' | 'sentinel';

export interface StructuredBoardEvent {
  type: string;
  eventName?: string;
  id?: string;
  amount?: number;
  balance?: number;
  reason?: string;
}

/**
 * Reduce only whitelisted, already-redacted host parser fields into the HIL lifecycle.
 * This is structured correlation of board-reported evidence, not device attestation.
 */
export function reduceStructuredHilTransaction(
  current: HilTransaction | null,
  device: BoardRole,
  event: StructuredBoardEvent
): HilTransaction | null {
  const amount = event.amount === undefined ? 'INVALID' : String(event.amount);
  const id = event.id || '';
  if (event.type === 'ATM_EVENT' && event.eventName) {
    return reduceHilTransaction(
      current,
      device,
      'ATM_EVENT|' + event.eventName + '|id=' + id + ';amount=' + amount +
        (event.balance === undefined ? '' : ';balance=' + event.balance)
    );
  }
  if (event.type === 'PERMIT') {
    return reduceHilTransaction(current, device, '[PERMIT] One-shot observation issued for ' + id + ';amount=' + amount);
  }
  if (event.type === 'DENY') {
    return reduceHilTransaction(current, device, '[DENY] id=' + id + ';amount=' + amount +
      (event.reason ? ';reason=' + redactSensitiveSerialText(event.reason) : ''));
  }
  if (event.type === 'COMMIT_RECONCILIATION') {
    return reduceHilTransaction(current, device,
      '[AUDIT] Matching controller-reported virtual transaction commit observed;id=' + id + ';amount=' + amount);
  }
  if (event.type === 'AUTHORITY_REVOKED') {
    return reduceHilTransaction(current, device, '[REVOKE]');
  }
  return current;
}

export function parseKeyValueText(value: string): Record<string, string> {
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const part of value.split(';')) {
    const index = part.indexOf('=');
    if (index < 1 || index === part.length - 1 || part.indexOf('=', index + 1) !== -1) return {};
    const key = part.slice(0, index);
    const fieldValue = part.slice(index + 1);
    if (!/^[a-z_]+$/i.test(key) || !/^[A-Za-z0-9_.,:-]+$/.test(fieldValue) || Object.prototype.hasOwnProperty.call(fields, key)) return {};
    fields[key] = fieldValue;
  }
  return fields;
}

function mismatch(id: string, amount: number, message: string): HilTransaction {
  return {
    id: id || 'UNKNOWN',
    amount: Number.isFinite(amount) ? amount : 0,
    phase: 'MISMATCH',
    permitSeen: false,
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
        permitSeen: false,
        unoCommitSeen: false,
        guardianCommitSeen: false,
        message: 'Uno reported a pending fictional withdrawal; waiting for the guardian decision.'
      };
    }

    if (eventName === 'WITHDRAWAL_APPROVED') {
      const amount = Number(fields.amount);
      const balance = Number(fields.balance);
      if (!current || !current.permitSeen || current.id !== fields.id || current.amount !== amount ||
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
      permitSeen: true,
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
    if (!current || !current.permitSeen || !fields.id || current.id !== fields.id || current.amount !== amount ||
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

export type HilBoardResetEpochs = { uno: number; sentinel: number };

/**
 * A mismatch/revocation cannot be cleared just because healthy status reappears.
 * Both controllers must have emitted a new boot/session-start record after the
 * fault was latched, then the host must observe the fresh paired-ready state.
 */
export function canClearHilFaultAfterPairedReset(
  phase: HilTransactionPhase,
  pairReady: boolean,
  faultBaseline: HilBoardResetEpochs | null,
  currentEpochs: HilBoardResetEpochs
): boolean {
  return (phase === 'MISMATCH' || phase === 'REVOKED') &&
    pairReady &&
    faultBaseline !== null &&
    currentEpochs.uno > faultBaseline.uno &&
    currentEpochs.sentinel > faultBaseline.sentinel;
}

export function redactSensitiveSerialText(line: string): string {
  return line
    .replace(/\bCHANGE_PIN\s+\d{4,6}\s+\d{4,6}\s+\d{4,6}\b/gi, 'CHANGE_PIN [REDACTED]')
    .replace(/\bADD_ACCOUNT\s+\S+\s+\d{4,6}\s+\S+\b/gi, 'ADD_ACCOUNT [REDACTED]')
    .replace(/\bPIN\s+\d{4,6}\b/gi, 'PIN [REDACTED]')
    .replace(/\b(pin|old_pin|new_pin)=\d{4,6}\b/gi, '$1=[REDACTED]');
}


export interface HilNoteCounts {
  notes500: number;
  notes200: number;
  notes100: number;
  notes50: number;
}
export type HilShadowStatus = 'UNCOMMISSIONED' | 'COMMISSIONED' | 'RECONCILIATION REQUIRED';
export interface HilShadowState {
  status: HilShadowStatus;
  accountId: string | null;
  accountConfigured: boolean;
  accountBalance: number;
  noteCounts: HilNoteCounts;
  cassetteConfigured: boolean;
  cassetteCash: number;
  dispensedTotal: number;
  processedTransactionIds: string[];
  committedTransactionIds: string[];
  error: string | null;
}

export function initialHilShadowState(): HilShadowState {
  return {
    status: 'UNCOMMISSIONED',
    accountId: null,
    accountConfigured: false,
    accountBalance: 0,
    noteCounts: { notes500: 0, notes200: 0, notes100: 0, notes50: 0 },
    cassetteConfigured: false,
    cassetteCash: 0,
    dispensedTotal: 0,
    processedTransactionIds: [],
    committedTransactionIds: [],
    error: null
  };
}

function finiteInteger(text: string | undefined, max = 1000000): number | null {
  if (text === undefined || !/^(0|[1-9][0-9]*)$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;
}

function noteTotal(counts: HilNoteCounts): number {
  return counts.notes500 * 500 + counts.notes200 * 200 + counts.notes100 * 100 + counts.notes50 * 50;
}

/** Mirror the Uno's bounded denomination planner for a virtual shadow only. */
export function planHilNotes(amount: number, counts: HilNoteCounts): HilNoteCounts | null {
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount % 50 !== 0) return null;
  const max500 = Math.min(Math.floor(amount / 500), counts.notes500);
  for (let n500 = max500; n500 >= 0; n500 -= 1) {
    let remaining = amount - n500 * 500;
    const n200 = Math.min(Math.floor(remaining / 200), counts.notes200);
    remaining -= n200 * 200;
    const n100 = Math.min(Math.floor(remaining / 100), counts.notes100);
    remaining -= n100 * 100;
    if (remaining % 50 !== 0 || remaining / 50 > counts.notes50) continue;
    return { notes500: n500, notes200: n200, notes100: n100, notes50: remaining / 50 };
  }
  return null;
}

export function reduceHilShadowObservation(state: HilShadowState, line: string): HilShadowState {
  if (!line.startsWith('ATM_EVENT|')) return state;
  const [, eventName, ...detailParts] = line.split('|');
  const fields = parseKeyValueText(detailParts.join('|'));

  if (eventName === 'ACCOUNT_PROVISIONED') {
    const balance = finiteInteger(fields.balance);
    if (!fields.card || balance === null) {
      return { ...state, status: 'RECONCILIATION REQUIRED', error: 'Uno reported malformed account-provisioning evidence.' };
    }
    if (state.committedTransactionIds.length > 0 &&
        (state.accountId !== fields.card || state.accountBalance !== balance)) {
      return { ...state, status: 'RECONCILIATION REQUIRED', error: 'Account identity or balance was reprovisioned after a committed HIL withdrawal; desktop shadow changes are frozen.' };
    }
    if (state.status === 'RECONCILIATION REQUIRED') return state;
    return { ...state, status: state.cassetteConfigured ? 'COMMISSIONED' : 'UNCOMMISSIONED',
      accountId: fields.card, accountConfigured: true, accountBalance: balance, error: null };
  }

  if (eventName === 'CASH_CONFIGURED') {
    const notes500 = finiteInteger(fields.notes500, 9999);
    const notes200 = finiteInteger(fields.notes200, 9999);
    const notes100 = finiteInteger(fields.notes100, 9999);
    const notes50 = finiteInteger(fields.notes50, 9999);
    if ([notes500, notes200, notes100, notes50].some(value => value === null)) {
      return { ...state, status: 'RECONCILIATION REQUIRED', error: 'Uno reported cassette configuration without the count fields needed for a verifiable desktop shadow.' };
    }
    const counts = { notes500: notes500!, notes200: notes200!, notes100: notes100!, notes50: notes50! };
    const total = noteTotal(counts);
    const reportedTotal = finiteInteger(fields.total, 100000000);
    if (reportedTotal === null || total !== reportedTotal) {
      return { ...state, status: 'RECONCILIATION REQUIRED', error: 'Reported cassette total does not equal the denomination count total.' };
    }
    if (state.committedTransactionIds.length > 0 && state.cassetteConfigured &&
        (state.noteCounts.notes500 !== counts.notes500 || state.noteCounts.notes200 !== counts.notes200 ||
         state.noteCounts.notes100 !== counts.notes100 || state.noteCounts.notes50 !== counts.notes50)) {
      return { ...state, status: 'RECONCILIATION REQUIRED', error: 'Cassette inventory was reset or changed after a committed HIL withdrawal; desktop shadow changes are frozen.' };
    }
    if (state.status === 'RECONCILIATION REQUIRED') return state;
    return { ...state, status: state.accountConfigured ? 'COMMISSIONED' : 'UNCOMMISSIONED',
      noteCounts: counts, cassetteConfigured: true, cassetteCash: total, error: null };
  }
  return state;
}

/**
 * Apply the desktop-owned virtual shadow gate after exact permit, Uno commit,
 * and guardian reconciliation reports have matched. This never controls physical cash.
 */
/** Quarantine a commissioned shadow after transport, reset, or authority loss. */
export function invalidateHilShadow(state: HilShadowState, reason: string): HilShadowState {
  if (!state.accountConfigured && !state.cassetteConfigured &&
      state.committedTransactionIds.length === 0 && state.status === 'UNCOMMISSIONED') return state;
  return { ...state, status: 'RECONCILIATION REQUIRED', error: reason };
}

export function reconcileHilShadowCommit(state: HilShadowState, transaction: HilTransaction): HilShadowState {
  if (transaction.phase !== 'RECONCILED' ||
      state.processedTransactionIds.includes(transaction.id)) return state;
  const processedTransactionIds = [...state.processedTransactionIds, transaction.id];
  const fail = (message: string): HilShadowState => ({
    ...state,
    status: 'RECONCILIATION REQUIRED',
    processedTransactionIds,
    error: message
  });

  if (!transaction.permitSeen || !transaction.unoCommitSeen || !transaction.guardianCommitSeen) {
    return fail('The HIL lifecycle did not include every required permit/commit/reconciliation observation.');
  }
  if (state.status !== 'COMMISSIONED' || !state.accountConfigured || !state.cassetteConfigured) {
    return fail('A board-reported transaction reconciled before the desktop HIL shadow was fully commissioned. No shadow money was changed.');
  }
  if (!Number.isSafeInteger(transaction.amount) || transaction.amount <= 0 ||
      transaction.amount > state.accountBalance || transaction.amount > state.cassetteCash) {
    return fail('Reconciled transaction amount exceeds the commissioned desktop HIL shadow balance or cassette.');
  }
  const expectedBalance = state.accountBalance - transaction.amount;
  if (transaction.balance !== expectedBalance) {
    return fail('Uno-reported post-commit balance differs from the desktop HIL shadow expectation. Cash shadow was not updated.');
  }
  const plan = planHilNotes(transaction.amount, state.noteCounts);
  if (!plan) {
    return fail('The desktop HIL shadow cannot reproduce the Uno denomination plan. Cash shadow was not updated.');
  }
  return {
    ...state,
    accountBalance: expectedBalance,
    noteCounts: {
      notes500: state.noteCounts.notes500 - plan.notes500,
      notes200: state.noteCounts.notes200 - plan.notes200,
      notes100: state.noteCounts.notes100 - plan.notes100,
      notes50: state.noteCounts.notes50 - plan.notes50
    },
    cassetteCash: state.cassetteCash - transaction.amount,
    dispensedTotal: state.dispensedTotal + transaction.amount,
    processedTransactionIds,
    committedTransactionIds: [...state.committedTransactionIds, transaction.id],
    error: null
  };
}
