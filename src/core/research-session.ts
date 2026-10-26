import {
  initialHilShadowState,
  invalidateHilShadow,
  reconcileHilShadowCommit,
  reduceHilShadowObservation,
  reduceStructuredHilTransaction,
  redactSensitiveSerialText,
  type HilShadowState,
  type HilTransaction,
  type HilTransactionPhase,
  type StructuredBoardEvent
} from './hil-evidence';

export type ResearchMode = 'SIMULATION' | 'HIL';
export type ResearchSource = 'SYSTEM' | 'SIMULATION' | 'UNO' | 'SENTINEL' | 'HOST';
export type ResearchProvenance = 'SIMULATED' | 'BOARD_REPORTED' | 'HOST_DERIVED';

export interface ResearchRunRecord {
  readonly recordId: string;
  readonly sequence: number;
  readonly runId: string;
  readonly mode: ResearchMode;
  readonly at: number;
  readonly source: ResearchSource;
  readonly kind: string;
  readonly provenance: ResearchProvenance;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
}

export interface CoordinatedHilTransaction extends HilTransaction {
  readonly runId: string;
  readonly unoSessionId: string;
  readonly sentinelSessionId: string;
  readonly startedAtMs: number;
}

export type HilBoardEpochs = { uno: number; sentinel: number };

export interface ResearchSessionState {
  readonly schemaVersion: 1;
  readonly mode: ResearchMode;
  readonly runId: string;
  readonly sequence: number;
  readonly records: readonly ResearchRunRecord[];
  readonly boardSessions: Readonly<Record<'uno' | 'sentinel', string | null>>;
  readonly readinessPhase: Readonly<Record<'uno' | 'sentinel', 'HEALTHY' | 'OBSERVING' | null>>;
  readonly readinessAt: Readonly<Record<'uno' | 'sentinel', number>>;
  readonly boardBootEpochs: Readonly<HilBoardEpochs>;
  readonly faultResetBaseline: Readonly<HilBoardEpochs> | null;
  readonly hilFaultLatched: boolean;
  readonly hilTransaction: CoordinatedHilTransaction | null;
  readonly hilShadow: HilShadowState;
  readonly lastSimulationEventKey: string | null;
}

type BoardDevice = 'uno' | 'sentinel';
type ParsedSerialKind = 'opened' | 'closed' | 'error' | 'line' | 'command-written';

export type ResearchSessionAction =
  | { type: 'SET_MODE'; mode: ResearchMode; runId: string; at: number }
  | {
      type: 'BOARD_EVENT';
      kind: ParsedSerialKind;
      device: BoardDevice;
      sessionId?: string;
      at: number;
      line?: string;
      parsed?: StructuredBoardEvent;
      phase?: string;
      commandName?: string;
      sensitive?: boolean;
      requestId?: string;
      message?: string;
    }
  | {
      type: 'SIMULATION_EVENT';
      eventKey: string;
      event: { id: string; at: string; severity: string; source: string; title: string; detail: string };
      at: number;
      scenario?: { id: string; version: string };
    }
  | { type: 'CLEAR_HIL_FAULT'; at: number }
  | { type: 'APP_RECORD'; kind: string; source: ResearchSource; provenance: ResearchProvenance; details?: Record<string, unknown>; at: number };

const TERMINAL_PHASES = new Set<HilTransactionPhase>(['RECONCILED', 'DENIED', 'MISMATCH', 'REVOKED']);
const RECONCILABLE_PHASES = new Set<HilTransactionPhase>(['RECONCILED', 'DENIED']);

function safeDetails(details: Record<string, unknown> = {}): Readonly<Record<string, string | number | boolean | null>> {
  const safe: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(details)) {
    if (/pin|password|secret|credential|rawcommand|commandargs/i.test(key)) continue;
    if (typeof value === 'string') safe[key] = redactSensitiveSerialText(value).slice(0, 512);
    else if (typeof value === 'number' && Number.isFinite(value)) safe[key] = value;
    else if (typeof value === 'boolean' || value === null) safe[key] = value;
  }
  return Object.freeze(safe);
}

