export type UnoCommand = { name: string; args: string[] };
export type UnoCommandResult = { ok: boolean; error?: string; requestId?: string; commandName?: string; sensitive?: boolean };
export type UnoCommandTransport = (command: UnoCommand) => Promise<UnoCommandResult>;

export interface UnoHilAdapter {
  provisionAccount(cardId: string, pin: string, startingBalance: number): Promise<UnoCommandResult>;
  configureCassette(counts: { notes500: number; notes200: number; notes100: number; notes50: number }): Promise<UnoCommandResult>;
  insertCard(cardId: string): Promise<UnoCommandResult>;
  verifyPin(pin: string): Promise<UnoCommandResult>;
  requestBalance(): Promise<UnoCommandResult>;
  withdraw(amount: number): Promise<UnoCommandResult>;
  injectMismatchFixture(): Promise<UnoCommandResult>;
}

const cardPattern = /^[A-Z0-9_-]{1,16}$/;
const pinPattern = /^[0-9]{4,6}$/;
function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 9999;
}
function validBalance(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1000000;
}

/**
 * Typed Uno-only adapter. It is deliberately transport-agnostic: the caller
 * supplies the trusted desktop bridge transport, while this module exposes no
 * arbitrary bytes, renderer IPC channel names, or free-form commands.
 */
export function createUnoHilAdapter(send: UnoCommandTransport): UnoHilAdapter {
  const command = (name: string, args: string[] = []) => send({ name, args });

  return {
    provisionAccount(cardId, pin, startingBalance) {
      if (!cardPattern.test(cardId) || !pinPattern.test(pin) || !validBalance(startingBalance)) {
        return Promise.resolve({ ok: false, error: 'Invalid fictional account details.' });
      }
      return command('ADD_ACCOUNT', [cardId, pin, String(startingBalance)]);
    },
    configureCassette(counts) {
      const values = [counts.notes500, counts.notes200, counts.notes100, counts.notes50];
      if (!values.every(validCount)) {
        return Promise.resolve({ ok: false, error: 'Cassette counts must each be integers from 0 to 9999.' });
      }
      return command('SET_CASH', values.map(String));
    },
    insertCard(cardId) {
      if (!cardPattern.test(cardId)) return Promise.resolve({ ok: false, error: 'Invalid fictional card ID.' });
      return command('CARD', [cardId]);
    },
    verifyPin(pin) {
      if (!pinPattern.test(pin)) return Promise.resolve({ ok: false, error: 'Enter a fictional 4–6 digit PIN.' });
      return command('PIN', [pin]);
    },
    requestBalance() {
      return command('BALANCE');
    },
    withdraw(amount) {
      if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1000000 || amount % 50 !== 0) {
        return Promise.resolve({ ok: false, error: 'Withdrawal must be a positive amount up to 1,000,000 and a multiple of ₹50.' });
      }
      return command('WITHDRAW', [String(amount)]);
    },
    injectMismatchFixture() {
      return command('FIXTURE_MISMATCH');
    }
  };
}
