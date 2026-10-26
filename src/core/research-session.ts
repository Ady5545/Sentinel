export const RESEARCH_RUN_SCHEMA_VERSION = 1 as const;

export type ResearchMode = 'SOFTWARE_ONLY' | 'HIL';
export type EvidenceProvenance = 'SOFTWARE_SIMULATION' | 'SYNTHETIC_FIXTURE' | 'BOARD_REPORTED' | 'HOST_DERIVED';
export type ResearchRole = 'SYSTEM' | 'ATM' | 'UNO' | 'SENTINEL' | 'LAB';
export type ResearchPhase = 'ACTIVE' | 'FROZEN' | 'CLOSED';
export type CorrelatedPhase = 'IDLE' | 'REQUESTED' | 'PERMITTED' | 'UNO_COMMITTED' | 'RECONCILED' | 'DENIED' | 'MISMATCH' | 'REVOKED';

export interface ResearchEvent {
  readonly seq: number;
  readonly eventId: string;
  readonly at: string;
  readonly sessionId: string;
  readonly role: ResearchRole;
  readonly kind: string;
  readonly provenance: EvidenceProvenance;
  readonly transactionId?: string;
  readonly amount?: number;
  readonly detail: string;
}

export interface ResearchTransaction {
  readonly id: string;
  readonly amount: number;
  readonly phase: CorrelatedPhase;
  readonly permitSeen: boolean;
  readonly unoCommitSeen: boolean;
  readonly guardianAckSeen: boolean;
  readonly postCommitBalance?: number;
}

export interface ResearchRunRecord {
  readonly schemaVersion: typeof RESEARCH_RUN_SCHEMA_VERSION;
  readonly runId: string;
  readonly mode: ResearchMode;
  readonly phase: ResearchPhase;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly boardSessions: Readonly<{ uno: string | null; sentinel: string | null }>;
  readonly activeTransaction: ResearchTransaction | null;
  readonly processedTransactionIds: readonly string[];
  readonly shadowUpdateCount: number;
  readonly freezeReason: string | null;
  readonly events: readonly ResearchEvent[];
}

export type ResearchAction =
  | { type: 'SET_MODE'; mode: ResearchMode; at?: string }
  | { type: 'BOARD_SESSION'; role: 'UNO' | 'SENTINEL'; sessionId: string; at?: string }
  | { type: 'HIL_REQUEST'; sessionId: string; transactionId: string; amount: number; at?: string }
  | { type: 'HIL_PERMIT'; sessionId: string; transactionId: string; amount: number; at?: string }
  | { type: 'UNO_COMMIT'; sessionId: string; transactionId: string; amount: number; balance: number; at?: string }
  | { type: 'GUARDIAN_ACK'; sessionId: string; transactionId: string; amount: number; at?: string }
  | { type: 'HIL_DENY'; role: 'UNO' | 'SENTINEL'; sessionId: string; transactionId: string; amount: number; reason: string; at?: string }
  | { type: 'FAULT'; role: ResearchRole; reason: string; at?: string }
  | { type: 'APP_EVENT'; role: ResearchRole; kind: string; detail: string; provenance: 'SOFTWARE_SIMULATION' | 'HOST_DERIVED'; at?: string };

export function createResearchRun(runId: string, mode: ResearchMode, at = new Date().toISOString()): ResearchRunRecord {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(runId)) throw new Error('Run ID must be a short opaque identifier.');
  return {
    schemaVersion: RESEARCH_RUN_SCHEMA_VERSION, runId, mode, phase: 'ACTIVE', startedAt: at,
    boardSessions: { uno: null, sentinel: null }, activeTransaction: null,
    processedTransactionIds: [], shadowUpdateCount: 0, freezeReason: null, events: []
  };
}

function safeDetail(detail: string): string {
  return detail
    .replace(/\bCHANGE_PIN\s+\d{4,6}\s+\d{4,6}\s+\d{4,6}\b/gi, 'CHANGE_PIN [REDACTED]')
    .replace(/\bADD_ACCOUNT\s+\S+\s+\d{4,6}\s+\S+\b/gi, 'ADD_ACCOUNT [REDACTED]')
    .replace(/\bPIN\s+\d{4,6}\b/gi, 'PIN [REDACTED]')
    .replace(/\b(?:customerPin|pinEntry|demoPin)\s*[:=]\s*\d{4,6}\b/gi, '$1=[REDACTED]');
}

