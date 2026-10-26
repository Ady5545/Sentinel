import { describe, expect, it } from 'vitest';
import {
  canRecommissionHilShadow,
  createInitialResearchSession,
  researchPairReady,
  researchSessionReducer,
  replayRunRecords,
  type ResearchSessionState
} from './research-session';

function boardEvent(
  state: ResearchSessionState,
  action: {
    kind: 'opened' | 'closed' | 'error' | 'line' | 'command-written';
    device: 'uno' | 'sentinel';
    sessionId?: string;
    at: number;
    line?: string;
    parsed?: { type: string; phase?: 'BOOTED' | 'HEALTHY' | 'OBSERVING' | 'REVOKED' | 'NEGOTIATING'; eventName?: string; id?: string; amount?: number; balance?: number; reason?: string };
    commandName?: string;
    requestId?: string;
    sensitive?: boolean;
    message?: string;
  }
): ResearchSessionState {
  return researchSessionReducer(state, { type: 'BOARD_EVENT', ...action });
}

function readyCommissionedSession(): ResearchSessionState {
  let s = createInitialResearchSession('RUN-HIL-001', 0, 'HIL');
  s = boardEvent(s, { kind: 'opened', device: 'uno', sessionId: 'uno-session-1', phase: undefined as never, at: 10 });
  s = boardEvent(s, { kind: 'opened', device: 'sentinel', sessionId: 'esp-session-1', phase: undefined as never, at: 11 });
  s = boardEvent(s, { kind: 'line', device: 'uno', sessionId: 'uno-session-1', at: 20,
    line: 'SENTINEL ATM CONTROLLER V3.4 READY', parsed: { type: 'BOARD_BOOT', phase: 'BOOTED' } });
  s = boardEvent(s, { kind: 'line', device: 'sentinel', sessionId: 'esp-session-1', at: 21,
    line: 'SENTINEL ESP32 GUARDIAN V3.4 READY', parsed: { type: 'BOARD_BOOT', phase: 'BOOTED' } });
  s = boardEvent(s, { kind: 'line', device: 'uno', sessionId: 'uno-session-1', at: 100,
    line: '[STATUS_RX] Accepted HEALTHY seq=4', parsed: { type: 'UNO_HEALTHY', phase: 'HEALTHY' } });
  s = boardEvent(s, { kind: 'line', device: 'sentinel', sessionId: 'esp-session-1', at: 110,
    line: 'GUARDIAN_STATUS|mode=OBSERVING', parsed: { type: 'GUARDIAN_OBSERVING', phase: 'OBSERVING' } });
  s = boardEvent(s, { kind: 'line', device: 'uno', sessionId: 'uno-session-1', at: 120,
    line: 'ATM_EVENT|ACCOUNT_PROVISIONED|card=CARD01;balance=50000',
    parsed: { type: 'ATM_EVENT', eventName: 'ACCOUNT_PROVISIONED', balance: 50000 } });
  s = boardEvent(s, { kind: 'line', device: 'uno', sessionId: 'uno-session-1', at: 130,
    line: 'ATM_EVENT|CASH_CONFIGURED|currency=INR;notes500=20;notes200=20;notes100=20;notes50=20;total=17000',
    parsed: { type: 'ATM_EVENT', eventName: 'CASH_CONFIGURED' } });
  return s;
}

function withdrawLifecycle(s: ResearchSessionState): ResearchSessionState {
  s = boardEvent(s, { kind: 'line', device: 'uno', sessionId: 'uno-session-1', at: 200,
    line: 'ATM_EVENT|WITHDRAWAL_PENDING|id=T0000001;amount=500',
    parsed: { type: 'ATM_EVENT', eventName: 'WITHDRAWAL_PENDING', id: 'T0000001', amount: 500 } });
  s = boardEvent(s, { kind: 'line', device: 'sentinel', sessionId: 'esp-session-1', at: 220,
    line: '[PERMIT] One-shot observation issued for T0000001; amount=500',
    parsed: { type: 'PERMIT', id: 'T0000001', amount: 500 } });
  s = boardEvent(s, { kind: 'line', device: 'sentinel', sessionId: 'esp-session-1', at: 240,
    line: '[RECONCILE] Matching controller-reported virtual commit id=T0000001;amount=500',
    parsed: { type: 'COMMIT_RECONCILIATION', id: 'T0000001', amount: 500 } });
  s = boardEvent(s, { kind: 'line', device: 'uno', sessionId: 'uno-session-1', at: 250,
    line: 'ATM_EVENT|WITHDRAWAL_APPROVED|id=T0000001;amount=500;balance=49500',
    parsed: { type: 'ATM_EVENT', eventName: 'WITHDRAWAL_APPROVED', id: 'T0000001', amount: 500, balance: 49500 } });
  return s;
}