function appendRecord(
  state: ResearchSessionState,
  at: number,
  source: ResearchSource,
  kind: string,
  provenance: ResearchProvenance,
  details: Record<string, unknown> = {},
  runId = state.runId,
  mode = state.mode
): ResearchSessionState {
  const sequence = state.sequence + 1;
  const record: ResearchRunRecord = Object.freeze({
    recordId: runId + ':' + String(sequence).padStart(6, '0'),
    sequence,
    runId,
    mode,
    at,
    source,
    kind,
    provenance,
    details: safeDetails(details)
  });
  return { ...state, sequence, records: [...state.records, record] };
}

function unresolved(tx: HilTransaction | null): boolean {
  return Boolean(tx && !TERMINAL_PHASES.has(tx.phase));
}

function readinessPairAt(state: ResearchSessionState, at: number, ttlMs = 3500): boolean {
  return Boolean(
    state.boardSessions.uno && state.boardSessions.sentinel &&
    state.readinessPhase.uno === 'HEALTHY' && state.readinessPhase.sentinel === 'OBSERVING' &&
    state.readinessAt.uno > 0 && state.readinessAt.sentinel > 0 &&
    at - state.readinessAt.uno >= 0 && at - state.readinessAt.uno <= ttlMs &&
    at - state.readinessAt.sentinel >= 0 && at - state.readinessAt.sentinel <= ttlMs
  );
}

function latchFault(
  state: ResearchSessionState,
  at: number,
  source: ResearchSource,
  kind: string,
  details: Record<string, unknown>,
  reason: string
): ResearchSessionState {
  let next: ResearchSessionState = {
    ...state,
    hilFaultLatched: true,
    faultResetBaseline: state.faultResetBaseline ?? { ...state.boardBootEpochs },
    hilShadow: invalidateHilShadow(state.hilShadow, reason),
    hilTransaction: state.hilTransaction && !TERMINAL_PHASES.has(state.hilTransaction.phase)
      ? { ...state.hilTransaction, phase: 'MISMATCH', message: reason }
      : state.hilTransaction
  };
  next = appendRecord(next, at, source, kind, 'HOST_DERIVED', { ...details, reason });
  return next;
}

export function createInitialResearchSession(
  runId: string,
  at = 0,
  mode: ResearchMode = 'SIMULATION'
): ResearchSessionState {
  const initial: ResearchSessionState = {
    schemaVersion: 1,
    mode,
    runId,
    sequence: 0,
    records: [],
    boardSessions: { uno: null, sentinel: null },
    readinessPhase: { uno: null, sentinel: null },
    readinessAt: { uno: 0, sentinel: 0 },
    boardBootEpochs: { uno: 0, sentinel: 0 },
    faultResetBaseline: null,
    hilFaultLatched: false,
    hilTransaction: null,
    hilShadow: initialHilShadowState(),
    lastSimulationEventKey: null
  };
  return appendRecord(initial, at, 'SYSTEM', 'RUN_STARTED', 'HOST_DERIVED', {
    schemaVersion: 1, mode, runId,
    evidenceLimit: 'Local research record; board-reported lines are not cryptographic attestation.'
  });
}

export function researchPairReady(state: ResearchSessionState, at: number, ttlMs = 3500): boolean {
  return readinessPairAt(state, at, ttlMs);
}

export function canRecommissionHilShadow(state: ResearchSessionState, at: number, ttlMs = 3500): boolean {
  const baseline = state.faultResetBaseline;
  return state.hilFaultLatched && baseline !== null &&
    state.boardBootEpochs.uno > baseline.uno &&
    state.boardBootEpochs.sentinel > baseline.sentinel &&
    readinessPairAt(state, at, ttlMs);
}

export function replayRunRecords(records: readonly ResearchRunRecord[], runId: string): ResearchRunRecord[] {
  return records
    .filter(record => record.runId === runId)
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .map(record => Object.freeze({ ...record, details: safeDetails(record.details) }));
}

function eventSource(device: BoardDevice): ResearchSource {
  return device === 'uno' ? 'UNO' : 'SENTINEL';
}

function isRelevantHilEvent(parsed?: StructuredBoardEvent): boolean {
  return Boolean(parsed && (
    parsed.type === 'PERMIT' ||
    parsed.type === 'DENY' ||
    parsed.type === 'COMMIT_RECONCILIATION' ||
    parsed.type === 'AUTHORITY_REVOKED' ||
    (parsed.type === 'ATM_EVENT' && ['WITHDRAWAL_PENDING', 'WITHDRAWAL_APPROVED', 'WITHDRAWAL_DENIED', 'GUARDIAN_REVOKED'].includes(parsed.eventName || ''))
  ));
}