function appendEvent(
  run: ResearchRunRecord,
  role: ResearchRole,
  kind: string,
  detail: string,
  provenance: EvidenceProvenance,
  at: string,
  transactionId?: string,
  amount?: number
): ResearchRunRecord {
  const seq = run.events.length + 1;
  const event: ResearchEvent = Object.freeze({
    seq, eventId: run.runId + ':' + seq, at, sessionId: run.runId, role, kind, provenance,
    ...(transactionId ? { transactionId } : {}),
    ...(amount !== undefined ? { amount } : {}),
    detail: safeDetail(detail)
  });
  return { ...run, events: [...run.events, event] };
}

function freeze(run: ResearchRunRecord, reason: string, at: string, role: ResearchRole): ResearchRunRecord {
  const next = appendEvent({ ...run, phase: 'FROZEN', freezeReason: reason }, role, 'HIL_FROZEN', reason, 'HOST_DERIVED', at);
  return next;
}

function mismatch(run: ResearchRunRecord, id: string, amount: number, reason: string, at: string, role: ResearchRole): ResearchRunRecord {
  const withTx = { ...run, activeTransaction: { id: id || 'UNKNOWN', amount: Number.isSafeInteger(amount) ? amount : 0,
    phase: 'MISMATCH' as const, permitSeen: false, unoCommitSeen: false, guardianAckSeen: false } };
  const logged = appendEvent(withTx, role, 'TRANSACTION_MISMATCH', reason, 'HOST_DERIVED', at, id || 'UNKNOWN', amount);
  return freeze(logged, reason, at, role);
}

