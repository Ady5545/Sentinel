/*
 * SENTINEL ATM Controller Firmware V3.2
 * Target: Arduino Uno / ATmega328P
 * ESP32 link: SoftwareSerial RX=D2, TX=D3, 9600 8N1
 * Desktop/operator USB link: Serial at 115200
 *
 * Educational ATM controller only. No real PIN pad, card reader, cash hardware,
 * banking connection, or physical dispenser is implemented.
 *
 * Customer/account configuration is provisioned at runtime and held in RAM.
 * A reset clears accounts, PINs, balances and demo cash inventory. This avoids
 * putting a reusable PIN in source code or EEPROM, but is NOT production ATM
 * credential storage. Use only fictional demo values.
 */
#include <Arduino.h>
#include <SoftwareSerial.h>
#include <string.h>
#include <stdlib.h>
#include <ctype.h>
#include <avr/pgmspace.h>
#define STREQ(value, literal) (strcmp_P((value), PSTR(literal)) == 0)
#define STRNEQ(value, literal, count) (strncmp_P((value), PSTR(literal), (count)) == 0)

static const uint8_t PEER_RX_PIN = 2;
static const uint8_t PEER_TX_PIN = 3;
static const unsigned long PEER_BAUD = 4800;
static const unsigned long USB_BAUD = 115200;
static const unsigned long HEARTBEAT_MS = 500;
static const unsigned long HELLO_RETRY_MS = 650UL;
static const unsigned long HANDSHAKE_TIMEOUT_MS = 8000UL;
static const unsigned long DEFAULT_GUARDIAN_TIMEOUT_MS = 2600UL;
static const unsigned long HEALTHY_STATUS_DUPLICATE_WINDOW_MS = 600UL;
static const uint8_t MAX_INITIAL_STATUS_FRAME_DROPS = 3;
static const unsigned long DEFAULT_TRANSACTION_DECISION_TIMEOUT_MS = 1800UL;
static const unsigned long DEFAULT_PIN_ENTRY_TIMEOUT_MS = 30000UL;
static const unsigned long DEFAULT_SESSION_TIMEOUT_MS = 60000UL;
static const unsigned long DEFAULT_PIN_LOCKOUT_MS = 60000UL;
static const unsigned long DEFAULT_BUDGET_WINDOW_MS = 86400000UL;
static const uint32_t DEFAULT_MAX_WITHDRAWAL = 20000UL;
static const uint32_t DEFAULT_WINDOW_LIMIT = 40000UL;
static const uint8_t MAX_ACCOUNTS = 4;
static const uint8_t MAX_PIN_LENGTH = 6;
static const uint8_t DEFAULT_MAX_PIN_FAILURES = 3;
static const size_t FRAME_MAX = 120;
static const size_t USB_LINE_MAX = 96;
static const uint8_t JOURNAL_SIZE = 8;

SoftwareSerial GuardianSerial(PEER_RX_PIN, PEER_TX_PIN);

enum AtmState {
  ATM_UNCOMMISSIONED,
  ATM_IDLE,
  ATM_PIN_PENDING,
  ATM_AUTHENTICATED,
  ATM_WITHDRAW_PENDING,
  ATM_LOCKED,
  ATM_GUARDIAN_LOCKED
};

enum GuardianLinkState { LINK_UNKNOWN, LINK_OBSERVING, LINK_REVOKED };

struct Account {
  char cardId[17];
  char pin[7];
  uint32_t balance;
  uint8_t failedPins;
  uint32_t lockoutUntil;
  bool used;
};

struct CashInventory {
  uint16_t notes500;
  uint16_t notes200;
  uint16_t notes100;
  uint16_t notes50;
};

AtmState atmState = ATM_UNCOMMISSIONED;
GuardianLinkState guardianLink = LINK_UNKNOWN;
Account accounts[MAX_ACCOUNTS];
CashInventory cashInventory = {0, 0, 0, 0};
char activeCardId[17] = {0};
int8_t activeAccount = -1;
uint32_t maxWithdrawal = DEFAULT_MAX_WITHDRAWAL;
uint32_t windowLimit = DEFAULT_WINDOW_LIMIT;
unsigned long budgetWindowMs = DEFAULT_BUDGET_WINDOW_MS;
unsigned long guardianTimeoutMs = DEFAULT_GUARDIAN_TIMEOUT_MS;
unsigned long transactionDecisionTimeoutMs = DEFAULT_TRANSACTION_DECISION_TIMEOUT_MS;
unsigned long pinEntryTimeoutMs = DEFAULT_PIN_ENTRY_TIMEOUT_MS;
unsigned long sessionTimeoutMs = DEFAULT_SESSION_TIMEOUT_MS;
unsigned long pinLockoutMs = DEFAULT_PIN_LOCKOUT_MS;
uint8_t maxPinFailures = DEFAULT_MAX_PIN_FAILURES;
uint32_t windowWithdrawn = 0;
uint32_t budgetWindowStartedAt = 0;
uint32_t pinEntryStartedAt = 0;
uint32_t lastCustomerActivityAt = 0;
uint32_t txCounter = 0;
uint32_t txPendingAmount = 0;
uint32_t txPendingStartedAt = 0;
uint16_t txPendingPlan[4] = {0, 0, 0, 0};
char txPendingId[12] = {0};
uint32_t txCommittedCount = 0;
uint32_t txDeniedCount = 0;

char sessionId[13] = {0};
char rxBuffer[FRAME_MAX];
size_t rxLength = 0;
bool droppingLongFrame = false;
char usbBuffer[USB_LINE_MAX];
size_t usbLength = 0;
bool droppingUsbLine = false;
uint32_t txSequence = 0;
uint32_t lastGuardianSequence = 0;
uint32_t lastGuardianFrameAt = 0;
uint32_t lastGuardianStatusAt = 0;
uint32_t lastGuardianStatusSequence = 0;
uint8_t initialHealthyFrameDrops = 0;
uint32_t lastHeartbeatAt = 0;
uint32_t lastHelloAt = 0;
uint32_t handshakeStartedAt = 0;
bool guardianHelloSeen = false;
bool handshakeComplete = false;  // True only after the final V3 handshake ACK.
uint32_t helloRetryCount = 0;
bool guardianRevokeLatched = false;
bool statePublished = false;
/* Serialize SoftwareSerial peer traffic: one HEARTBEAT awaiting STATUS. */
bool awaitingGuardianStatus = false;
char journal[JOURNAL_SIZE][32];
uint8_t journalNext = 0;
uint8_t journalCount = 0;

const __FlashStringHelper *stateName(AtmState s) {
  switch (s) {
    case ATM_UNCOMMISSIONED: return F("UNCOMMISSIONED");
    case ATM_IDLE: return F("IDLE");
    case ATM_PIN_PENDING: return F("PIN_PENDING");
    case ATM_AUTHENTICATED: return F("AUTHENTICATED");
    case ATM_WITHDRAW_PENDING: return F("WITHDRAW_PENDING");
    case ATM_LOCKED: return F("LOCKED");
    case ATM_GUARDIAN_LOCKED: return F("GUARDIAN_LOCKED");
  }
  return F("UNKNOWN");
}