describe('coordinated research session', () => {
  it('does not treat the first boot line of a fresh connection as a fault', () => {
    let s = createInitialResearchSession('RUN-BOOT-1', 0, 'HIL');
    s = boardEvent(s, { kind: 'opened', device: 'uno', sessionId: 'uno-1', at: 10 });
    s = boardEvent(s, { kind: 'line', device: 'uno', sessionId: 'uno-1', at: 11,
      line: 'SENTINEL ATM CONTROLLER V3.4 READY', parsed: { type: 'BOARD_BOOT', phase: 'BOOTED' } });
    expect(s.hilFaultLatched).toBe(false);
    expect(s.boardBootEpochs.uno).toBe(1);
  });

  it('changes the shadow exactly once only after the complete same-session lifecycle', () => {
    const commissioned = readyCommissionedSession();
    expect(commissioned.hilShadow.status).toBe('COMMISSIONED');
    expect(commissioned.hilShadow.accountBalance).toBe(50000);
    expect(commissioned.hilShadow.cassetteCash).toBe(17000);
    expect(researchPairReady(commissioned, 150)).toBe(true);

    const reconciled = withdrawLifecycle(commissioned);
    expect(reconciled.hilTransaction?.phase).toBe('RECONCILED');
    expect(reconciled.hilTransaction?.runId).toBe('RUN-HIL-001');
    expect(reconciled.hilTransaction?.unoSessionId).toBe('uno-session-1');
    expect(reconciled.hilTransaction?.sentinelSessionId).toBe('esp-session-1');
    expect(reconciled.hilShadow.accountBalance).toBe(49500);
    expect(reconciled.hilShadow.cassetteCash).toBe(16500);
    expect(reconciled.hilShadow.dispensedTotal).toBe(500);
    expect(reconciled.hilShadow.committedTransactionIds).toEqual(['T0000001']);

    const duplicate = boardEvent(reconciled, { kind: 'line', device: 'sentinel', sessionId: 'esp-session-1', at: 260,
      line: '[RECONCILE] Matching controller-reported virtual commit id=T0000001;amount=500',
      parsed: { type: 'COMMIT_RECONCILIATION', id: 'T0000001', amount: 500 } });
    expect(duplicate.hilShadow.accountBalance).toBe(49500);
    expect(duplicate.hilShadow.cassetteCash).toBe(16500);
    expect(duplicate.hilShadow.dispensedTotal).toBe(500);
    expect(duplicate.hilShadow.committedTransactionIds).toEqual(['T0000001']);
  });

  it('quarantines mismatched IDs and never mutates shadow money', () => {
    const commissioned = readyCommissionedSession();
    let s = boardEvent(commissioned, { kind: 'line', device: 'uno', sessionId: 'uno-session-1', at: 200,
      line: 'ATM_EVENT|WITHDRAWAL_PENDING|id=T0000001;amount=500',
      parsed: { type: 'ATM_EVENT', eventName: 'WITHDRAWAL_PENDING', id: 'T0000001', amount: 500 } });
    s = boardEvent(s, { kind: 'line', device: 'sentinel', sessionId: 'esp-session-1', at: 220,
      line: '[PERMIT] One-shot observation issued for T0000002; amount=500',
      parsed: { type: 'PERMIT', id: 'T0000002', amount: 500 } });
    expect(s.hilFaultLatched).toBe(true);
    expect(s.hilTransaction?.phase).toBe('MISMATCH');
    expect(s.hilShadow.status).toBe('RECONCILIATION REQUIRED');
    expect(s.hilShadow.accountBalance).toBe(50000);
    expect(s.hilShadow.cassetteCash).toBe(17000);
    expect(s.hilShadow.dispensedTotal).toBe(0);
  });

  it('ignores a late serial event from a prior host session', () => {
    let s = readyCommissionedSession();
    s = boardEvent(s, { kind: 'opened', device: 'uno', sessionId: 'uno-session-2', at: 200 });
    const before = s.hilShadow;
    s = boardEvent(s, { kind: 'line', device: 'uno', sessionId: 'uno-session-1', at: 210,
      line: 'ATM_EVENT|WITHDRAWAL_PENDING|id=T0000001;amount=500',
      parsed: { type: 'ATM_EVENT', eventName: 'WITHDRAWAL_PENDING', id: 'T0000001', amount: 500 } });
    expect(s.hilShadow).toBe(before);
    expect(s.records.at(-1)?.kind).toBe('STALE_SESSION_EVENT_IGNORED');
  });

  it('requires both post-fault board boots and fresh paired readiness before recommissioning', () => {
    let s = readyCommissionedSession();
    s = boardEvent(s, { kind: 'line', device: 'sentinel', sessionId: 'esp-session-1', at: 200,
      line: 'GUARDIAN_STATUS|mode=REVOKED', parsed: { type: 'AUTHORITY_REVOKED', phase: 'REVOKED' } });
    expect(s.hilFaultLatched).toBe(true);
    expect(canRecommissionHilShadow(s, 210)).toBe(false);

    s = boardEvent(s, { kind: 'line', device: 'uno', sessionId: 'uno-session-1', at: 220,
      line: 'SENTINEL ATM CONTROLLER V3.4 READY', parsed: { type: 'BOARD_BOOT', phase: 'BOOTED' } });
    s = boardEvent(s, { kind: 'line', device: 'sentinel', sessionId: 'esp-session-1', at: 230,
      line: 'SENTINEL ESP32 GUARDIAN V3.4 READY', parsed: { type: 'BOARD_BOOT', phase: 'BOOTED' } });
    s = boardEvent(s, { kind: 'line', device: 'uno', sessionId: 'uno-session-1', at: 300,
      line: '[STATUS_RX] Accepted HEALTHY', parsed: { type: 'UNO_HEALTHY', phase: 'HEALTHY' } });
    s = boardEvent(s, { kind: 'line', device: 'sentinel', sessionId: 'esp-session-1', at: 310,
      line: 'GUARDIAN_STATUS|mode=OBSERVING', parsed: { type: 'GUARDIAN_OBSERVING', phase: 'OBSERVING' } });
    expect(canRecommissionHilShadow(s, 320)).toBe(true);

    s = researchSessionReducer(s, { type: 'CLEAR_HIL_FAULT', at: 321 });
    expect(s.hilFaultLatched).toBe(false);
    expect(s.hilTransaction).toBeNull();
    expect(s.hilShadow.status).toBe('UNCOMMISSIONED');
    expect(s.records.at(-1)?.kind).toBe('HIL_SHADOW_RESET');
  });

  it('keeps records append-only, versioned and replayable by run ID', () => {
    let s = createInitialResearchSession('RUN-SIM-1', 10, 'SIMULATION');
    const earlierRecords = s.records;
    s = researchSessionReducer(s, {
      type: 'SIMULATION_EVENT', eventKey: 'domain:1',
      event: { id: 'E-1', at: '00:00:01', severity: 'warning', source: 'SENTINEL', title: 'Fixture finding', detail: 'Repeatable scenario observed.' },
      scenario: { id: 'S-001', version: '1.0.0' }, at: 20
    });
    expect(earlierRecords).toHaveLength(1);
    expect(s.records).toHaveLength(2);
    expect(s.records[1].details.scenarioId).toBe('S-001');
    expect(s.records[1].details.scenarioVersion).toBe('1.0.0');
    expect(replayRunRecords(s.records, 'RUN-SIM-1').map(r => r.sequence)).toEqual([1, 2]);

    const switched = researchSessionReducer(s, { type: 'SET_MODE', mode: 'HIL', runId: 'RUN-HIL-2', at: 30 });
    expect(switched.mode).toBe('HIL');
    expect(switched.runId).toBe('RUN-HIL-2');
    expect(replayRunRecords(switched.records, 'RUN-SIM-1')).toHaveLength(2);
  });

  it('does not copy PIN values or raw command arguments into immutable records', () => {
    let s = createInitialResearchSession('RUN-REDACT', 0, 'HIL');
    s = boardEvent(s, { kind: 'command-written', device: 'uno', at: 10, commandName: 'PIN', sensitive: true, requestId: 'req-1' });
    s = boardEvent(s, { kind: 'line', device: 'uno', sessionId: undefined, at: 11,
      line: 'PIN 4826', parsed: { type: 'CONSOLE_LINE' } });
    const serialized = JSON.stringify(s.records);
    expect(serialized.includes('4826')).toBe(false);
    expect(serialized.includes('commandArgs')).toBe(false);
  });
});