/** Single mode/session coordinator. Every transition returns a new run record. */
export function reduceResearchRun(run: ResearchRunRecord, action: ResearchAction): ResearchRunRecord {
  const at = action.at || new Date().toISOString();
  if (run.phase === 'CLOSED') return run;

  if (action.type === 'SET_MODE') {
    if (run.activeTransaction && !['RECONCILED', 'DENIED'].includes(run.activeTransaction.phase)) {
      return freeze(run, 'Mode change attempted while a HIL transaction was unresolved.', at, 'SYSTEM');
    }
    if (run.mode === 'HIL' && action.mode === 'SOFTWARE_ONLY') {
      return appendEvent({ ...run, mode: action.mode, boardSessions: { uno: null, sentinel: null } },
        'SYSTEM', 'MODE_CHANGED', 'Switched to software-only mode; board sessions detached.', 'HOST_DERIVED', at);
    }
    return appendEvent({ ...run, mode: action.mode }, 'SYSTEM', 'MODE_CHANGED', 'Mode set to ' + action.mode + '.', 'HOST_DERIVED', at);
  }

  if (action.type === 'APP_EVENT') {
    return appendEvent(run, action.role, action.kind, action.detail, action.provenance, at);
  }

  if (action.type === 'BOARD_SESSION') {
    if (run.mode !== 'HIL') return appendEvent(run, action.role, 'BOARD_SESSION_IGNORED', 'Board session evidence ignored while mode is SOFTWARE_ONLY.', 'HOST_DERIVED', at);
    const key = action.role === 'UNO' ? 'uno' : 'sentinel';
    const prior = run.boardSessions[key];
    if (prior && prior !== action.sessionId && run.activeTransaction && !['RECONCILED', 'DENIED'].includes(run.activeTransaction.phase)) {
      return freeze(run, 'Board session changed during an unresolved transaction; HIL is quarantined.', at, action.role);
    }
    const next = { ...run, boardSessions: { ...run.boardSessions, [key]: action.sessionId } };
    return appendEvent(next, action.role, 'BOARD_SESSION', 'Observed new board connection session.', 'BOARD_REPORTED', at);
  }

  if (action.type === 'FAULT') return freeze(run, action.reason, at, action.role);

  if (run.mode !== 'HIL') {
    return appendEvent(run, action.type, 'HIL_ACTION_BLOCKED', 'HIL evidence rejected because the run is software-only.', 'HOST_DERIVED', at);
  }
  if (run.phase === 'FROZEN') return run;

  const roleKey = action.type === 'HIL_REQUEST' || action.type === 'UNO_COMMIT' ? 'uno'
    : action.type === 'HIL_PERMIT' || action.type === 'GUARDIAN_ACK' ? 'sentinel'
    : action.role === 'UNO' ? 'uno' : 'sentinel';
  const expectedSession = run.boardSessions[roleKey];
  if (!expectedSession || expectedSession !== action.sessionId) {
    return freeze(run, 'Evidence session ID does not match the currently assigned ' + roleKey.toUpperCase() + ' board session.', at, roleKey === 'uno' ? 'UNO' : 'SENTINEL');
  }
  if (!run.boardSessions.uno || !run.boardSessions.sentinel) {
    return freeze(run, 'Protected HIL requires both assigned board sessions before accepting transaction evidence.', at, roleKey === 'uno' ? 'UNO' : 'SENTINEL');
  }

  if (action.type === 'HIL_REQUEST') {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(action.transactionId) || !Number.isSafeInteger(action.amount) || action.amount <= 0) {
      return mismatch(run, action.transactionId, action.amount, 'Malformed HIL request ID or amount.', at, 'UNO');
    }
    if (run.processedTransactionIds.includes(action.transactionId)) {
      return mismatch(run, action.transactionId, action.amount, 'A previously committed transaction ID was reused; duplicate IDs cannot mutate the shadow again.', at, 'UNO');
    }
    if (run.activeTransaction && !['RECONCILED', 'DENIED'].includes(run.activeTransaction.phase)) {
      return mismatch(run, action.transactionId, action.amount, 'A second HIL request arrived before the prior transaction reached a terminal state.', at, 'UNO');
    }
    const tx: ResearchTransaction = { id: action.transactionId, amount: action.amount, phase: 'REQUESTED', permitSeen: false, unoCommitSeen: false, guardianAckSeen: false };
    return appendEvent({ ...run, activeTransaction: tx }, 'UNO', 'HIL_REQUEST', 'Board-reported withdrawal request.', 'BOARD_REPORTED', at, tx.id, tx.amount);
  }

  if (action.type === 'HIL_PERMIT') {
    const tx = run.activeTransaction;
    if (!tx || tx.id !== action.transactionId || tx.amount !== action.amount || tx.phase !== 'REQUESTED') {
      return mismatch(run, action.transactionId, action.amount, 'Permit did not match the exact active request ID, amount and phase.', at, 'SENTINEL');
    }
    const nextTx = { ...tx, permitSeen: true, phase: 'PERMITTED' as const };
    return appendEvent({ ...run, activeTransaction: nextTx }, 'SENTINEL', 'HIL_PERMIT', 'Guardian permit matched the active request.', 'BOARD_REPORTED', at, tx.id, tx.amount);
  }

  if (action.type === 'UNO_COMMIT') {
    const tx = run.activeTransaction;
    if (tx && tx.phase === 'RECONCILED' && run.processedTransactionIds.includes(tx.id) &&
        tx.id === action.transactionId && tx.amount === action.amount && tx.postCommitBalance === action.balance) return run;
    if (!tx || !tx.permitSeen || tx.id !== action.transactionId || tx.amount !== action.amount ||
        !Number.isSafeInteger(action.balance) || action.balance < 0 ||
        !['PERMITTED', 'RECONCILED'].includes(tx.phase)) {
      return mismatch(run, action.transactionId, action.amount, 'Uno commit did not match a permitted request by ID/amount or reported an invalid balance.', at, 'UNO');
    }
    const nextTx = { ...tx, unoCommitSeen: true, postCommitBalance: action.balance, phase: tx.guardianAckSeen ? 'RECONCILED' as const : 'UNO_COMMITTED' as const };
    const updated = appendEvent({ ...run, activeTransaction: nextTx }, 'UNO', 'UNO_COMMIT', 'Uno commit report matched the active transaction.', 'BOARD_REPORTED', at, tx.id, tx.amount);
    return maybeReconcile(updated, at);
  }

  if (action.type === 'GUARDIAN_ACK') {
    const tx = run.activeTransaction;
    if (tx && tx.phase === 'RECONCILED' && run.processedTransactionIds.includes(tx.id) &&
        tx.id === action.transactionId && tx.amount === action.amount) return run;
    if (!tx || !tx.permitSeen || tx.id !== action.transactionId || tx.amount !== action.amount ||
        !['PERMITTED', 'UNO_COMMITTED', 'RECONCILED'].includes(tx.phase)) {
      return mismatch(run, action.transactionId, action.amount, 'Guardian ACK did not match the permitted transaction by ID and amount.', at, 'SENTINEL');
    }
    const nextTx = { ...tx, guardianAckSeen: true, phase: tx.unoCommitSeen ? 'RECONCILED' as const : 'PERMITTED' as const };
    const updated = appendEvent({ ...run, activeTransaction: nextTx }, 'SENTINEL', 'GUARDIAN_ACK', 'Guardian ACK matched the active transaction.', 'BOARD_REPORTED', at, tx.id, tx.amount);
    return maybeReconcile(updated, at);
  }

  if (action.type === 'HIL_DENY') {
    const tx = run.activeTransaction;
    if (tx && (tx.id !== action.transactionId || tx.amount !== action.amount)) return mismatch(run, action.transactionId, action.amount, 'Denial transaction ID or amount differs from the active transaction.', at, action.role);
    const nextTx: ResearchTransaction = { id: action.transactionId, amount: action.amount, phase: 'DENIED', permitSeen: false, unoCommitSeen: false, guardianAckSeen: false };
    return appendEvent({ ...run, activeTransaction: nextTx }, action.role, 'HIL_DENY', 'Transaction denied: ' + safeDetail(action.reason), 'BOARD_REPORTED', at, action.transactionId, action.amount);
  }

  return run;
}

