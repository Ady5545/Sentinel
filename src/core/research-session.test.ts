import { describe, expect, it } from 'vitest';
import {
  createResearchRun,
  reduceResearchRun,
  replaySyntheticScenario,
  researchRunToCsv,
  researchRunToJson,
  SYNTHETIC_SCENARIOS
} from './research-session';

const at = '2026-10-27T00:00:00.000Z';
function readyRun(runId = 'run-test') {
  let run = createResearchRun(runId, 'HIL', at);
  run = reduceResearchRun(run, { type: 'BOARD_SESSION', role: 'UNO', sessionId: 'uno-session-1', at });
  run = reduceResearchRun(run, { type: 'BOARD_SESSION', role: 'SENTINEL', sessionId: 'sentinel-session-1', at });
  return run;
}
function cleanTransaction(run = readyRun()) {
  run = reduceResearchRun(run, { type: 'HIL_REQUEST', sessionId: 'uno-session-1', transactionId: 'TX-1', amount: 500, at });
  run = reduceResearchRun(run, { type: 'HIL_PERMIT', sessionId: 'sentinel-session-1', transactionId: 'TX-1', amount: 500, at });
  run = reduceResearchRun(run, { type: 'UNO_COMMIT', sessionId: 'uno-session-1', transactionId: 'TX-1', amount: 500, balance: 49500, at });
  run = reduceResearchRun(run, { type: 'GUARDIAN_ACK', sessionId: 'sentinel-session-1', transactionId: 'TX-1', amount: 500, at });
  return run;
}

describe('Quarter 3 research session coordinator', () => {
  it('requires exact board session IDs and blocks hardware evidence in software-only mode', () => {
    const software = createResearchRun('software-only', 'SOFTWARE_ONLY', at);
    const blocked = reduceResearchRun(software, { type: 'HIL_REQUEST', sessionId: 'uno-session-1', transactionId: 'TX-1', amount: 500, at });
    expect(blocked.mode).toBe('SOFTWARE_ONLY');
    expect(blocked.events.at(-1)?.kind).toBe('HIL_ACTION_BLOCKED');

    const run = readyRun();
    const stale = reduceResearchRun(run, { type: 'HIL_REQUEST', sessionId: 'old-uno-session', transactionId: 'TX-1', amount: 500, at });
    expect(stale.phase).toBe('FROZEN');
    expect(stale.shadowUpdateCount).toBe(0);
  });

  it('reconciles one exact transaction and increments the shadow mutation count once', () => {
    const run = cleanTransaction();
    expect(run.activeTransaction?.phase).toBe('RECONCILED');
    expect(run.processedTransactionIds).toEqual(['TX-1']);
    expect(run.shadowUpdateCount).toBe(1);
    expect(run.phase).toBe('ACTIVE');
  });

  it('treats duplicate commit/ACK observations idempotently and rejects reuse of a committed ID', () => {
    let run = cleanTransaction();
    const eventCount = run.events.length;
    run = reduceResearchRun(run, { type: 'GUARDIAN_ACK', sessionId: 'sentinel-session-1', transactionId: 'TX-1', amount: 500, at });
    expect(run.shadowUpdateCount).toBe(1);
    expect(run.events.length).toBe(eventCount);

    run = reduceResearchRun(run, { type: 'HIL_REQUEST', sessionId: 'uno-session-1', transactionId: 'TX-1', amount: 500, at });
    expect(run.phase).toBe('FROZEN');
    expect(run.shadowUpdateCount).toBe(1);
  });

  it('freezes on transaction ID/amount mismatch and never changes the shadow', () => {
    let run = readyRun();
    run = reduceResearchRun(run, { type: 'HIL_REQUEST', sessionId: 'uno-session-1', transactionId: 'TX-2', amount: 500, at });
    run = reduceResearchRun(run, { type: 'HIL_PERMIT', sessionId: 'sentinel-session-1', transactionId: 'TX-2', amount: 1000, at });
    expect(run.phase).toBe('FROZEN');
    expect(run.activeTransaction?.phase).toBe('MISMATCH');
    expect(run.shadowUpdateCount).toBe(0);
    expect(run.freezeReason).toContain('exact active request ID, amount and phase');
  });

  it('freezes if a board session changes during an unresolved transaction', () => {
    let run = readyRun();
    run = reduceResearchRun(run, { type: 'HIL_REQUEST', sessionId: 'uno-session-1', transactionId: 'TX-3', amount: 500, at });
    run = reduceResearchRun(run, { type: 'BOARD_SESSION', role: 'UNO', sessionId: 'uno-session-2', at });
    expect(run.phase).toBe('FROZEN');
    expect(run.shadowUpdateCount).toBe(0);
  });

  it('redacts PIN values and keeps event records immutable', () => {
    const run = reduceResearchRun(createResearchRun('pin-safe', 'SOFTWARE_ONLY', at), {
      type: 'APP_EVENT', role: 'SYSTEM', kind: 'COMMAND', detail: 'PIN 4826; demoPin=1234', provenance: 'HOST_DERIVED', at
    });
    expect(run.events[0].detail).toBe('PIN [REDACTED]; demoPin=[REDACTED]');
    expect(Object.isFrozen(run.events[0])).toBe(true);
    expect(run.events[0].seq).toBe(1);
  });

  it('replays versioned scenarios offline with honest synthetic provenance', () => {
    const clean = replaySyntheticScenario(SYNTHETIC_SCENARIOS[0], 'fixture-clean', at);
    expect(clean.mode).toBe('SOFTWARE_ONLY');
    expect(clean.shadowUpdateCount).toBe(1);
    expect(clean.events.filter(event => event.role === 'UNO' || event.role === 'SENTINEL').every(event => event.provenance === 'SYNTHETIC_FIXTURE')).toBe(true);

    const mismatch = replaySyntheticScenario(SYNTHETIC_SCENARIOS[1], 'fixture-mismatch', at);
    expect(mismatch.phase).toBe('FROZEN');
    expect(mismatch.shadowUpdateCount).toBe(0);

    const denied = replaySyntheticScenario(SYNTHETIC_SCENARIOS[2], 'fixture-denied', at);
    expect(denied.activeTransaction?.phase).toBe('DENIED');
    expect(denied.shadowUpdateCount).toBe(0);
  });

  it('exports versioned JSON and escaped CSV from the immutable event ledger', () => {
    const run = reduceResearchRun(createResearchRun('export-run', 'SOFTWARE_ONLY', at), {
      type: 'APP_EVENT', role: 'LAB', kind: 'NOTE', detail: 'quote: "safe"', provenance: 'SOFTWARE_SIMULATION', at
    });
    expect(JSON.parse(researchRunToJson(run)).schemaVersion).toBe(1);
    expect(researchRunToCsv(run)).toContain('seq,eventId,at,sessionId,role,kind,provenance,transactionId,amount,detail');
    expect(researchRunToCsv(run)).toContain('""safe""');
  });
});
