import type { HilTransaction } from './hil-evidence';

export type HilTerminalScreen = 'welcome' | 'pin' | 'menu' | 'pending' | 'receipt' | 'lockdown';

export interface HilTerminalState {
  screen: HilTerminalScreen;
  message: string;
  boardBalance: number | null;
  lastTransactionId: string | null;
}

function parseFields(text: string): Record<string, string> {
  return Object.fromEntries(text.split(';').flatMap(part => {
    const index = part.indexOf('=');
    return index > 0 ? [[part.slice(0, index), part.slice(index + 1)]] : [];
  }));
}

export function initialHilTerminalState(): HilTerminalState {
  return {
    screen: 'welcome',
    message: 'Hardware terminal is idle. Connect both boards and wait for accepted HEALTHY / OBSERVING evidence.',
    boardBalance: null,
    lastTransactionId: null
  };
}

/**
 * Read-only HIL customer-screen model. Console lines are board-reported input;
 * this reducer never authorizes or mutates local simulation money.
 */
export function reduceHilTerminalLine(current: HilTerminalState, device: 'uno' | 'sentinel', line: string): HilTerminalState {
  if (!line) return current;

  if (line.includes('[SECURITY_LOCK]') || line.includes('[REVOKE]') ||
      line.includes('GUARDIAN_STATUS|mode=REVOKED') || line.includes('GUARDIAN_REVOKED')) {
    return { ...current, screen: 'lockdown',
      message: 'A board reported lock/revocation. Protected HIL is closed; pair-reset and recommission before continuing.' };
  }

  if (line.includes('SENTINEL ATM CONTROLLER V3.3 READY') ||
      line.includes('SENTINEL ESP32 GUARDIAN V3.3 READY') || line.startsWith('SESSION: ')) {
    if (current.screen === 'pending') {
      return { ...current, screen: 'lockdown',
        message: 'A board restarted during an unresolved transaction. The previous session/decision is invalid; reconcile and recommission.' };
    }
    return { ...current, screen: 'welcome', boardBalance: null, lastTransactionId: null,
      message: 'A new board session was observed. Recommission RAM-only demo state and re-establish pair readiness.' };
  }

  if (device !== 'uno' || !line.startsWith('ATM_EVENT|')) return current;
  const [, eventName, ...detailParts] = line.split('|');
  const fields = parseFields(detailParts.join('|'));

  switch (eventName) {
    case 'PIN_REQUIRED':
      return { ...current, screen: 'pin', message: 'Uno reports the demo card was accepted. Enter the fictional PIN for this test account.' };
    case 'AUTHENTICATED':
      return { ...current, screen: 'menu', message: 'Uno reports successful demo authentication. This is board-reported evidence, not PIN-pad attestation.' };
    case 'PIN_FAILED':
    case 'PIN_REJECTED':
      return { ...current, screen: 'pin', message: 'Uno rejected the demo PIN. Check the fictional test PIN or configured lockout.' };
    case 'CARD_REJECTED':
      return { ...current, screen: 'welcome', message: 'Uno rejected the demo card/session. Confirm the fictional account was provisioned.' };
    case 'BALANCE': {
      const balance = Number(fields.amount);
      if (!Number.isSafeInteger(balance) || balance < 0) {
        return { ...current, screen: 'receipt', message: 'Uno returned an invalid balance value. Do not display it as a verified balance.' };
      }
      return { ...current, screen: 'receipt', boardBalance: balance,
        message: 'Uno-reported balance received. The local simulation ledger was not substituted.' };
    }
    case 'WITHDRAWAL_PENDING': {
      const amount = Number(fields.amount);
      if (!fields.id || !Number.isSafeInteger(amount) || amount <= 0) {
        return { ...current, screen: 'lockdown', message: 'Uno reported malformed pending-transaction evidence. Protected HIL is blocked.' };
      }
      return { ...current, screen: 'pending', lastTransactionId: fields.id,
        message: 'Uno reported transaction ' + fields.id + ' for ₹' + amount.toLocaleString('en-IN') +
          '. Waiting for the correlated guardian decision and commit reconciliation.' };
    }
    case 'WITHDRAWAL_APPROVED': {
      const balance = Number(fields.balance);
      return { ...current, screen: 'pending', lastTransactionId: fields.id || current.lastTransactionId,
        boardBalance: Number.isSafeInteger(balance) && balance >= 0 ? balance : current.boardBalance,
        message: 'Uno reports an internal virtual commit. Do not display dispense success until guardian reconciliation matches the same ID and amount.' };
    }
    case 'WITHDRAWAL_DENIED':
      return { ...current, screen: 'receipt', lastTransactionId: fields.id || current.lastTransactionId,
        message: 'Uno reported withdrawal denial. No desktop virtual cash is released.' };
    case 'BALANCE_DENIED':
    case 'PIN_TIMEOUT':
    case 'SESSION_TIMEOUT':
    case 'SESSION_CANCELLED':
    case 'LOGOUT':
      return { ...current, screen: 'welcome', message: 'Uno reported ' + eventName + '. The operation was denied or the customer session ended.' };
    case 'GUARDIAN_REVOKED':
      return { ...current, screen: 'lockdown', message: 'Uno reported guardian revocation. Protected HIL is closed until pair reset/recommission.' };
    default:
      return current;
  }
}

export function applyHilTransactionStatus(current: HilTerminalState, transaction: HilTransaction | null): HilTerminalState {
  if (!transaction) return current;
  if (transaction.phase === 'RECONCILED') {
    return { ...current, screen: 'receipt', boardBalance: transaction.balance ?? current.boardBalance,
      lastTransactionId: transaction.id,
      message: 'Transaction ' + transaction.id + ' was correlated by ID and amount across the Uno commit and guardian reconciliation. This is board-reported evidence, not cryptographic attestation.' };
  }
  if (transaction.phase === 'DENIED') {
    return { ...current, screen: 'receipt', lastTransactionId: transaction.id,
      message: 'Transaction ' + transaction.id + ' was denied. Desktop virtual inventory must remain unchanged.' };
  }
  if (transaction.phase === 'REVOKED' || transaction.phase === 'MISMATCH') {
    return { ...current, screen: 'lockdown', lastTransactionId: transaction.id,
      message: transaction.message + ' No desktop virtual-cash mutation is permitted.' };
  }
  if (['REQUESTED', 'PERMIT OBSERVED', 'UNO COMMITTED', 'GUARDIAN COMMIT OBSERVED'].includes(transaction.phase)) {
    return { ...current, screen: 'pending', lastTransactionId: transaction.id,
      message: transaction.message + ' The desktop must wait; no cash result is final yet.' };
  }
  return current;
}