void secureClear(char *buffer, size_t length) {
  volatile char *p = buffer;
  while (length--) *p++ = '\0';
}

void journalEvent(const __FlashStringHelper *eventName) {
  strncpy_P(journal[journalNext], (PGM_P)eventName, sizeof(journal[journalNext]) - 1);
  journal[journalNext][sizeof(journal[journalNext]) - 1] = '\0';
  journalNext = (uint8_t)((journalNext + 1) % JOURNAL_SIZE);
  if (journalCount < JOURNAL_SIZE) ++journalCount;
}

void emitEvent(const __FlashStringHelper *name, const char *details) {
  Serial.print(F("ATM_EVENT|"));
  Serial.print(name);
  Serial.print('|');
  if (details && details[0]) Serial.println(details);
  else Serial.println('-');
  journalEvent(name);
}

void emitEvent(const __FlashStringHelper *name, const __FlashStringHelper *details) {
  Serial.print(F("ATM_EVENT|"));
  Serial.print(name);
  Serial.print('|');
  Serial.println(details);
  journalEvent(name);
}

uint16_t crc16CcittFalse(const uint8_t *data, size_t len) {
  uint16_t crc = 0xFFFF;
  for (size_t i = 0; i < len; ++i) {
    crc ^= (uint16_t)data[i] << 8;
    for (uint8_t bit = 0; bit < 8; ++bit)
      crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021) : (uint16_t)(crc << 1);
  }
  return crc;
}

bool validSession(const char *s) {
  const size_t n = strlen(s);
  if (n < 8 || n > 12) return false;
  for (size_t i = 0; i < n; ++i)
    if (!((s[i] >= 'A' && s[i] <= 'Z') || (s[i] >= '0' && s[i] <= '9'))) return false;
  return true;
}

void makeSession() {
  // Session separation only; this is not cryptographic randomness.
  snprintf_P(sessionId, sizeof(sessionId), PSTR("U%08lX"), (unsigned long)micros());
}

bool sendFrameAtSequence(const __FlashStringHelper *type, const char *payload, uint32_t seq) {
  if (seq == 0) {
    Serial.println(F("[FAULT] Sequence zero is invalid."));
    guardianRevokeLatched = true;
    guardianLink = LINK_REVOKED;
    atmState = ATM_GUARDIAN_LOCKED;
    return false;
  }
  char prefix[FRAME_MAX];
  const int n = snprintf_P(prefix, sizeof(prefix), PSTR("S3|%S|%s|%lu|%s"), type,
                         sessionId, (unsigned long)seq,
                         (payload && payload[0]) ? payload : "-");
  if (n <= 0 || (size_t)n >= sizeof(prefix)) {
    Serial.println(F("[FAULT] Outgoing peer frame overflow."));
    guardianRevokeLatched = true;
    guardianLink = LINK_REVOKED;
    atmState = ATM_GUARDIAN_LOCKED;
    return false;
  }
  if (seq > txSequence) txSequence = seq;
  const uint16_t crc = crc16CcittFalse((const uint8_t *)prefix, (size_t)n);
  GuardianSerial.print(prefix);
  GuardianSerial.print('|');
  char crcText[5];
  snprintf_P(crcText, sizeof(crcText), PSTR("%04X"), crc);
  GuardianSerial.print(crcText);
  GuardianSerial.print('\n');
  return true;
}

bool sendFrameAtSequence(const __FlashStringHelper *type,
                          const __FlashStringHelper *payload, uint32_t seq) {
  if (seq == 0) {
    guardianRevokeLatched = true;
    guardianLink = LINK_REVOKED;
    atmState = ATM_GUARDIAN_LOCKED;
    return false;
  }
  char prefix[FRAME_MAX];
  const int n = snprintf_P(prefix, sizeof(prefix), PSTR("S3|%S|%s|%lu|%S"), type,
                           sessionId, (unsigned long)seq, payload);
  if (n <= 0 || (size_t)n >= sizeof(prefix)) {
    Serial.println(F("[FAULT] Outgoing peer frame overflow."));
    guardianRevokeLatched = true;
    guardianLink = LINK_REVOKED;
    atmState = ATM_GUARDIAN_LOCKED;
    return false;
  }
  if (seq > txSequence) txSequence = seq;
  const uint16_t crc = crc16CcittFalse((const uint8_t *)prefix, (size_t)n);
  GuardianSerial.print(prefix);
  GuardianSerial.print('|');
  char crcText[5];
  snprintf_P(crcText, sizeof(crcText), PSTR("%04X"), crc);
  GuardianSerial.print(crcText);
  GuardianSerial.print('\n');
  return true;
}

bool sendFrame(const __FlashStringHelper *type, const char *payload) {
  if (txSequence == 0xFFFFFFFFUL) {
    Serial.println(F("[FAULT] Outgoing sequence exhausted; guardian locked."));
    guardianRevokeLatched = true;
    guardianLink = LINK_REVOKED;
    atmState = ATM_GUARDIAN_LOCKED;
    return false;
  }
  return sendFrameAtSequence(type, payload, txSequence + 1UL);
}

bool sendFrame(const __FlashStringHelper *type, const __FlashStringHelper *payload) {
  if (txSequence == 0xFFFFFFFFUL) {
    Serial.println(F("[FAULT] Outgoing sequence exhausted; guardian locked."));
    guardianRevokeLatched = true;
    guardianLink = LINK_REVOKED;
    atmState = ATM_GUARDIAN_LOCKED;
    return false;
  }
  return sendFrameAtSequence(type, payload, txSequence + 1UL);
}

bool parseFrame(char *line, char fields[5][48], uint32_t &seqOut) {
  const size_t len = strlen(line);
  if (len < 12 || len > FRAME_MAX - 2) return false;
  char *lastSep = strrchr(line, '|');
  if (!lastSep || strlen(lastSep + 1) != 4) return false;
  for (const char *digit = lastSep + 1; *digit; ++digit) {
    if (!((*digit >= '0' && *digit <= '9') ||
          (*digit >= 'A' && *digit <= 'F') ||
          (*digit >= 'a' && *digit <= 'f'))) return false;
  }
  char *end = NULL;
  const unsigned long receivedCrc = strtoul(lastSep + 1, &end, 16);
  if (!end || *end != '\0' || receivedCrc > 0xFFFF) return false;
  const uint16_t expected = crc16CcittFalse((const uint8_t *)line, (size_t)(lastSep - line));
  if (expected != (uint16_t)receivedCrc) return false;
  *lastSep = '\0';
  char *save = NULL;
  char *part = strtok_r(line, "|", &save);
  uint8_t count = 0;
  while (part && count < 5) {
    if (strlen(part) >= sizeof(fields[count])) return false;
    strcpy(fields[count++], part);
    part = strtok_r(NULL, "|", &save);
  }
  if (part || count != 5) return false;
  if (!STREQ(fields[0], "S3") || !validSession(fields[2])) return false;
  if (!fields[3][0]) return false;
  for (size_t i = 0; fields[3][i]; ++i)
    if (fields[3][i] < '0' || fields[3][i] > '9') return false;
  seqOut = strtoul(fields[3], &end, 10);
  return end && *end == '\0' && seqOut != 0;
}

