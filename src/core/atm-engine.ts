export type SecurityMode = 'baseline' | 'protected';
export type TerminalScreen = 'welcome' | 'pin' | 'menu' | 'amount' | 'receipt' | 'statement' | 'locked' | 'lockdown';
export type Service = 'withdrawal' | 'balance' | 'statement' | 'transfer' | 'pin-change';
export type Severity = 'info' | 'success' | 'warning' | 'critical';
export type SentinelStatus = 'MONITORING' | 'SUSPECT' | 'AUTHORITY REVOKED';
export type Decision = 'NONE' | 'PERMIT' | 'REVOKE' | 'BLOCK';

export interface JournalEvent {
  id: string;
  at: string;
  severity: Severity;
  source: 'ATM' | 'UNO' | 'SENTINEL' | 'DISPENSER' | 'SYSTEM';
  title: string;
  detail: string;
}
export interface TransactionRecord {
  id: string;
  at: string;
  type: 'withdrawal' | 'transfer' | 'balance' | 'statement';
  amount: number;
  result: 'completed' | 'denied';
  reference: string;
}
export interface ControllerEvidence {
  expectedProfile: string;
  reportedProfile: string;
  privilegedPathRequested: boolean;
  maintenanceWindowOpen: boolean;
  observedSequence: number;
  expectedSequence: number;
  heartbeatAgeMs: number;
  heartbeatLimitMs: number;
  frameFresh: boolean;
  legalStateTransition: boolean;
}
export interface AtmState {
  mode: SecurityMode;
  screen: TerminalScreen;
  service: Service | null;
  pinBuffer: string;
  failedPinAttempts: number;
  authenticated: boolean;
  accountId: string;
  accountBalance: number;
  cassetteCash: number;
  dispensedTotal: number;
  selectedAmount: number;
  receiptMessage: string;
  lastTransaction: TransactionRecord | null;
  transactions: TransactionRecord[];
  controllerState: 'READY' | 'COMPROMISED' | 'LOCKED';
  sentinelStatus: SentinelStatus;
  lastDecision: Decision;
  findings: string[];
  scenarioApplied: boolean;
  events: JournalEvent[];
}
export type AtmAction =
  | { type: 'SET_MODE'; mode: SecurityMode }
  | { type: 'INSERT_CARD' }
  | { type: 'PIN_DIGIT'; digit: string }
  | { type: 'PIN_BACKSPACE' }
  | { type: 'PIN_CLEAR' }
  | { type: 'PIN_SUBMIT' }
  | { type: 'SELECT_SERVICE'; service: Service }
  | { type: 'SELECT_AMOUNT'; amount: number }
  | { type: 'CONFIRM_AMOUNT' }
  | { type: 'RETURN_TO_MENU' }
  | { type: 'CANCEL_SESSION' }
  | { type: 'RUN_COMPROMISE_SCENARIO' }
  | { type: 'RESET_SCENARIO' };

const START_BALANCE = 25000;
const START_CASSETTE_CASH = 50000;
const TEST_UNAUTHORIZED_AMOUNT = 2000;
const VALID_DEMO_PIN = '1234';
const timeLabel = () => new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const makeId = (prefix: string) => prefix + '-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();