function withBoundSession(
  tx: HilTransaction,
  state: ResearchSessionState,
  at: number
): CoordinatedHilTransaction | null {
  const unoSessionId = state.boardSessions.uno;
  const sentinelSessionId = state.boardSessions.sentinel;
  if (!unoSessionId || !sentinelSessionId) return null;
  return {
    ...tx,
    runId: state.runId,
    unoSessionId,
    sentinelSessionId,
    startedAtMs: at
  };
}

function mismatchTransaction(
  tx: CoordinatedHilTransaction | HilTransaction,
  reason: string
): CoordinatedHilTransaction {
  return { ...tx, phase: 'MISMATCH', message: reason } as CoordinatedHilTransaction;
}

export function researchSessionReducer(
  state: ResearchSessionState,
  action: ResearchSessionAction
): ResearchSessionState {
  if (action.type === 'SET_MODE') {
    if (action.mode === state.mode) return state;
    if (unresolved(state.hilTransaction)) {
      return appendRecord(state, action.at, 'SYSTEM', 'MODE_SWITCH_BLOCKED', 'HOST_DERIVED', {
        requestedMode: action.mode, reason: 'An HIL transaction is unresolved.'
      });
    }
    if (action.mode === 'HIL' && (state.hilFaultLatched || state.hilShadow.status === 'RECONCILIATION REQUIRED')) {
      return appendRecord(state, action.at, 'SYSTEM', 'MODE_SWITCH_BLOCKED', 'HOST_DERIVED', {
        requestedMode: action.mode, reason: 'HIL fault/reconciliation is latched; both boards must reset and the shadow must be recommissioned.'
      });
    }
    let next = appendRecord(state, action.at, 'SYSTEM', 'RUN_ENDED', 'HOST_DERIVED', {
      runId: state.runId, mode: state.mode, finalShadowStatus: state.hilShadow.status,
      accountBalance: state.hilShadow.accountBalance, cassetteCash: state.hilShadow.cassetteCash,
      dispensedTotal: state.hilShadow.dispensedTotal
    });
    next = {
      ...next, mode: action.mode, runId: action.runId, hilTransaction: null,
      lastSimulationEventKey: null
    };
    return appendRecord(next, action.at, 'SYSTEM', 'RUN_STARTED', 'HOST_DERIVED', {
      schemaVersion: 1, mode: action.mode, runId: action.runId,
      evidenceLimit: 'A mode/run change does not reset connected firmware; board sessions remain explicitly recorded.'
    });
  }

  if (action.type === 'APP_RECORD') {
    return appendRecord(state, action.at, action.source, action.kind, action.provenance, action.details);
  }

  if (action.type === 'SIMULATION_EVENT') {
    if (state.lastSimulationEventKey === action.eventKey) return state;
    let next: ResearchSessionState = {
      ...state,
      lastSimulationEventKey: action.eventKey
    };
    next = appendRecord(next, action.at, 'SIMULATION', 'SIMULATION_EVENT', 'SIMULATED', {
      sourceEventId: action.event.id,
      eventAt: action.event.at,
      severity: action.event.severity,
      title: action.event.title,
      detail: action.event.detail,
      ...(action.scenario ? { scenarioId: action.scenario.id, scenarioVersion: action.scenario.version } : {})
    });
    return next;
  }

  if (action.type === 'CLEAR_HIL_FAULT') {
    if (!canRecommissionHilShadow(state, action.at)) {
      return appendRecord(state, action.at, 'SYSTEM', 'HIL_FAULT_CLEAR_BLOCKED', 'HOST_DERIVED', {
        reason: 'Fault clearance requires both boards to reboot after the fault and fresh paired readiness.'
      });
    }
    let next: ResearchSessionState = {
      ...state,
      hilFaultLatched: false,
      faultResetBaseline: null,
      hilTransaction: null,
      hilShadow: initialHilShadowState()
    };
    next = appendRecord(next, action.at, 'SYSTEM', 'HIL_SHADOW_RESET', 'HOST_DERIVED', {
      reason: 'Both boards rebooted after the fault and fresh paired readiness was observed. The shadow is uncommissioned until new board configuration evidence arrives.'
    });
    return next;
  }

  if (action.type === 'BOARD_EVENT') {
    const source = eventSource(action.device);

    if (action.kind === 'command-written') {
      return appendRecord(state, action.at, source, 'COMMAND_WRITE_DRAINED', 'HOST_DERIVED', {
        commandName: action.commandName || 'UNKNOWN',
        requestId: action.requestId || null,
        sensitive: Boolean(action.sensitive),
        resultLimit: 'Local write/drain only; does not prove board acceptance.'
      });
    }

    if (action.kind === 'opened') {
      const oldSession = state.boardSessions[action.device];
      const changedSession = Boolean(oldSession && action.sessionId && oldSession !== action.sessionId);
      let next: ResearchSessionState = {
        ...state,
        boardSessions: { ...state.boardSessions, [action.device]: action.sessionId || null },
        readinessPhase: { ...state.readinessPhase, [action.device]: null },
        readinessAt: { ...state.readinessAt, [action.device]: 0 }
      };
      next = appendRecord(next, action.at, source, 'BOARD_SESSION_OPENED', 'BOARD_REPORTED', {
        sessionId: action.sessionId || null, phase: action.phase || 'USB OPEN'
      });
      if (changedSession) {
        next = latchFault(next, action.at, source, 'BOARD_SESSION_REPLACED', { sessionId: action.sessionId || null },
          'A board USB session changed. Previous HIL evidence and any commissioned shadow are quarantined.');
      } else if (unresolved(next.hilTransaction)) {
        next = latchFault(next, action.at, source, 'BOARD_SESSION_CHANGED_DURING_TRANSACTION', { sessionId: action.sessionId || null },
          'A board connected while an HIL transaction was unresolved.');
      }
      return next;
    }

    if (action.kind === 'closed' || action.kind === 'error') {
      const activeSession = state.boardSessions[action.device];
      if (activeSession && action.sessionId && activeSession !== action.sessionId) {
        return appendRecord(state, action.at, 'HOST', 'STALE_SESSION_CLOSE_IGNORED', 'HOST_DERIVED', {
          device: action.device, eventSessionId: action.sessionId, activeSessionId: activeSession
        });
      }
      let next: ResearchSessionState = {
        ...state,
        boardSessions: { ...state.boardSessions, [action.device]: null },
        readinessPhase: { ...state.readinessPhase, [action.device]: null },
        readinessAt: { ...state.readinessAt, [action.device]: 0 }
      };
      next = latchFault(next, action.at, source, action.kind === 'closed' ? 'BOARD_SESSION_CLOSED' : 'BOARD_SESSION_ERROR', {
        sessionId: action.sessionId || null, message: action.message || ''
      }, 'A board serial session was lost or errored. HIL shadow and any unresolved HIL transaction are quarantined.');
      return next;
    }

    // An event from an old/unknown host session is recorded, but never allowed
    // to affect readiness, transaction state, or the virtual-cash shadow.
    const activeSession = state.boardSessions[action.device];
    if (!activeSession || !action.sessionId || action.sessionId !== activeSession) {
      return appendRecord(state, action.at, 'HOST', 'STALE_SESSION_EVENT_IGNORED', 'HOST_DERIVED', {
        device: action.device, eventSessionId: action.sessionId || null, activeSessionId: activeSession
      });
    }

    const line = redactSensitiveSerialText(action.line || '');
    const parsed = action.parsed;
    let next: ResearchSessionState = state;

    if (action.kind === 'line' && parsed?.phase) {
      const isReadyPhase = (action.device === 'uno' && parsed.phase === 'HEALTHY') ||
        (action.device === 'sentinel' && parsed.phase === 'OBSERVING');
      next = {
        ...next,
        readinessPhase: {
          ...next.readinessPhase,
          [action.device]: isReadyPhase ? parsed.phase as 'HEALTHY' | 'OBSERVING' : null
        },
        readinessAt: {
          ...next.readinessAt,
          [action.device]: isReadyPhase ? action.at : 0
        }
      };
    }

    next = appendRecord(next, action.at, source, 'BOARD_LINE', 'BOARD_REPORTED', {
      sessionId: action.sessionId, line, parsedType: parsed?.type || 'CONSOLE_LINE',
      eventName: parsed?.eventName || null, transactionId: parsed?.id || null,
      amount: parsed?.amount ?? null, balance: parsed?.balance ?? null
    });

    if (action.kind !== 'line') return next;

    if (parsed?.type === 'BOARD_BOOT') {
      const previousEpoch = next.boardBootEpochs[action.device];
      const boardBootEpochs = { ...next.boardBootEpochs, [action.device]: previousEpoch + 1 };
      next = { ...next, boardBootEpochs };
      const shadowWasEstablished = next.hilShadow.status !== 'UNCOMMISSIONED' ||
        next.hilShadow.accountConfigured || next.hilShadow.cassetteConfigured ||
        next.hilShadow.committedTransactionIds.length > 0;
      const bootInvalidatesAuthority = next.hilFaultLatched || previousEpoch > 0 ||
        shadowWasEstablished || unresolved(next.hilTransaction);
      if (bootInvalidatesAuthority) {
        next = latchFault(next, action.at, source, 'BOARD_BOOT_OBSERVED', {
          sessionId: action.sessionId, device: action.device, bootEpoch: boardBootEpochs[action.device]
        }, 'A board reboot invalidated the RAM-only board configuration and HIL authority for this run.');
      } else {
        next = appendRecord(next, action.at, source, 'INITIAL_BOARD_BOOT', 'BOARD_REPORTED', {
          sessionId: action.sessionId, device: action.device, bootEpoch: boardBootEpochs[action.device]
        });
      }
      return next;
    }

    if (next.mode === 'HIL' && action.device === 'uno' && line.startsWith('ATM_EVENT|')) {
      const shadowBefore = next.hilShadow;
      const shadowAfter = reduceHilShadowObservation(shadowBefore, line);
      if (shadowAfter !== shadowBefore) {
        next = {
          ...next,
          hilShadow: shadowAfter
        };
        next = appendRecord(next, action.at, 'HOST', 'HIL_SHADOW_OBSERVATION', 'HOST_DERIVED', {
          status: shadowAfter.status, accountId: shadowAfter.accountId,
          accountConfigured: shadowAfter.accountConfigured, accountBalance: shadowAfter.accountBalance,
          cassetteCash: shadowAfter.cassetteCash, cassetteConfigured: shadowAfter.cassetteConfigured,
          error: shadowAfter.error
        });
        if (shadowAfter.status === 'RECONCILIATION REQUIRED') {
          next = latchFault(next, action.at, 'HOST', 'HIL_SHADOW_QUARANTINED', {}, shadowAfter.error || 'HIL shadow evidence is inconsistent.');
        }
      }
    }

    if (parsed?.type === 'AUTHORITY_REVOKED') {
      next = latchFault(next, action.at, source, 'GUARDIAN_AUTHORITY_REVOKED', {
        sessionId: action.sessionId, line
      }, 'Guardian authority was revoked; HIL withdrawals remain denied until paired reset and recommissioning.');
      return next;
    }

    if (next.mode !== 'HIL' || !isRelevantHilEvent(parsed)) return next;

    const priorTx = next.hilTransaction;
    if (priorTx && !TERMINAL_PHASES.has(priorTx.phase)) {
      const sessionMismatch = priorTx.runId !== next.runId ||
        priorTx.unoSessionId !== next.boardSessions.uno ||
        priorTx.sentinelSessionId !== next.boardSessions.sentinel ||
        priorTx[(action.device === 'uno' ? 'unoSessionId' : 'sentinelSessionId')] !== action.sessionId;
      if (sessionMismatch) {
        const mismatched = mismatchTransaction(priorTx, 'Board host-session or run identity changed during HIL transaction reconciliation.');
        next = { ...next, hilTransaction: mismatched };
        next = latchFault(next, action.at, source, 'HIL_SESSION_CORRELATION_FAILURE', {
          transactionId: priorTx.id, amount: priorTx.amount, device: action.device, sessionId: action.sessionId
        }, mismatched.message);
        return next;
      }
    }

    let reduced = reduceStructuredHilTransaction(priorTx, action.device, parsed!);
    if (!reduced) return next;

    if (reduced.phase === 'REQUESTED' && (!priorTx || RECONCILABLE_PHASES.has(priorTx.phase))) {
      const bound = withBoundSession(reduced, next, action.at);
      if (!bound || !readinessPairAt(next, action.at)) {
        const rejected = mismatchTransaction({
          ...reduced, runId: next.runId, unoSessionId: next.boardSessions.uno || '',
          sentinelSessionId: next.boardSessions.sentinel || '', startedAtMs: action.at
        }, 'Uno reported a withdrawal request without fresh paired readiness and both active host sessions.');
        next = { ...next, hilTransaction: rejected };
        next = latchFault(next, action.at, 'HOST', 'HIL_REQUEST_WITHOUT_READY_PAIR', {
          transactionId: reduced.id, amount: reduced.amount
        }, rejected.message);
        return next;
      }
      reduced = bound;
    } else if (priorTx && 'runId' in priorTx) {
      reduced = {
        ...reduced,
        runId: priorTx.runId,
        unoSessionId: priorTx.unoSessionId,
        sentinelSessionId: priorTx.sentinelSessionId,
        startedAtMs: priorTx.startedAtMs
      } as CoordinatedHilTransaction;
    }

    if (reduced.phase === 'MISMATCH' || reduced.phase === 'REVOKED') {
      next = { ...next, hilTransaction: reduced as CoordinatedHilTransaction };
      next = latchFault(next, action.at, source, 'HIL_TRANSACTION_FAULT', {
        transactionId: reduced.id, amount: reduced.amount, phase: reduced.phase
      }, reduced.message);
      return next;
    }

    next = { ...next, hilTransaction: reduced as CoordinatedHilTransaction };
    next = appendRecord(next, action.at, 'HOST', 'HIL_TRANSACTION_PHASE', 'HOST_DERIVED', {
      transactionId: reduced.id, amount: reduced.amount, phase: reduced.phase,
      runId: next.runId, unoSessionId: (reduced as CoordinatedHilTransaction).unoSessionId || null,
      sentinelSessionId: (reduced as CoordinatedHilTransaction).sentinelSessionId || null,
      permitSeen: reduced.permitSeen, unoCommitSeen: reduced.unoCommitSeen,
      guardianCommitSeen: reduced.guardianCommitSeen, message: reduced.message
    });

    if (reduced.phase === 'RECONCILED' && priorTx?.phase !== 'RECONCILED') {
      const shadowBefore = next.hilShadow;
      const shadowAfter = reconcileHilShadowCommit(shadowBefore, reduced);
      if (shadowAfter.status === 'RECONCILIATION REQUIRED' || shadowAfter.processedTransactionIds.includes(reduced.id) && !shadowAfter.committedTransactionIds.includes(reduced.id)) {
        next = { ...next, hilShadow: shadowAfter, hilTransaction: mismatchTransaction(reduced as CoordinatedHilTransaction, shadowAfter.error || 'Shadow reconciliation was rejected.') };
        next = latchFault(next, action.at, 'HOST', 'HIL_SHADOW_COMMIT_REJECTED', {
          transactionId: reduced.id, amount: reduced.amount, balance: reduced.balance,
          shadowStatus: shadowAfter.status
        }, shadowAfter.error || 'Shadow reconciliation was rejected.');
        return next;
      }
      next = { ...next, hilShadow: shadowAfter };
      next = appendRecord(next, action.at, 'HOST', 'HIL_SHADOW_COMMIT_APPLIED', 'HOST_DERIVED', {
        transactionId: reduced.id, amount: reduced.amount, accountBalance: shadowAfter.accountBalance,
        cassetteCash: shadowAfter.cassetteCash, dispensedTotal: shadowAfter.dispensedTotal,
        processedTransactionIds: shadowAfter.processedTransactionIds.length,
        committedTransactionIds: shadowAfter.committedTransactionIds.length,
        idempotency: 'Transaction ID is stored in the processed ledger; duplicate reconciliation cannot debit twice.'
      });
    }

    return next;
  }

  return state;
}

/** Versioned, repeatable software-only fixture catalog; board-reported HIL events never use these provenance labels. */
export const RESEARCH_SCENARIO_CATALOG = Object.freeze([
  Object.freeze({
    id: 'S-001',
    version: '1.0.0',
    title: 'Controller compromise / unauthorized dispense',
    provenance: 'SIMULATED' as const,
    description: 'Deterministic local fixture; no real malware or physical dispenser.'
  })
]);