bool parseUnsigned(const char *text, uint32_t maximum, uint32_t &value) {
  if (!text || !text[0]) return false;
  uint32_t result = 0;
  for (size_t i = 0; text[i]; ++i) {
    if (text[i] < '0' || text[i] > '9') return false;
    const uint8_t digit = (uint8_t)(text[i] - '0');
    if (result > maximum / 10UL ||
        (result == maximum / 10UL && digit > maximum % 10UL)) return false;
    result = result * 10UL + digit;
  }
  if (result > maximum) return false;
  value = result;
  return true;
}

bool validCardId(const char *card) {
  const size_t n = strlen(card);
  if (n < 1 || n > 16) return false;
  for (size_t i = 0; i < n; ++i) {
    const char c = card[i];
    if (!((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_'))
      return false;
  }
  return true;
}

bool validPin(const char *pin) {
  const size_t n = strlen(pin);
  if (n < 4 || n > MAX_PIN_LENGTH) return false;
  for (size_t i = 0; i < n; ++i)
    if (pin[i] < '0' || pin[i] > '9') return false;
  return true;
}

bool pinEqualsConstantWork(const char *candidate, const char *stored) {
  const size_t cn = strlen(candidate);
  const size_t sn = strlen(stored);
  uint8_t difference = (uint8_t)(cn ^ sn);
  for (uint8_t i = 0; i < MAX_PIN_LENGTH; ++i) {
    const char a = (i < cn) ? candidate[i] : 0;
    const char b = (i < sn) ? stored[i] : 0;
    difference |= (uint8_t)(a ^ b);
  }
  return difference == 0;
}

int8_t findAccount(const char *cardId) {
  for (uint8_t i = 0; i < MAX_ACCOUNTS; ++i)
    if (accounts[i].used && strcmp(accounts[i].cardId, cardId) == 0) return (int8_t)i;
  return -1;
}

int8_t freeAccountSlot() {
  for (uint8_t i = 0; i < MAX_ACCOUNTS; ++i)
    if (!accounts[i].used) return (int8_t)i;
  return -1;
}

bool hasConfiguredAccount() {
  for (uint8_t i = 0; i < MAX_ACCOUNTS; ++i) if (accounts[i].used) return true;
  return false;
}

bool guardianFresh() {
  return handshakeComplete && !guardianRevokeLatched &&
         guardianLink == LINK_OBSERVING &&
         lastGuardianStatusAt != 0 &&
         (uint32_t)(millis() - lastGuardianStatusAt) <= guardianTimeoutMs;
}

void sendState() {
  if (!handshakeComplete) return;
  char payload[48];
  snprintf_P(payload, sizeof(payload), PSTR("atm=%S;auth=%u;tx=%lu"),
           stateName(atmState),
           (atmState == ATM_AUTHENTICATED || atmState == ATM_WITHDRAW_PENDING) ? 1 : 0,
           (unsigned long)txCommittedCount);
  sendFrame(F("STATE"), payload);
  statePublished = true;
}

void setAtmState(AtmState next) {
  if (atmState == next) return;
  atmState = next;
  sendState();
}

void resetCustomerSession() {
  activeAccount = -1;
  activeCardId[0] = '\0';
  txPendingId[0] = '\0';
  txPendingAmount = 0;
  memset(txPendingPlan, 0, sizeof(txPendingPlan));
  if (guardianRevokeLatched) setAtmState(ATM_GUARDIAN_LOCKED);
  else setAtmState(hasConfiguredAccount() ? ATM_IDLE : ATM_UNCOMMISSIONED);
}

void enterGuardianLock(const __FlashStringHelper *reason) {
  const bool first = !guardianRevokeLatched;
  guardianRevokeLatched = true;
  guardianLink = LINK_REVOKED;
  activeAccount = -1;
  activeCardId[0] = '\0';
  txPendingId[0] = '\0';
  txPendingAmount = 0;
  memset(txPendingPlan, 0, sizeof(txPendingPlan));
  setAtmState(ATM_GUARDIAN_LOCKED);
  if (first) {
    Serial.print(F("[SECURITY_LOCK] "));
    Serial.println(reason);
    emitEvent(F("GUARDIAN_REVOKED"), F("dispense=DENIED"));
  }
}

void sendHeartbeat(uint32_t now) {
  if (!handshakeComplete || awaitingGuardianStatus || guardianRevokeLatched) return;
  char payload[48];
  snprintf_P(payload, sizeof(payload), PSTR("state=%S;up=%lu"),
           stateName(atmState), (unsigned long)now);
  if (sendFrame(F("HEARTBEAT"), payload)) {
    lastHeartbeatAt = now;
    awaitingGuardianStatus = true;
  }
}

bool parsePayloadField(const char *payload, const __FlashStringHelper *key, char *out, size_t outSize) {
  if (!payload || !key || !out || outSize < 2) return false;
  const size_t keyLen = strlen_P((PGM_P)key);
  const char *cursor = payload;
  while (*cursor) {
    const char *end = strchr(cursor, ';');
    const size_t tokenLen = end ? (size_t)(end - cursor) : strlen(cursor);
    if (tokenLen > keyLen && strncmp_P(cursor, (PGM_P)key, keyLen) == 0 && cursor[keyLen] == '=') {
      const size_t valueLen = tokenLen - keyLen - 1;
      if (valueLen == 0 || valueLen >= outSize) return false;
      memcpy(out, cursor + keyLen + 1, valueLen);
      out[valueLen] = '\0';
      return true;
    }
    if (!end) break;
    cursor = end + 1;
  }
  return false;
}

bool transactionIdMatches(const char *payload) {
  char id[12];
  return parsePayloadField(payload, F("id"), id, sizeof(id)) &&
         txPendingId[0] && strcmp(id, txPendingId) == 0;
}

bool makeNotePlan(uint32_t amount, uint16_t plan[4]) {
  if (amount == 0 || amount % 50UL != 0) return false;
  const uint32_t available = (uint32_t)cashInventory.notes500 * 500UL +
                             (uint32_t)cashInventory.notes200 * 200UL +
                             (uint32_t)cashInventory.notes100 * 100UL +
                             (uint32_t)cashInventory.notes50 * 50UL;
  if (available < amount) return false;

  // Search only the possible count of the largest denomination. For each
  // candidate, greedy selection across the remaining nested denominations is
  // complete for this 500/200/100/50 note set and bounded on an Uno.
  const uint32_t max500 = (amount / 500UL < cashInventory.notes500) ?
                          amount / 500UL : cashInventory.notes500;
  for (int32_t n500 = (int32_t)max500; n500 >= 0; --n500) {
    uint32_t remaining = amount - (uint32_t)n500 * 500UL;
    const uint32_t n200 = (remaining / 200UL < cashInventory.notes200) ?
                          remaining / 200UL : cashInventory.notes200;
    remaining -= n200 * 200UL;
    const uint32_t n100 = (remaining / 100UL < cashInventory.notes100) ?
                          remaining / 100UL : cashInventory.notes100;
    remaining -= n100 * 100UL;
    if (remaining % 50UL != 0 || remaining / 50UL > cashInventory.notes50) continue;
    plan[0] = (uint16_t)n500;
    plan[1] = (uint16_t)n200;
    plan[2] = (uint16_t)n100;
    plan[3] = (uint16_t)(remaining / 50UL);
    return true;
  }
  return false;
}

void completeWithdrawal() {
  if (activeAccount < 0 || txPendingAmount == 0 ||
      atmState != ATM_WITHDRAW_PENDING || guardianRevokeLatched) {
    enterGuardianLock(F("Permit arrived without a matching pending transaction."));
    return;
  }
  Account &account = accounts[(uint8_t)activeAccount];
  if (account.balance < txPendingAmount ||
      cashInventory.notes500 < txPendingPlan[0] ||
      cashInventory.notes200 < txPendingPlan[1] ||
      cashInventory.notes100 < txPendingPlan[2] ||
      cashInventory.notes50 < txPendingPlan[3]) {
    enterGuardianLock(F("Local transaction preconditions changed before authorization."));
    return;
  }

  account.balance -= txPendingAmount;
  cashInventory.notes500 -= txPendingPlan[0];
  cashInventory.notes200 -= txPendingPlan[1];
  cashInventory.notes100 -= txPendingPlan[2];
  cashInventory.notes50 -= txPendingPlan[3];
  windowWithdrawn += txPendingAmount;
  ++txCommittedCount;
  lastCustomerActivityAt = millis();

  char details[48];
  snprintf_P(details, sizeof(details), PSTR("id=%s;amount=%lu;balance=%lu"),
           txPendingId, (unsigned long)txPendingAmount, (unsigned long)account.balance);
  emitEvent(F("WITHDRAWAL_APPROVED"), details);
  sendFrame(F("EVENT"), details);
  Serial.print(F("[VIRTUAL_ONLY] Withdrawal committed: "));
  Serial.print(txPendingAmount);
  Serial.print(F("; balance="));
  Serial.println(account.balance);

  txPendingAmount = 0;
  txPendingId[0] = '\0';
  memset(txPendingPlan, 0, sizeof(txPendingPlan));
  setAtmState(ATM_AUTHENTICATED);
}

void handleGuardianLine(char *line) {
  char fields[5][48] = {{0}};
  uint32_t seq = 0;
  if (!parseFrame(line, fields, seq)) {
    // Before the first healthy STATUS, no permit can be authorized. Permit a
    // small, bounded number of corrupted startup liveness frames so the ESP32
    // can retry the exact STATUS sequence. Never refresh freshness on bad data.
    if (handshakeComplete && awaitingGuardianStatus && lastGuardianStatusAt == 0 &&
        !guardianRevokeLatched &&
        initialHealthyFrameDrops < MAX_INITIAL_STATUS_FRAME_DROPS) {
      ++initialHealthyFrameDrops;
      Serial.print(F("[LINK_RETRY] Dropped malformed pre-healthy frame "));
      Serial.print(initialHealthyFrameDrops);
      Serial.print('/');
      Serial.print(MAX_INITIAL_STATUS_FRAME_DROPS);
      Serial.println(F("; awaiting valid HEALTHY STATUS."));
      return;
    }
    Serial.print(F("[LINK_RX] Rejected malformed guardian frame: "));
    Serial.println(line);
    enterGuardianLock(F("Malformed guardian frame or CRC/version validation failure."));
    return;
  }
  if (strcmp(fields[2], sessionId) != 0) {
    Serial.print(F("[LINK_RX] Session mismatch; expected="));
    Serial.print(sessionId);
    Serial.print(F(" received="));
    Serial.println(fields[2]);
    enterGuardianLock(F("Guardian session mismatch."));
    return;
  }
  const char *type = fields[1];
  const char *payload = fields[4];

  // A retransmitted HEALTHY status uses its original sequence. Accept only an
  // exact duplicate of the most recently accepted STATUS inside the short
  // retry window; never refresh the status timestamp for a duplicate.
  if (!guardianRevokeLatched && handshakeComplete &&
      lastGuardianStatusSequence != 0 &&
      seq == lastGuardianStatusSequence && seq == lastGuardianSequence &&
      STREQ(type, "STATUS") && STREQ(payload, "HEALTHY") &&
      (uint32_t)(millis() - lastGuardianStatusAt) <= HEALTHY_STATUS_DUPLICATE_WINDOW_MS) {
    Serial.println(F("[LINK_RETRY] Duplicate HEALTHY STATUS ignored."));
    return;
  }

  // A repeated, identical guardian HELLO is a handshake retry, not a new message.
  if (guardianHelloSeen && seq == 1 && STREQ(type, "HELLO") &&
      strcmp(payload, "ESP32-SENTINEL-V3") == 0) {
    /* Retry is safe until the first healthy STATUS; it must not revoke startup. */
    if (!guardianRevokeLatched && lastGuardianStatusAt == 0) {
      Serial.println(F("[LINK_RETRY] Duplicate guardian HELLO; replaying ACK seq=2."));
      sendFrameAtSequence(F("ACK"), F("HELLO_ACCEPTED"), 2);
      return;
    }
    enterGuardianLock(F("Repeated guardian HELLO after first healthy status."));
    return;
  }

  // An exact duplicate handshake ACK is non-authorizing; do not advance liveness.
  if (guardianHelloSeen && handshakeComplete && seq == 2 &&
      STREQ(type, "ACK") && STREQ(payload, "HELLO_ACCEPTED")) {
    Serial.println(F("[LINK_RETRY] Duplicate handshake ACK ignored."));
    return;
  }

  if (seq != lastGuardianSequence + 1UL) {
    Serial.print(F("[LINK_RX] Sequence mismatch; expected="));
    Serial.print(lastGuardianSequence + 1UL);
    Serial.print(F(" received="));
    Serial.print(seq);
    Serial.print(F(" type="));
    Serial.println(type);
    enterGuardianLock(F("Guardian sequence gap, duplicate or stale frame."));
    return;
  }
  lastGuardianSequence = seq;
  lastGuardianFrameAt = millis();

  if (STREQ(type, "HELLO")) {
    if (guardianHelloSeen || seq != 1 ||
        strcmp(payload, "ESP32-SENTINEL-V3") != 0) {
      enterGuardianLock(F("Unexpected guardian V3 HELLO."));
      return;
    }
    guardianHelloSeen = true;
    guardianLink = LINK_UNKNOWN;
    Serial.println(F("[LINK] V3 guardian HELLO observed; waiting for final handshake ACK."));
    sendFrameAtSequence(F("ACK"), F("HELLO_ACCEPTED"), 2);
    return;
  }

  if (STREQ(type, "ACK")) {
    if (!guardianHelloSeen || handshakeComplete ||
        !STREQ(payload, "HELLO_ACCEPTED")) {
      enterGuardianLock(F("Unexpected guardian ACK."));
      return;
    }
    handshakeComplete = true;
    guardianLink = LINK_UNKNOWN;
    Serial.println(F("[LINK] V3 handshake complete; waiting for fresh guardian status."));
    return;
  }

  if (!handshakeComplete) {
    enterGuardianLock(F("Guardian sent traffic before V3 handshake completion."));
    return;
  }

  if (STREQ(type, "STATUS")) {
    if (guardianRevokeLatched) return;
    if (!STREQ(payload, "HEALTHY")) {
      enterGuardianLock(F("Malformed or non-healthy guardian status."));
      return;
    }
    lastGuardianStatusAt = millis();
    lastGuardianStatusSequence = seq;
    initialHealthyFrameDrops = 0;
    guardianLink = LINK_OBSERVING;
    awaitingGuardianStatus = false;
    Serial.print(F("[STATUS_RX] Accepted HEALTHY seq="));
    Serial.println(seq);
  } else if (STREQ(type, "PERMIT")) {
    if (!guardianFresh() || atmState != ATM_WITHDRAW_PENDING ||
        (uint32_t)(millis() - txPendingStartedAt) > transactionDecisionTimeoutMs ||
        !transactionIdMatches(payload)) {
      enterGuardianLock(F("Permit stale or not matched to the pending transaction."));
      return;
    }
    completeWithdrawal();
  } else if (STREQ(type, "DENY")) {
    if (atmState != ATM_WITHDRAW_PENDING || !transactionIdMatches(payload)) {
      enterGuardianLock(F("Denial did not match the pending transaction."));
      return;
    }
    ++txDeniedCount;
    emitEvent(F("WITHDRAWAL_DENIED"), payload);
    txPendingAmount = 0;
    txPendingId[0] = '\0';
    memset(txPendingPlan, 0, sizeof(txPendingPlan));
    setAtmState(ATM_AUTHENTICATED);
  } else if (STREQ(type, "REVOKE")) {
    enterGuardianLock(F("Guardian revoked controller authority."));
  } else {
    enterGuardianLock(F("Unknown guardian message type."));
  }
}

void pollGuardian() {
  while (GuardianSerial.available()) {
    const char c = (char)GuardianSerial.read();
    if (c == '\n') {
      if (!droppingLongFrame && rxLength > 0) {
        rxBuffer[rxLength] = '\0';
        handleGuardianLine(rxBuffer);
      } else if (droppingLongFrame) {
        enterGuardianLock(F("Overlong guardian frame discarded."));
      }
      rxLength = 0;
      droppingLongFrame = false;
    } else if (c != '\r') {
      if (rxLength >= FRAME_MAX - 1) droppingLongFrame = true;
      else if (!droppingLongFrame) rxBuffer[rxLength++] = c;
    }
  }
}

void printStatus() {
  Serial.print(F("ATM_STATUS|state="));
  Serial.print(stateName(atmState));
  Serial.print(F("|link="));
  Serial.print(guardianFresh() ? F("FRESH") : F("NOT_FRESH"));
  Serial.print(F("|accounts="));
  uint8_t used = 0;
  for (uint8_t i = 0; i < MAX_ACCOUNTS; ++i) if (accounts[i].used) ++used;
  Serial.print(used);
  Serial.print(F("|authenticated="));
  Serial.print(activeAccount >= 0 && atmState == ATM_AUTHENTICATED ? 1 : 0);
  Serial.print(F("|committed="));
  Serial.print(txCommittedCount);
  Serial.print(F("|denied="));
  Serial.println(txDeniedCount);
}

void printHelp() {
  Serial.println(F("SENTINEL ATM controller commands (fictional/demo data only):"));
  Serial.println(F("  ADD_ACCOUNT <CARD_ID> <4-6_DIGIT_PIN> <START_BALANCE>"));
  Serial.println(F("  SET_CASH <COUNT_500> <COUNT_200> <COUNT_100> <COUNT_50>"));
  Serial.println(F("  SET_POLICY <MAX_TXN> <WINDOW_LIMIT> [WINDOW_MS PIN_TRIES LOCKOUT_MS PIN_TIMEOUT_MS SESSION_TIMEOUT_MS GUARDIAN_TIMEOUT_MS TX_TIMEOUT_MS]"));
  Serial.println(F("  CARD <CARD_ID> | PIN <PIN> | BALANCE | WITHDRAW <AMOUNT> | CHANGE_PIN <CURRENT> <NEW> <CONFIRM>"));
  Serial.println(F("  CANCEL | LOGOUT | STATUS | JOURNAL | HELP | FIXTURE_MISMATCH"));
  Serial.println(F("Accounts/PINs/cash are RAM-only and are erased on reset."));
}

void handleAddAccount(char *card, char *pin, char *balanceText) {
  if (guardianRevokeLatched || atmState == ATM_PIN_PENDING ||
      atmState == ATM_AUTHENTICATED || atmState == ATM_WITHDRAW_PENDING) {
    emitEvent(F("CONFIG_DENIED"), F("reason=customer_session_or_guardian_lock"));
    return;
  }
  if (!validCardId(card) || !validPin(pin)) {
    emitEvent(F("CONFIG_DENIED"), F("reason=invalid_card_or_pin_format"));
    return;
  }
  uint32_t balance = 0;
  if (!parseUnsigned(balanceText, 1000000UL, balance)) {
    emitEvent(F("CONFIG_DENIED"), F("reason=invalid_balance"));
    return;
  }
  if (findAccount(card) >= 0) {
    emitEvent(F("CONFIG_DENIED"), F("reason=duplicate_card"));
    return;
  }
  const int8_t slot = freeAccountSlot();
  if (slot < 0) {
    emitEvent(F("CONFIG_DENIED"), F("reason=max_accounts_reached"));
    return;
  }
  Account &a = accounts[(uint8_t)slot];
  memset(&a, 0, sizeof(a));
  strncpy(a.cardId, card, sizeof(a.cardId) - 1);
  strncpy(a.pin, pin, sizeof(a.pin) - 1);
  a.balance = balance;
  a.used = true;
  if (atmState == ATM_UNCOMMISSIONED) setAtmState(ATM_IDLE);
  char details[40];
  snprintf_P(details, sizeof(details), PSTR("card=%s;balance=%lu"), a.cardId, (unsigned long)a.balance);
  emitEvent(F("ACCOUNT_PROVISIONED"), details);
}

void handleSetCash(char *c500, char *c200, char *c100, char *c50) {
  uint32_t v500, v200, v100, v50;
  if (activeAccount >= 0 || atmState == ATM_WITHDRAW_PENDING ||
      !parseUnsigned(c500, 9999, v500) || !parseUnsigned(c200, 9999, v200) ||
      !parseUnsigned(c100, 9999, v100) || !parseUnsigned(c50, 9999, v50)) {
    emitEvent(F("CONFIG_DENIED"), F("reason=invalid_cash_or_active_session"));
    return;
  }
  cashInventory.notes500 = (uint16_t)v500;
  cashInventory.notes200 = (uint16_t)v200;
  cashInventory.notes100 = (uint16_t)v100;
  cashInventory.notes50 = (uint16_t)v50;
  emitEvent(F("CASH_CONFIGURED"), F("currency=INR;values=500,200,100,50"));
}

void handleSetPolicy(char **argv, uint8_t argc) {
  uint32_t newMax = 0, newWindow = 0;
  uint32_t newWindowMs = budgetWindowMs, newTries = maxPinFailures;
  uint32_t newLockoutMs = pinLockoutMs, newPinTimeoutMs = pinEntryTimeoutMs;
  uint32_t newSessionTimeoutMs = sessionTimeoutMs;
  uint32_t newGuardianTimeoutMs = guardianTimeoutMs;
  uint32_t newTransactionTimeoutMs = transactionDecisionTimeoutMs;
  const bool fullPolicy = argc == 10;
  if ((argc != 3 && !fullPolicy) || activeAccount >= 0 || atmState == ATM_WITHDRAW_PENDING ||
      !parseUnsigned(argv[1], 1000000UL, newMax) ||
      !parseUnsigned(argv[2], 1000000UL, newWindow) ||
      newMax == 0 || newWindow < newMax) {
    emitEvent(F("CONFIG_DENIED"), F("reason=invalid_policy_or_active_session"));
    return;
  }
  if (fullPolicy &&
      (!parseUnsigned(argv[3], 86400000UL, newWindowMs) || newWindowMs < 60000UL ||
       !parseUnsigned(argv[4], 10UL, newTries) || newTries < 1 ||
       !parseUnsigned(argv[5], 900000UL, newLockoutMs) || newLockoutMs < 5000UL ||
       !parseUnsigned(argv[6], 120000UL, newPinTimeoutMs) || newPinTimeoutMs < 5000UL ||
       !parseUnsigned(argv[7], 600000UL, newSessionTimeoutMs) || newSessionTimeoutMs < 10000UL ||
       !parseUnsigned(argv[8], 30000UL, newGuardianTimeoutMs) || newGuardianTimeoutMs < 1800UL ||
       !parseUnsigned(argv[9], 10000UL, newTransactionTimeoutMs) || newTransactionTimeoutMs < 500UL)) {
    emitEvent(F("CONFIG_DENIED"), F("reason=policy_value_out_of_safe_range"));
    return;
  }
  maxWithdrawal = newMax;
  windowLimit = newWindow;
  windowWithdrawn = 0;
  budgetWindowStartedAt = millis();
  if (fullPolicy) {
    budgetWindowMs = newWindowMs;
    maxPinFailures = (uint8_t)newTries;
    pinLockoutMs = newLockoutMs;
    pinEntryTimeoutMs = newPinTimeoutMs;
    sessionTimeoutMs = newSessionTimeoutMs;
    guardianTimeoutMs = newGuardianTimeoutMs;
    transactionDecisionTimeoutMs = newTransactionTimeoutMs;
  }
  emitEvent(F("POLICY_CONFIGURED"), F("window=uptime_based_demo_window"));
}

void handleCard(const char *card) {
  if (guardianRevokeLatched || !guardianFresh()) {
    emitEvent(F("CARD_REJECTED"), F("reason=guardian_unavailable"));
    return;
  }
  if (atmState != ATM_IDLE) {
    emitEvent(F("CARD_REJECTED"), F("reason=atm_not_idle"));
    return;
  }
  if (!validCardId(card)) {
    emitEvent(F("CARD_REJECTED"), F("reason=invalid_card_format"));
    return;
  }
  const int8_t idx = findAccount(card);
  if (idx < 0) {
    emitEvent(F("CARD_REJECTED"), F("reason=unknown_demo_card"));
    sendFrame(F("EVENT"), F("source=BOARD_REPORTED;event=UNKNOWN_CARD"));
    return;
  }
  Account &a = accounts[(uint8_t)idx];
  if (a.lockoutUntil && (int32_t)(millis() - a.lockoutUntil) < 0) {
    emitEvent(F("CARD_REJECTED"), F("reason=card_temporarily_locked"));
    return;
  }
  if (a.lockoutUntil && (int32_t)(millis() - a.lockoutUntil) >= 0) {
    a.lockoutUntil = 0;
    a.failedPins = 0;
  }
  activeAccount = idx;
  strncpy(activeCardId, a.cardId, sizeof(activeCardId) - 1);
  activeCardId[sizeof(activeCardId) - 1] = '\0';
  pinEntryStartedAt = millis();
  lastCustomerActivityAt = millis();
  setAtmState(ATM_PIN_PENDING);
  char details[40];
  snprintf_P(details, sizeof(details), PSTR("tries=%u;timeout_ms=%lu"),
             (unsigned)maxPinFailures, pinEntryTimeoutMs);
  emitEvent(F("PIN_REQUIRED"), details);
  sendFrame(F("EVENT"), F("source=BOARD_REPORTED;event=CARD_ACCEPTED"));
}

void recordPinFailure(Account &a) {
  if (a.failedPins < 255) ++a.failedPins;
  char details[32];
  const uint8_t remaining = a.failedPins >= maxPinFailures ? 0 : (uint8_t)(maxPinFailures - a.failedPins);
  snprintf_P(details, sizeof(details), PSTR("remaining=%u"), (unsigned)remaining);
  emitEvent(F("PIN_FAILED"), details);
  char eventPayload[48];
  snprintf_P(eventPayload, sizeof(eventPayload), PSTR("source=BOARD_REPORTED;event=PIN_FAIL;count=%u"), (unsigned)a.failedPins);
  sendFrame(F("EVENT"), eventPayload);
  if (a.failedPins >= maxPinFailures) {
    a.lockoutUntil = millis() + pinLockoutMs;
    char lockDetails[28];
    snprintf_P(lockDetails, sizeof(lockDetails), PSTR("duration_ms=%lu"), pinLockoutMs);
    emitEvent(F("CARD_LOCKED"), lockDetails);
    resetCustomerSession();
    setAtmState(ATM_LOCKED);
  }
}

void handlePin(char *pin) {
  if (atmState != ATM_PIN_PENDING || activeAccount < 0) {
    emitEvent(F("PIN_REJECTED"), F("reason=no_card_waiting"));
    return;
  }
  if ((uint32_t)(millis() - pinEntryStartedAt) > pinEntryTimeoutMs) {
    emitEvent(F("PIN_REJECTED"), F("reason=entry_timeout"));
    resetCustomerSession();
    return;
  }
  Account &a = accounts[(uint8_t)activeAccount];
  if (!validPin(pin) || !pinEqualsConstantWork(pin, a.pin)) {
    recordPinFailure(a);
    return;
  }
  a.failedPins = 0;
  lastCustomerActivityAt = millis();
  char details[32];
  snprintf_P(details, sizeof(details), PSTR("card=%s"), a.cardId);
  emitEvent(F("AUTHENTICATED"), details);
  sendFrame(F("EVENT"), F("source=BOARD_REPORTED;event=PIN_OK"));
  setAtmState(ATM_AUTHENTICATED);
}

void handleChangePin(char *currentPin, char *newPin, char *confirmation) {
  if (atmState != ATM_AUTHENTICATED || activeAccount < 0 || !guardianFresh()) {
    emitEvent(F("PIN_CHANGE_DENIED"), F("reason=not_authenticated_or_guardian"));
    return;
  }
  Account &a = accounts[(uint8_t)activeAccount];
  if (!validPin(currentPin) || !pinEqualsConstantWork(currentPin, a.pin)) {
    recordPinFailure(a);
    return;
  }
  if (!validPin(newPin) || !validPin(confirmation) ||
      !pinEqualsConstantWork(newPin, confirmation)) {
    emitEvent(F("PIN_CHANGE_DENIED"), F("reason=invalid_format_or_confirmation_mismatch"));
    return;
  }
  strncpy(a.pin, newPin, sizeof(a.pin) - 1);
  a.pin[sizeof(a.pin) - 1] = '\0';
  a.failedPins = 0;
  lastCustomerActivityAt = millis();
  emitEvent(F("PIN_CHANGED"), F("storage=RAM_ONLY;credential_not_logged"));
  sendFrame(F("EVENT"), F("source=BOARD_REPORTED;event=PIN_CHANGED"));
}

void handleBalance() {
  if (atmState != ATM_AUTHENTICATED || activeAccount < 0 || !guardianFresh()) {
    emitEvent(F("BALANCE_DENIED"), F("reason=not_authenticated_or_guardian"));
    return;
  }
  lastCustomerActivityAt = millis();
  char details[32];
  snprintf_P(details, sizeof(details), PSTR("amount=%lu"), (unsigned long)accounts[(uint8_t)activeAccount].balance);
  emitEvent(F("BALANCE"), details);
}

void handleWithdraw(const char *amountText) {
  if (atmState != ATM_AUTHENTICATED || activeAccount < 0) {
    emitEvent(F("WITHDRAWAL_DENIED"), F("reason=not_authenticated"));
    return;
  }
  if (!guardianFresh()) {
    enterGuardianLock(F("Guardian link unavailable at withdrawal request."));
    return;
  }
  uint32_t amount = 0;
  if (!parseUnsigned(amountText, 1000000UL, amount) || amount == 0 || amount % 50UL != 0) {
    ++txDeniedCount;
    emitEvent(F("WITHDRAWAL_DENIED"), F("reason=invalid_amount_or_denomination"));
    return;
  }
  Account &a = accounts[(uint8_t)activeAccount];
  if (amount > maxWithdrawal) {
    ++txDeniedCount;
    emitEvent(F("WITHDRAWAL_DENIED"), F("reason=per_transaction_limit"));
    return;
  }
  if (amount > a.balance) {
    ++txDeniedCount;
    emitEvent(F("WITHDRAWAL_DENIED"), F("reason=insufficient_balance"));
    return;
  }
  if ((uint32_t)(millis() - budgetWindowStartedAt) >= budgetWindowMs) {
    budgetWindowStartedAt = millis();
    windowWithdrawn = 0;
  }
  if (windowWithdrawn > windowLimit || amount > windowLimit - windowWithdrawn) {
    ++txDeniedCount;
    emitEvent(F("WITHDRAWAL_DENIED"), F("reason=uptime_window_limit"));
    return;
  }
  uint16_t plan[4] = {0, 0, 0, 0};
  if (!makeNotePlan(amount, plan)) {
    ++txDeniedCount;
    emitEvent(F("WITHDRAWAL_DENIED"), F("reason=virtual_cash_unavailable"));
    return;
  }

  txPendingAmount = amount;
  memcpy(txPendingPlan, plan, sizeof(plan));
  snprintf_P(txPendingId, sizeof(txPendingId), PSTR("T%07lu"), (unsigned long)(++txCounter));
  txPendingStartedAt = millis();
  lastCustomerActivityAt = millis();
  setAtmState(ATM_WITHDRAW_PENDING);

  char payload[48];
  snprintf_P(payload, sizeof(payload), PSTR("id=%s;amount=%lu"), txPendingId, (unsigned long)amount);
  sendFrame(F("REQUEST"), payload);
  char details[40];
  snprintf_P(details, sizeof(details), PSTR("id=%s;amount=%lu"), txPendingId, (unsigned long)amount);
  emitEvent(F("WITHDRAWAL_PENDING"), details);
}

void handleCommand(char *line) {
  char work[USB_LINE_MAX];
  strncpy(work, line, sizeof(work) - 1);
  work[sizeof(work) - 1] = '\0';
  for (size_t i = 0; work[i]; ++i) work[i] = (char)toupper((unsigned char)work[i]);

  char *argv[10] = {0};
  uint8_t argc = 0;
  char *save = NULL;
  char *token = strtok_r(work, " \t", &save);
  while (token && argc < 10) {
    argv[argc++] = token;
    token = strtok_r(NULL, " \t", &save);
  }
  if (token) {
    emitEvent(F("COMMAND_REJECTED"), F("reason=too_many_fields"));
    secureClear(work, sizeof(work));
    return;
  }
  if (argc == 0) { secureClear(work, sizeof(work)); return; }

  if (STREQ(argv[0], "HELP")) {
    printHelp();
  } else if (STREQ(argv[0], "STATUS")) {
    printStatus();
  } else if (STREQ(argv[0], "JOURNAL")) {
    Serial.println(F("ATM_JOURNAL_BEGIN"));
    for (uint8_t i = 0; i < journalCount; ++i) {
      const uint8_t idx = (uint8_t)((journalNext + JOURNAL_SIZE - journalCount + i) % JOURNAL_SIZE);
      Serial.println(journal[idx]);
    }
    Serial.println(F("ATM_JOURNAL_END"));
  } else if (STREQ(argv[0], "ADD_ACCOUNT") && argc == 4) {
    handleAddAccount(argv[1], argv[2], argv[3]);
  } else if (STREQ(argv[0], "SET_CASH") && argc == 5) {
    handleSetCash(argv[1], argv[2], argv[3], argv[4]);
  } else if (STREQ(argv[0], "SET_POLICY") && (argc == 3 || argc == 10)) {
    handleSetPolicy(argv, argc);
  } else if (STREQ(argv[0], "CARD") && argc == 2) {
    handleCard(argv[1]);
  } else if (STREQ(argv[0], "PIN") && argc == 2) {
    handlePin(argv[1]);
  } else if (STREQ(argv[0], "CHANGE_PIN") && argc == 4) {
    handleChangePin(argv[1], argv[2], argv[3]);
  } else if (STREQ(argv[0], "BALANCE") && argc == 1) {
    handleBalance();
  } else if (STREQ(argv[0], "WITHDRAW") && argc == 2) {
    handleWithdraw(argv[1]);
  } else if (STREQ(argv[0], "CANCEL") && argc == 1) {
    if (atmState == ATM_PIN_PENDING || atmState == ATM_AUTHENTICATED) {
      emitEvent(F("SESSION_CANCELLED"), F("reason=customer_cancel"));
      resetCustomerSession();
    } else {
      emitEvent(F("CANCEL_IGNORED"), F("reason=no_customer_session"));
    }
  } else if (STREQ(argv[0], "LOGOUT") && argc == 1) {
    if (atmState == ATM_AUTHENTICATED) {
      emitEvent(F("LOGOUT"), F("reason=customer_requested"));
      resetCustomerSession();
    } else {
      emitEvent(F("LOGOUT_IGNORED"), F("reason=no_authenticated_session"));
    }
  } else if (STREQ(argv[0], "FIXTURE_MISMATCH") && argc == 1) {
    sendFrame(F("EVENT"), F("source=SIMULATED;event=PROFILE_MISMATCH"));
    emitEvent(F("FIXTURE_SENT"), F("source=SIMULATED"));
  } else {
    emitEvent(F("COMMAND_REJECTED"), F("reason=unknown_command_or_arguments"));
    Serial.println(F("Send HELP for command syntax."));
  }
  secureClear(work, sizeof(work));
}

void pollUsb() {
  while (Serial.available()) {
    const char c = (char)Serial.read();
    if (c == '\n') {
      if (!droppingUsbLine && usbLength > 0) {
        usbBuffer[usbLength] = '\0';
        handleCommand(usbBuffer);
      } else if (droppingUsbLine) {
        emitEvent(F("COMMAND_REJECTED"), F("reason=overlong_line"));
      }
      secureClear(usbBuffer, sizeof(usbBuffer));
      usbLength = 0;
      droppingUsbLine = false;
    } else if (c != '\r') {
      if (usbLength >= USB_LINE_MAX - 1) droppingUsbLine = true;
      else if (!droppingUsbLine) usbBuffer[usbLength++] = c;
    }
  }
}

void setup() {
  Serial.begin(USB_BAUD);
  GuardianSerial.begin(PEER_BAUD);
  memset(accounts, 0, sizeof(accounts));
  makeSession();
  budgetWindowStartedAt = millis();
  atmState = ATM_UNCOMMISSIONED;
  Serial.println();
  Serial.println(F("SENTINEL ATM CONTROLLER V3.2 READY"));
  Serial.println(F("EDUCATIONAL DEMO: fictional accounts; no physical dispensing."));
  Serial.println(F("No default card or PIN exists. Runtime provisioning required."));
  Serial.print(F("BUILD (self-reported): "));
  Serial.println(F("UNO-ATM-V3.2"));
  Serial.print(F("SESSION: "));
  Serial.println(sessionId);
  printHelp();
  handshakeStartedAt = millis();
  sendFrameAtSequence(F("HELLO"), F("UNO-ATM-V3"), 1);
  lastHelloAt = handshakeStartedAt;
}

void loop() {
  const uint32_t now = millis();
  pollGuardian();
  pollUsb();

  if (!handshakeComplete && !guardianRevokeLatched &&
      (uint32_t)(now - handshakeStartedAt) >= HANDSHAKE_TIMEOUT_MS) {
    enterGuardianLock(F("V3 handshake timeout; clean paired restart required."));
  }

  if (!handshakeComplete && !guardianRevokeLatched &&
      (uint32_t)(now - lastHelloAt) >= HELLO_RETRY_MS) {
    ++helloRetryCount;
    if ((helloRetryCount % 5UL) == 1UL) {
      Serial.print(F("[LINK_RETRY] Re-sending identical UNO HELLO seq=1; retries="));
      Serial.println(helloRetryCount);
    }
    sendFrameAtSequence(F("HELLO"), F("UNO-ATM-V3"), 1);
    lastHelloAt = now;
  }

  if (handshakeComplete && !statePublished) sendState();
  if (handshakeComplete && !guardianRevokeLatched && !awaitingGuardianStatus &&
      (uint32_t)(now - lastHeartbeatAt) >= HEARTBEAT_MS)
    sendHeartbeat(now);

  if (handshakeComplete && !guardianRevokeLatched) {
    const uint32_t freshnessBase = lastGuardianStatusAt ? lastGuardianStatusAt : lastGuardianFrameAt;
    if (freshnessBase != 0 && (uint32_t)(now - freshnessBase) > guardianTimeoutMs)
      enterGuardianLock(F("Guardian status timeout."));
  }

  if (atmState == ATM_PIN_PENDING &&
      (uint32_t)(now - pinEntryStartedAt) > pinEntryTimeoutMs) {
    emitEvent(F("PIN_TIMEOUT"), F("reason=entry_timeout"));
    resetCustomerSession();
  }
  if (atmState == ATM_AUTHENTICATED &&
      (uint32_t)(now - lastCustomerActivityAt) > sessionTimeoutMs) {
    emitEvent(F("SESSION_TIMEOUT"), F("reason=idle_timeout"));
    resetCustomerSession();
  }
  if (atmState == ATM_WITHDRAW_PENDING &&
      (uint32_t)(now - txPendingStartedAt) > transactionDecisionTimeoutMs) {
    ++txDeniedCount;
    emitEvent(F("WITHDRAWAL_DENIED"), F("reason=guardian_decision_timeout"));
    enterGuardianLock(F("No matching per-transaction guardian decision arrived."));
  }
  if (atmState == ATM_LOCKED) {
    bool anyLockout = false;
    for (uint8_t i = 0; i < MAX_ACCOUNTS; ++i) {
      if (accounts[i].used && accounts[i].lockoutUntil &&
          (int32_t)(now - accounts[i].lockoutUntil) < 0) anyLockout = true;
    }
    if (!anyLockout) {
      for (uint8_t i = 0; i < MAX_ACCOUNTS; ++i) {
        accounts[i].failedPins = 0;
        accounts[i].lockoutUntil = 0;
      }
      setAtmState(hasConfiguredAccount() ? ATM_IDLE : ATM_UNCOMMISSIONED);
      emitEvent(F("LOCKOUT_EXPIRED"), F("reason=timed_lockout_completed"));
    }
  }
}
