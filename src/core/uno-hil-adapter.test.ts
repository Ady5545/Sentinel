import { describe, expect, it } from 'vitest';
import { createUnoHilAdapter, type UnoCommand } from './uno-hil-adapter';

describe('typed Uno HIL adapter', () => {
  it('maps every operator workflow to a structured allowlisted request', async () => {
    const sent: UnoCommand[] = [];
    const adapter = createUnoHilAdapter(async command => {
      sent.push(command);
      return { ok: true, commandName: command.name };
    });

    await adapter.provisionAccount('CARD01', '4826', 50000);
    await adapter.configureCassette({ notes500: 20, notes200: 20, notes100: 20, notes50: 20 });
    await adapter.insertCard('CARD01');
    await adapter.verifyPin('4826');
    await adapter.requestBalance();
    await adapter.withdraw(500);
    await adapter.injectMismatchFixture();

    expect(sent).toEqual([
      { name: 'ADD_ACCOUNT', args: ['CARD01', '4826', '50000'] },
      { name: 'SET_CASH', args: ['20', '20', '20', '20'] },
      { name: 'CARD', args: ['CARD01'] },
      { name: 'PIN', args: ['4826'] },
      { name: 'BALANCE', args: [] },
      { name: 'WITHDRAW', args: ['500'] },
      { name: 'FIXTURE_MISMATCH', args: [] }
    ]);
  });

  it('rejects invalid fictional credentials, card IDs, inventory, and withdrawals before transport', async () => {
    const sent: UnoCommand[] = [];
    const adapter = createUnoHilAdapter(async command => {
      sent.push(command);
      return { ok: true };
    });

    expect((await adapter.provisionAccount('CARD01', '123', 50000)).ok).toBe(false);
    expect((await adapter.provisionAccount('lowercase', '4826', 50000)).ok).toBe(false);
    expect((await adapter.provisionAccount('CARD01', '4826', 1000001)).ok).toBe(false);
    expect((await adapter.configureCassette({ notes500: 10000, notes200: 0, notes100: 0, notes50: 0 })).ok).toBe(false);
    expect((await adapter.insertCard('not valid')).ok).toBe(false);
    expect((await adapter.verifyPin('abcde')).ok).toBe(false);
    expect((await adapter.withdraw(520)).ok).toBe(false);
    expect((await adapter.withdraw(0)).ok).toBe(false);
    expect(sent).toEqual([]);
  });
});