function pushEvent(state: AtmState, severity: Severity, source: JournalEvent['source'], title: string, detail: string): JournalEvent[] {
  return [...state.events, { id: makeId('EVT'), at: timeLabel(), severity, source, title, detail }].slice(-250);
}
function updateWithEvent(state: AtmState, severity: Severity, source: JournalEvent['source'], title: string, detail: string, changes: Partial<AtmState> = {}): AtmState {
  return { ...state, ...changes, events: pushEvent(state, severity, source, title, detail) };
}
export function initialAtmState(mode: SecurityMode = 'protected'): AtmState {
  const initial: AtmState = {
    mode, screen: 'welcome', service: null, pinBuffer: '', failedPinAttempts: 0, authenticated: false,
    accountId: 'SIM-1001', accountBalance: START_BALANCE, cassetteCash: START_CASSETTE_CASH,
    dispensedTotal: 0, selectedAmount: 1000, receiptMessage: '', lastTransaction: null, transactions: [],
    controllerState: 'READY', sentinelStatus: 'MONITORING', lastDecision: 'NONE', findings: [],
    scenarioApplied: false, events: []
  };
  initial.events = pushEvent(initial, 'info', 'SYSTEM', 'ATM emulator initialized', 'Offline research simulation ready. All accounts, peripherals and cash are virtual.');
  return initial;
}
export function assessControllerEvidence(evidence: ControllerEvidence): string[] {
  const findings: string[] = [];
  if (evidence.reportedProfile !== evidence.expectedProfile) findings.push('Reported controller profile differs from the configured reference (weak, self-reported signal).');
  if (evidence.privilegedPathRequested && !evidence.maintenanceWindowOpen) findings.push('Privileged service path is active outside the configured maintenance window.');
  if (evidence.observedSequence !== evidence.expectedSequence) findings.push('Observed controller sequence does not match the expected sequence.');
  if (evidence.heartbeatAgeMs > evidence.heartbeatLimitMs) findings.push('Controller heartbeat exceeded the configured freshness limit.');
  if (!evidence.frameFresh) findings.push('Controller message is stale or has already been observed in this session.');
  if (!evidence.legalStateTransition) findings.push('Controller requested a transition that is not legal from the prior state.');
  return findings;
}
function createTransaction(type: TransactionRecord['type'], amount: number, result: TransactionRecord['result']): TransactionRecord {
  return { id: makeId('TXN'), at: timeLabel(), type, amount, result, reference: makeId('REF') };
}
export function atmReducer(state: AtmState, action: AtmAction): AtmState {
  switch (action.type) {
    case 'SET_MODE': {
      const next = initialAtmState(action.mode);
      next.events = pushEvent(state, 'info', 'SYSTEM', action.mode === 'protected' ? 'SENTINEL protected mode selected' : 'Unprotected baseline selected',
        action.mode === 'protected' ? 'The virtual dispenser enforces the Sentinel authority decision.' : 'Independent guardian enforcement is bypassed for this virtual comparison only.');
      return { ...next, events: next.events.slice(-250) };
    }
    case 'INSERT_CARD':
      if (state.screen !== 'welcome' || state.sentinelStatus === 'AUTHORITY REVOKED') return state;
      return updateWithEvent(state, 'info', 'ATM', 'Virtual card inserted', 'Demo account ' + state.accountId + ' selected. No physical card is read.',
        { screen: 'pin', pinBuffer: '', failedPinAttempts: 0, authenticated: false, service: null, receiptMessage: '' });
    case 'PIN_DIGIT':
      if (state.screen !== 'pin' || !/^[0-9]$/.test(action.digit) || state.pinBuffer.length >= 4) return state;
      return { ...state, pinBuffer: state.pinBuffer + action.digit };
    case 'PIN_BACKSPACE':
      return state.screen === 'pin' ? { ...state, pinBuffer: state.pinBuffer.slice(0, -1) } : state;
    case 'PIN_CLEAR':
      return state.screen === 'pin' ? { ...state, pinBuffer: '' } : state;
    case 'PIN_SUBMIT':
      if (state.screen !== 'pin') return state;
      if (state.pinBuffer === VALID_DEMO_PIN) {
        return updateWithEvent(state, 'success', 'ATM', 'Demo authentication accepted', 'Synthetic account access granted. PIN digits are not recorded.',
          { screen: 'menu', authenticated: true, pinBuffer: '', failedPinAttempts: 0, receiptMessage: '' });
      } else {
        const attempts = state.failedPinAttempts + 1;
        const locked = attempts >= 3;
        return updateWithEvent(state, locked ? 'critical' : 'warning', 'ATM', locked ? 'Demo account locked' : 'Demo authentication rejected',
          locked ? 'The retry limit was reached. End the synthetic session to continue.' : 'Incorrect demo PIN. PIN content is deliberately not written to the journal.',
          { screen: locked ? 'locked' : 'pin', pinBuffer: '', failedPinAttempts: attempts, authenticated: false });
      }
    case 'SELECT_SERVICE': {
      if (state.screen !== 'menu' || !state.authenticated) return state;
      if (action.service === 'balance') {
        const txn = createTransaction('balance', 0, 'completed');
        return updateWithEvent(state, 'success', 'ATM', 'Balance inquiry completed', 'Available demo balance: ₹' + state.accountBalance.toLocaleString('en-IN') + '.',
          { screen: 'receipt', service: 'balance', lastTransaction: txn, transactions: [...state.transactions, txn], receiptMessage: 'AVAILABLE BALANCE\n₹' + state.accountBalance.toLocaleString('en-IN') });
      }
      if (action.service === 'statement') {
        return updateWithEvent(state, 'info', 'ATM', 'Mini statement requested', 'The synthetic account statement is displayed locally.', { screen: 'statement', service: 'statement' });
      }
      if (action.service === 'pin-change') {
        return updateWithEvent(state, 'info', 'ATM', 'PIN-change demonstration', 'No persistent PIN is changed or stored by this demonstration.',
          { screen: 'receipt', service: 'pin-change', receiptMessage: 'PIN CHANGE DEMONSTRATION\nNo persistent PIN was changed.' });
      }
      return { ...state, screen: 'amount', service: action.service, selectedAmount: 1000, receiptMessage: '' };
    }
    case 'SELECT_AMOUNT':
      if (state.screen !== 'amount' || ![500, 1000, 2000, 5000].includes(action.amount)) return state;
      return { ...state, selectedAmount: action.amount };
    case 'CONFIRM_AMOUNT': {
      if (state.screen !== 'amount' || !state.authenticated || !state.service) return state;
      const amount = state.selectedAmount;
      if (amount <= 0 || amount > state.accountBalance) {
        return updateWithEvent(state, 'warning', 'ATM', 'Transaction rejected: insufficient balance', 'No account or cassette state changed.',
          { screen: 'receipt', receiptMessage: 'TRANSACTION DECLINED\nInsufficient available balance.' });
      }
      if (state.service === 'withdrawal') {
        if (state.sentinelStatus === 'AUTHORITY REVOKED' && state.mode === 'protected') {
          return updateWithEvent(state, 'critical', 'DISPENSER', 'Withdrawal denied by authority gate', 'SENTINEL revoked controller authority. Inventory and account balance are unchanged.',
            { screen: 'lockdown', lastDecision: 'BLOCK', receiptMessage: 'SECURITY LOCKDOWN\nCash dispensing is blocked.' });
        }
        if (amount > state.cassetteCash) {
          return updateWithEvent(state, 'warning', 'DISPENSER', 'Dispenser inventory insufficient', 'The cassette model cannot satisfy this request. No cash was dispensed.',
            { screen: 'receipt', receiptMessage: 'TRANSACTION DECLINED\nATM cash inventory is insufficient.' });
        }
        const txn = createTransaction('withdrawal', amount, 'completed');
        return updateWithEvent(state, 'success', 'DISPENSER', 'Virtual cash dispensed', '₹' + amount.toLocaleString('en-IN') + ' released by the virtual dispenser gate. No physical cash exists.',
          { screen: 'receipt', accountBalance: state.accountBalance - amount, cassetteCash: state.cassetteCash - amount, dispensedTotal: state.dispensedTotal + amount,
            lastTransaction: txn, transactions: [...state.transactions, txn], lastDecision: state.mode === 'protected' ? 'PERMIT' : 'NONE',
            receiptMessage: 'WITHDRAWAL COMPLETE\n₹' + amount.toLocaleString('en-IN') + '\nReference ' + txn.reference });
      }
      if (state.service === 'transfer') {
        const txn = createTransaction('transfer', amount, 'completed');
        return updateWithEvent(state, 'success', 'ATM', 'Local transfer simulation completed', '₹' + amount.toLocaleString('en-IN') + ' moved to fictional beneficiary DEMO-2042. No banking network is used.',
          { screen: 'receipt', accountBalance: state.accountBalance - amount, lastTransaction: txn, transactions: [...state.transactions, txn],
            receiptMessage: 'TRANSFER SIMULATED\n₹' + amount.toLocaleString('en-IN') + '\nTo DEMO-2042\nReference ' + txn.reference });
      }
      return state;
    }
    case 'RETURN_TO_MENU':
      if (!state.authenticated || state.sentinelStatus === 'AUTHORITY REVOKED') return state;
      return { ...state, screen: 'menu', service: null, receiptMessage: '' };
    case 'CANCEL_SESSION':
      return updateWithEvent(state, 'info', 'ATM', 'Customer session ended', 'Virtual card returned and session state cleared.',
        { screen: 'welcome', service: null, pinBuffer: '', authenticated: false, failedPinAttempts: 0, receiptMessage: '' });
    case 'RUN_COMPROMISE_SCENARIO': {
      if (state.scenarioApplied) return state;
      const evidence: ControllerEvidence = {
        expectedProfile: 'UNO-LAB-01', reportedProfile: 'UNO-LAB-01/ALTERED',
        privilegedPathRequested: true, maintenanceWindowOpen: false,
        observedSequence: 43, expectedSequence: 42, heartbeatAgeMs: 5200,
        heartbeatLimitMs: 3000, frameFresh: false, legalStateTransition: false
      };
      const findings = assessControllerEvidence(evidence);
      let next = updateWithEvent(state, 'warning', 'UNO', 'Controlled compromise fixture injected',
        'The fixture supplies profile mismatch, out-of-window privileged state, sequence divergence, stale heartbeat/frame and illegal transition. These are simulated inputs.',
        { controllerState: 'COMPROMISED', scenarioApplied: true });
      if (state.mode === 'baseline') {
        return updateWithEvent(next, 'critical', 'DISPENSER', 'Baseline accepted unauthorized dispense request',
          'No independent Sentinel gate is enforced in baseline mode. ₹2,000 of virtual cassette cash was released; the synthetic account ledger was not debited by this controlled fixture.',
          { cassetteCash: Math.max(0, next.cassetteCash - TEST_UNAUTHORIZED_AMOUNT), dispensedTotal: next.dispensedTotal + TEST_UNAUTHORIZED_AMOUNT, lastDecision: 'NONE', findings: [] });
      }
      if (findings.length > 0) {
        next = updateWithEvent(next, 'critical', 'SENTINEL', 'Controller authority revoked', findings.join(' '),
          { sentinelStatus: 'AUTHORITY REVOKED', lastDecision: 'REVOKE', findings, screen: 'lockdown' });
        return updateWithEvent(next, 'success', 'DISPENSER', 'Unauthorized dispense blocked',
          'The authoritative virtual gate denied ₹2,000. Account balance and cassette inventory did not change.');
      }
      return updateWithEvent(next, 'success', 'SENTINEL', 'Evidence check passed', 'No configured controller-integrity rule was violated.', { lastDecision: 'PERMIT' });
    }
    case 'RESET_SCENARIO': {
      const next = initialAtmState(state.mode);
      next.events = pushEvent(state, 'info', 'SYSTEM', 'Experiment state reset',
        'Synthetic balance, cassette inventory, session, controller and Sentinel state restored. Previous run events remain in the journal.');
      return { ...next, events: next.events.slice(-250) };
    }
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}