function maybeReconcile(run: ResearchRunRecord, at: string): ResearchRunRecord {
  const tx = run.activeTransaction;
  if (!tx || tx.phase !== 'RECONCILED') return run;
  // Exact duplicate commit/ACK observations are idempotent: retain the immutable
  // event history, but never increment the shadow update count twice.
  if (run.processedTransactionIds.includes(tx.id)) return run;
  return appendEvent({
    ...run,
    processedTransactionIds: [...run.processedTransactionIds, tx.id],
    shadowUpdateCount: run.shadowUpdateCount + 1
  }, 'SYSTEM', 'HIL_RECONCILED', 'Exact permit, Uno commit and guardian ACK correlated; desktop shadow may apply this transaction exactly once.', 'HOST_DERIVED', at, tx.id, tx.amount);
}

export interface ScenarioStep {
  readonly type: 'REQUEST' | 'PERMIT' | 'UNO_COMMIT' | 'GUARDIAN_ACK' | 'DENY' | 'FAULT';
  readonly id?: string;
  readonly amount?: number;
  readonly balance?: number;
  readonly reason?: string;
}
export interface SyntheticScenario {
  readonly scenarioId: string;
  readonly version: 1;
  readonly title: string;
  readonly description: string;
  readonly expected: 'RECONCILED_ONCE' | 'DENIED_NO_MUTATION' | 'FROZEN_NO_MUTATION';
  readonly steps: readonly ScenarioStep[];
}

export const SYNTHETIC_SCENARIOS: readonly SyntheticScenario[] = Object.freeze([
  Object.freeze({ scenarioId: 'clean-withdrawal', version: 1 as const, title: 'Clean correlated withdrawal',
    description: 'Software-only fixture with matching request, permit, commit and guardian acknowledgement.',
    expected: 'RECONCILED_ONCE' as const,
    steps: Object.freeze([
      { type: 'REQUEST' as const, id: 'SYN-0001', amount: 500 },
      { type: 'PERMIT' as const, id: 'SYN-0001', amount: 500 },
      { type: 'UNO_COMMIT' as const, id: 'SYN-0001', amount: 500, balance: 49500 },
      { type: 'GUARDIAN_ACK' as const, id: 'SYN-0001', amount: 500 }
    ]) }),
  Object.freeze({ scenarioId: 'amount-mismatch', version: 1 as const, title: 'Guardian amount mismatch',
    description: 'Guardian reports an amount different from the active request; no shadow mutation is permitted.',
    expected: 'FROZEN_NO_MUTATION' as const,
    steps: Object.freeze([
      { type: 'REQUEST' as const, id: 'SYN-0002', amount: 500 },
      { type: 'PERMIT' as const, id: 'SYN-0002', amount: 1000 }
    ]) }),
  Object.freeze({ scenarioId: 'denied-withdrawal', version: 1 as const, title: 'Denied withdrawal',
    description: 'A board-reported denial is terminal and cannot mutate the shadow.',
    expected: 'DENIED_NO_MUTATION' as const,
    steps: Object.freeze([
      { type: 'REQUEST' as const, id: 'SYN-0003', amount: 500 },
      { type: 'DENY' as const, id: 'SYN-0003', amount: 500, reason: 'SYNTHETIC_DENIAL' }
    ]) })
]);

