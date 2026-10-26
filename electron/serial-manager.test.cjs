const test = require('node:test');
const assert = require('node:assert/strict');
const { validateBoardCommand } = require('./serial-manager.cjs');

test('UNO allowlist accepts only documented, well-formed operator commands', () => {
  assert.equal(validateBoardCommand('uno', 'STATUS').ok, true);
  assert.equal(validateBoardCommand('uno', 'ADD_ACCOUNT CARD01 4826 50000').ok, true);
  assert.equal(validateBoardCommand('uno', 'SET_CASH 20 20 20 20').ok, true);
  assert.equal(validateBoardCommand('uno', 'CARD CARD01').ok, true);
  assert.equal(validateBoardCommand('uno', 'PIN 4826').ok, true);
  assert.equal(validateBoardCommand('uno', 'WITHDRAW 500').ok, true);
  assert.equal(validateBoardCommand('uno', 'WITHDRAW 520').ok, false);
  assert.equal(validateBoardCommand('uno', 'RUN_SHELL rm -rf /').ok, false);
  assert.equal(validateBoardCommand('uno', 'STATUS' + String.fromCharCode(10) + 'FIXTURE_MISMATCH').ok, false);
  assert.equal(validateBoardCommand('uno', 'PIN 123').ok, false);
});

test('ESP32 allowlist accepts guardian policy diagnostics and labelled fixtures only', () => {
  assert.equal(validateBoardCommand('sentinel', 'STATUS').ok, true);
  assert.equal(validateBoardCommand('sentinel', 'SET_LIMITS 20000 40000').ok, true);
  assert.equal(validateBoardCommand('sentinel', 'FIXTURE_REVOKE').ok, true);
  assert.equal(validateBoardCommand('sentinel', 'ADD_ACCOUNT CARD01 4826 50000').ok, false);
  assert.equal(validateBoardCommand('sentinel', 'SET_POLICY 20000 40000 1800 2600 86400000 9 60000 1800').ok, true);
  assert.equal(validateBoardCommand('sentinel', 'SET_POLICY 20000 40000 4000 2600 86400000 9 60000 1800').ok, false);
});

test('command validation prevents secret text from being needed in diagnostics', () => {
  const result = validateBoardCommand('uno', 'PIN 4826');
  assert.deepEqual(result, { ok: true, commandName: 'PIN', sensitive: true });
  assert.equal(validateBoardCommand('uno', 'ADD_ACCOUNT CARD01 4826 50000').sensitive, true);
  assert.equal(validateBoardCommand('uno', 'CHANGE_PIN 4826 1357 1357').sensitive, true);
});

test('command parser rejects control characters, padding and overlong values', () => {
  assert.equal(validateBoardCommand('uno', ' STATUS').ok, false);
  assert.equal(validateBoardCommand('uno', 'STATUS ').ok, false);
  assert.equal(validateBoardCommand('uno', 'STATUS' + String.fromCharCode(13)).ok, false);
  assert.equal(validateBoardCommand('uno', 'X'.repeat(97)).ok, false);
  assert.equal(validateBoardCommand('invalid', 'STATUS').ok, false);
});