/** Deterministic fixture replay is strictly software-only and never calls a hardware adapter. */
export function replaySyntheticScenario(scenario: SyntheticScenario, runId: string, at = '2026-10-27T00:00:00.000Z'): ResearchRunRecord {
  let run = createResearchRun(runId, 'SOFTWARE_ONLY', at);
  run = appendEvent(run, 'LAB', 'SCENARIO_REPLAY_STARTED', scenario.scenarioId + '@v' + scenario.version, 'SYNTHETIC_FIXTURE', at);
  const unoSession = runId + '-fixture-uno';
  const sentinelSession = runId + '-fixture-sentinel';
  // Fixture sessions are explicitly synthetic and exist only inside this software-only run.
  run = { ...run, mode: 'HIL' };
  run = reduceResearchRun(run, { type: 'BOARD_SESSION', role: 'UNO', sessionId: unoSession, at });
  run = reduceResearchRun(run, { type: 'BOARD_SESSION', role: 'SENTINEL', sessionId: sentinelSession, at });
  for (let i = 0; i < scenario.steps.length; i += 1) {
    const step = scenario.steps[i];
    const stepAt = new Date(Date.parse(at) + (i + 1) * 10).toISOString();
    const id = step.id || 'UNKNOWN';
    if (step.type === 'REQUEST') run = reduceResearchRun(run, { type: 'HIL_REQUEST', sessionId: unoSession, transactionId: id, amount: step.amount ?? 0, at: stepAt });
    else if (step.type === 'PERMIT') run = reduceResearchRun(run, { type: 'HIL_PERMIT', sessionId: sentinelSession, transactionId: id, amount: step.amount ?? 0, at: stepAt });
    else if (step.type === 'UNO_COMMIT') run = reduceResearchRun(run, { type: 'UNO_COMMIT', sessionId: unoSession, transactionId: id, amount: step.amount ?? 0, balance: step.balance ?? -1, at: stepAt });
    else if (step.type === 'GUARDIAN_ACK') run = reduceResearchRun(run, { type: 'GUARDIAN_ACK', sessionId: sentinelSession, transactionId: id, amount: step.amount ?? 0, at: stepAt });
    else if (step.type === 'DENY') run = reduceResearchRun(run, { type: 'HIL_DENY', role: 'UNO', sessionId: unoSession, transactionId: id, amount: step.amount ?? 0, reason: step.reason || 'SYNTHETIC_DENIAL', at: stepAt });
    else if (step.type === 'FAULT') run = reduceResearchRun(run, { type: 'FAULT', role: 'LAB', reason: step.reason || 'SYNTHETIC_FAULT', at: stepAt });
  }
  const fixtureEvents = run.events.map(event => Object.freeze({
    ...event,
    provenance: event.role === 'UNO' || event.role === 'SENTINEL' ? 'SYNTHETIC_FIXTURE' as const : event.provenance
  }));
  run = { ...run, mode: 'SOFTWARE_ONLY', events: fixtureEvents };
  return appendEvent(run, 'LAB', 'SCENARIO_REPLAY_FINISHED',
    'Fixture replay completed; all board-like events are labelled SYNTHETIC_FIXTURE, not physical board evidence.', 'SYNTHETIC_FIXTURE',
    new Date(Date.parse(at) + (scenario.steps.length + 2) * 10).toISOString());
}

export function researchRunToCsv(run: ResearchRunRecord): string {
  const cell = (value: unknown) => '"' + String(value ?? '').replace(/"/g, '""') + '"';
  return [
    'seq,eventId,at,sessionId,role,kind,provenance,transactionId,amount,detail',
    ...run.events.map(event => [event.seq,event.eventId,event.at,event.sessionId,event.role,event.kind,event.provenance,event.transactionId,event.amount,event.detail].map(cell).join(','))
  ].join('\r\n');
}

export function researchRunToJson(run: ResearchRunRecord): string {
  return JSON.stringify(run, null, 2);
}
