/*
 * SENTINEL ATM Controller Firmware v2
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

static const uint8_t PEER_RX_PIN = 2;
static const uint8_t PEER_TX_PIN = 3;
static const unsigned long PEER_BAUD = 9600;
static const unsigned long USB_BAUD = 115200;
static const unsigned long HEARTBEAT_MS = 500;
static const unsigned long HELLO_RETRY_MS = 1000;
static const unsigned long GUARDIAN_TIMEOUT_MS = 2600;
static const unsigned long PIN_ENTRY_TIMEOUT_MS = 30000;
static const unsigned long SESSION_TIMEOUT_MS = 60000;
static const unsigned long PIN_LOCKOUT_MS = 60000;
static const unsigned long BUDGET_WINDOW_MS = 86400000UL;
static const uint32_t DEFAULT_MAX_WITHDRAWAL = 20000UL;
static const uint32_t DEFAULT_WINDOW_LIMIT = 40000UL;
static const uint8_t MAX_ACCOUNTS = 4;
static const uint8_t MAX_PIN_LENGTH = 6;
static const uint8_t MAX_PIN_FAILURES = 3;
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
uint32_t windowWithdrawn = 0;
uint32_t budgetWindowStartedAt = 0;
uint32_t customerSessionStartedAt = 0;
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
uint32_t lastHeartbeatAt = 0;
uint32_t lastHelloAt = 0;
bool handshakeComplete = false;
bool guardianRevokeLatched = false;
bool statePublished = false;
uint32_t lastJournalAt = 0;
char journal[JOURNAL_SIZE][32];
uint8_t journalNext = 0;
uint8_t journalCount = 0;

const char *stateName(AtmState s) {
  switch (s) {
    case ATM_UNCOMMISSIONED: return "UNCOMMISSIONED";
    case ATM_IDLE: return "IDLE";
    case ATM_PIN_PENDING: return "PIN_PENDING";
    case ATM_AUTHENTICATED: return "AUTHENTICATED";
    case ATM_WITHDRAW_PENDING: return "WITHDRAW_PENDING";
    case ATM_LOCKED: return "LOCKED";
    case ATM_GUARDIAN_LOCKED: return "GUARDIAN_LOCKED";
  }
  return "UNKNOWN";
}

void secureClear(char *buffer, size_t length) {
  volatile char *p = buffer;
  while (length--) *p++ = '\0';
}

void journalEvent(const char *eventName) {
  strncpy(journal[journalNext], eventName, sizeof(journal[journalNext]) - 1);
  journal[journalNext][sizeof(journal[journalNext]) - 1] = '\0';
  journalNext = (uint8_t)((journalNext + 1) % JOURNAL_SIZE);
  if (journalCount < JOURNAL_SIZE) ++journalCount;
}

void emitEvent(const char *name, const char *details) {
  Serial.print(F("ATM_EVENT|"));
  Serial.print(name);
  Serial.print('|');
  Serial.println((details && details[0]) ? details : "-");
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
  snprintf(sessionId, sizeof(sessionId), "U%08lX", (unsigned long)micros());
}

bool sendFrame(const char *type, const char *payload) {
  char prefix[FRAME_MAX];
  const uint32_t seq = ++txSequence;
  const int n = snprintf(prefix, sizeof(prefix), "S2|%s|%s|%lu|%s", type,
                         sessionId, (unsigned long)seq,
                         (payload && payload[0]) ? payload : "-");
  if (n <= 0 || (size_t)n >= sizeof(prefix)) {
    Serial.println(F("[FAULT] Outgoing peer frame overflow."));
    guardianRevokeLatched = true;
    guardianLink = LINK_REVOKED;
    if (atmState != ATM_GUARDIAN_LOCKED) atmState = ATM_GUARDIAN_LOCKED;
    return false;
  }
  const uint16_t crc = crc16CcittFalse((const uint8_t *)prefix, (size_t)n);
  GuardianSerial.print(prefix);
  GuardianSerial.print('|');
  char crcText[5];
  snprintf(crcText, sizeof(crcText), "%04X", crc);
  GuardianSerial.print(crcText);
  GuardianSerial.print('\n');
  return true;
}

bool parseFrame(char *line, char fields[5][48], uint32_t &seqOut) {
  const size_t len = strlen(line);
  if (len < 12 || len > FRAME_MAX - 2) return false;
  char *lastSep = strrchr(line, '|');
  if (!lastSep || strlen(lastSep + 1) != 4) return false;
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
  if (strcmp(fields[0], "S2") != 0 || !validSession(fields[2])) return false;
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
    if (result > (maximum - digit) / 10UL) return false;
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

bool guardianFresh() {
  return handshakeComplete && !guardianRevokeLatched &&
         guardianLink == LINK_OBSERVING &&
         lastGuardianFrameAt != 0 &&
         (uint32_t)(millis() - lastGuardianFrameAt) <= GUARDIAN_TIMEOUT_MS;
}

void sendState() {
  if (!handshakeComplete) return;
  char payload[48];
  snprintf(payload, sizeof(payload), "atm=%s;auth=%u;tx=%lu",
           stateName(atmState),
           (atmState == ATM_AUTHENTICATED || atmState == ATM_WITHDRAW_PENDING) ? 1 : 0,
           (unsigned long)txCommittedCount);
  sendFrame("STATE", payload);
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
  else setAtmState(freeAccountSlot() >= 0 ? ATM_IDLE : ATM_UNCOMMISSIONED);
}

void enterGuardianLock(const char *reason) {
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
    emitEvent("GUARDIAN_REVOKED", "dispense=DENIED");
  }
}

void sendHeartbeat(uint32_t now) {
  if (!handshakeComplete) return;
  char payload[48];
  snprintf(payload, sizeof(payload), "state=%s;up=%lu",
           stateName(atmState), (unsigned long)now);
  sendFrame("HEARTBEAT", payload);
  lastHeartbeatAt = now;
}

bool parsePayloadField(const char *payload, const char *key, char *out, size_t outSize) {
  if (!payload || !key || !out || outSize < 2) return false;
  const size_t keyLen = strlen(key);
  const char *cursor = payload;
  while (*cursor) {
    const char *end = strchr(cursor, ';');
    const size_t tokenLen = end ? (size_t)(end - cursor) : strlen(cursor);
    if (tokenLen > keyLen && strncmp(cursor, key, keyLen) == 0 && cursor[keyLen] == '=') {
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
  return parsePayloadField(payload, "id", id, sizeof(id)) &&
         txPendingId[0] && strcmp(id, txPendingId) == 0;
}

bool makeNotePlan(uint32_t amount, uint16_t plan[4]) {
  if (amount == 0 || amount % 50UL != 0) return false;
  const uint32_t available = (uint32_t)cashInventory.notes500 * 500UL +
                             (uint32_t)cashInventory.notes200 * 200UL +
                             (uint32_t)cashInventory.notes100 * 100UL +
                             (uint32_t)cashInventory.notes50 * 50UL;
  if (available < amount) return false;

  const int max500 = (int)((amount / 500UL < cashInventory.notes500) ?
                           amount / 500UL : cashInventory.notes500);
  for (int n500 = max500; n500 >= 0; --n500) {
    uint32_t rem500 = amount - (uint32_t)n500 * 500UL;
    const int max200 = (int)((rem500 / 200UL < cashInventory.notes200) ?
                             rem500 / 200UL : cashInventory.notes200);
    for (int n200 = max200; n200 >= 0; --n200) {
      uint32_t rem200 = rem500 - (uint32_t)n200 * 200UL;
      const int max100 = (int)((rem200 / 100UL < cashInventory.notes100) ?
                               rem200 / 100UL : cashInventory.notes100);
      for (int n100 = max100; n100 >= 0; --n100) {
        const uint32_t rem100 = rem200 - (uint32_t)n100 * 100UL;
        if (rem100 % 50UL != 0 || rem100 / 50UL > cashInventory.notes50) continue;
        plan[0] = (uint16_t)n500;
        plan[1] = (uint16_t)n200;
        plan[2] = (uint16_t)n100;
        plan[3] = (uint16_t)(rem100 / 50UL);
        return true;
      }
    }
  }
  return false;
}

void completeWithdrawal() {
  if (activeAccount < 0 || txPendingAmount == 0 ||
      atmState != ATM_WITHDRAW_PENDING || guardianRevokeLatched) {
    enterGuardianLock("Permit arrived without a matching pending transaction.");
    return;
  }
  Account &account = accounts[(uint8_t)activeAccount];
  if (account.balance < txPendingAmount ||
      cashInventory.notes500 < txPendingPlan[0] ||
      cashInventory.notes200 < txPendingPlan[1] ||
      cashInventory.notes100 < txPendingPlan[2] ||
      cashInventory.notes50 < txPendingPlan[3]) {
    enterGuardianLock("Local transaction preconditions changed before authorization.");
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
  snprintf(details, sizeof(details), "id=%s;amount=%lu;balance=%lu",
           txPendingId, (unsigned long)txPendingAmount, (unsigned long)account.balance);
  emitEvent("WITHDRAWAL_APPROVED", details);
  sendFrame("EVENT", details);
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
    enterGuardianLock("Malformed guardian frame or CRC/version validation failure.");
    return;
  }
  if (strcmp(fields[2], sessionId) != 0) {
    enterGuardianLock("Guardian session mismatch.");
    return;
  }
  if (seq != lastGuardianSequence + 1) {
    enterGuardianLock("Guardian sequence gap, duplicate or stale frame.");
    return;
  }
  lastGuardianSequence = seq;
  lastGuardianFrameAt = millis();
  const char *type = fields[1];
  const char *payload = fields[4];

  if (strcmp(type, "HELLO") == 0) {
    if (strncmp(payload, "ESP32-SENTINEL-V2", 17) != 0) {
      enterGuardianLock("Unexpected guardian protocol identity.");
      return;
    }
    handshakeComplete = true;
    if (!guardianRevokeLatched) guardianLink = LINK_OBSERVING;
    Serial.println(F("[LINK] V2 guardian handshake observed (identity is self-reported)."));
    sendFrame("ACK", "HELLO_ACCEPTED");
    if (!statePublished) sendState();
  } else if (strcmp(type, "ACK") == 0) {
    if (!handshakeComplete || strcmp(payload, "HELLO_ACCEPTED") != 0) {
      enterGuardianLock("Unexpected guardian ACK.");
      return;
    }
  } else if (strcmp(type, "STATUS") == 0) {
    if (guardianRevokeLatched) return;
    guardianLink = LINK_OBSERVING;
  } else if (strcmp(type, "PERMIT") == 0) {
    if (!guardianFresh() || atmState != ATM_WITHDRAW_PENDING || !transactionIdMatches(payload)) {
      enterGuardianLock("Permit missing freshness or did not match the pending transaction.");
      return;
    }
    completeWithdrawal();
  } else if (strcmp(type, "DENY") == 0) {
    if (atmState != ATM_WITHDRAW_PENDING || !transactionIdMatches(payload)) {
      enterGuardianLock("Denial did not match the pending transaction.");
      return;
    }
    ++txDeniedCount;
    emitEvent("WITHDRAWAL_DENIED", payload);
    txPendingAmount = 0;
    txPendingId[0] = '\0';
    memset(txPendingPlan, 0, sizeof(txPendingPlan));
    setAtmState(ATM_AUTHENTICATED);
  } else if (strcmp(type, "REVOKE") == 0) {
    enterGuardianLock("Guardian revoked controller authority.");
  } else {
    enterGuardianLock("Unknown guardian message type.");
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
        enterGuardianLock("Overlong guardian frame discarded.");
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
  Serial.println(F("  SET_POLICY <MAX_PER_TXN> <WINDOW_LIMIT>"));
  Serial.println(F("  CARD <CARD_ID> | PIN <PIN> | BALANCE | WITHDRAW <AMOUNT>"));
  Serial.println(F("  CANCEL | LOGOUT | STATUS | JOURNAL | HELP | FIXTURE_MISMATCH"));
  Serial.println(F("Accounts/PINs/cash are RAM-only and are erased on reset."));
}

void handleAddAccount(char *card, char *pin, char *balanceText) {
  if (guardianRevokeLatched || atmState == ATM_PIN_PENDING ||
      atmState == ATM_AUTHENTICATED || atmState == ATM_WITHDRAW_PENDING) {
    emitEvent("CONFIG_DENIED", "reason=customer_session_or_guardian_lock");
    return;
  }
  if (!validCardId(card) || !validPin(pin)) {
    emitEvent("CONFIG_DENIED", "reason=invalid_card_or_pin_format");
    return;
  }
  uint32_t balance = 0;
  if (!parseUnsigned(balanceText, 1000000UL, balance)) {
    emitEvent("CONFIG_DENIED", "reason=invalid_balance");
    return;
  }
  if (findAccount(card) >= 0) {
    emitEvent("CONFIG_DENIED", "reason=duplicate_card");
    return;
  }
  const int8_t slot = freeAccountSlot();
  if (slot < 0) {
    emitEvent("CONFIG_DENIED", "reason=max_accounts_reached");
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
  snprintf(details, sizeof(details), "card=%s;balance=%lu", a.cardId, (unsigned long)a.balance);
  emitEvent("ACCOUNT_PROVISIONED", details);
}

void handleSetCash(char *c500, char *c200, char *c100, char *c50) {
  uint32_t v500, v200, v100, v50;
  if (activeAccount >= 0 || atmState == ATM_WITHDRAW_PENDING ||
      !parseUnsigned(c500, 9999, v500) || !parseUnsigned(c200, 9999, v200) ||
      !parseUnsigned(c100, 9999, v100) || !parseUnsigned(c50, 9999, v50)) {
    emitEvent("CONFIG_DENIED", "reason=invalid_cash_or_active_session");
    return;
  }
  cashInventory.notes500 = (uint16_t)v500;
  cashInventory.notes200 = (uint16_t)v200;
  cashInventory.notes100 = (uint16_t)v100;
  cashInventory.notes50 = (uint16_t)v50;
  emitEvent("CASH_CONFIGURED", "currency=INR;values=500,200,100,50");
}

void handleSetPolicy(char *maxText, char *windowText) {
  uint32_t newMax, newWindow;
  if (activeAccount >= 0 || atmState == ATM_WITHDRAW_PENDING ||
      !parseUnsigned(maxText, 1000000UL, newMax) ||
      !parseUnsigned(windowText, 1000000UL, newWindow) ||
      newMax == 0 || newWindow < newMax) {
    emitEvent("CONFIG_DENIED", "reason=invalid_policy_or_active_session");
    return;
  }
  maxWithdrawal = newMax;
  windowLimit = newWindow;
  windowWithdrawn = 0;
  budgetWindowStartedAt = millis();
  emitEvent("POLICY_CONFIGURED", "window=uptime_based_demo_window");
}

void handleCard(const char *card) {
  if (guardianRevokeLatched || !guardianFresh()) {
    emitEvent("CARD_REJECTED", "reason=guardian_unavailable");
    return;
  }
  if (atmState != ATM_IDLE) {
    emitEvent("CARD_REJECTED", "reason=atm_not_idle");
    return;
  }
  if (!validCardId(card)) {
    emitEvent("CARD_REJECTED", "reason=invalid_card_format");
    return;
  }
  const int8_t idx = findAccount(card);
  if (idx < 0) {
    emitEvent("CARD_REJECTED", "reason=unknown_demo_card");
    sendFrame("EVENT", "source=BOARD_REPORTED;event=UNKNOWN_CARD");
    return;
  }
  Account &a = accounts[(uint8_t)idx];
  if (a.lockoutUntil && (int32_t)(millis() - a.lockoutUntil) < 0) {
    emitEvent("CARD_REJECTED", "reason=card_temporarily_locked");
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
  emitEvent("PIN_REQUIRED", "tries=3;timeout_ms=30000");
  sendFrame("EVENT", "source=BOARD_REPORTED;event=CARD_ACCEPTED");
}

void handlePin(char *pin) {
  if (atmState != ATM_PIN_PENDING || activeAccount < 0) {
    emitEvent("PIN_REJECTED", "reason=no_card_waiting");
    return;
  }
  if ((uint32_t)(millis() - pinEntryStartedAt) > PIN_ENTRY_TIMEOUT_MS) {
    emitEvent("PIN_REJECTED", "reason=entry_timeout");
    resetCustomerSession();
    return;
  }
  Account &a = accounts[(uint8_t)activeAccount];
  if (!validPin(pin) || !pinEqualsConstantWork(pin, a.pin)) {
    ++a.failedPins;
    char details[32];
    snprintf(details, sizeof(details), "remaining=%u", (unsigned)(MAX_PIN_FAILURES - (a.failedPins < MAX_PIN_FAILURES ? a.failedPins : MAX_PIN_FAILURES)));
    emitEvent("PIN_FAILED", details);
    char eventPayload[48];
    snprintf(eventPayload, sizeof(eventPayload), "source=BOARD_REPORTED;event=PIN_FAIL;count=%u", (unsigned)a.failedPins);
    sendFrame("EVENT", eventPayload);
    if (a.failedPins >= MAX_PIN_FAILURES) {
      a.lockoutUntil = millis() + PIN_LOCKOUT_MS;
      emitEvent("CARD_LOCKED", "duration_ms=60000");
      resetCustomerSession();
      setAtmState(ATM_LOCKED);
    }
    return;
  }
  a.failedPins = 0;
  customerSessionStartedAt = millis();
  lastCustomerActivityAt = millis();
  char details[32];
  snprintf(details, sizeof(details), "card=%s", a.cardId);
  emitEvent("AUTHENTICATED", details);
  sendFrame("EVENT", "source=BOARD_REPORTED;event=PIN_OK");
  setAtmState(ATM_AUTHENTICATED);
}

void handleBalance() {
  if (atmState != ATM_AUTHENTICATED || activeAccount < 0 || !guardianFresh()) {
    emitEvent("BALANCE_DENIED", "reason=not_authenticated_or_guardian");
    return;
  }
  lastCustomerActivityAt = millis();
  char details[32];
  snprintf(details, sizeof(details), "amount=%lu", (unsigned long)accounts[(uint8_t)activeAccount].balance);
  emitEvent("BALANCE", details);
}

void handleWithdraw(const char *amountText) {
  if (atmState != ATM_AUTHENTICATED || activeAccount < 0) {
    emitEvent("WITHDRAWAL_DENIED", "reason=not_authenticated");
    return;
  }
  if (!guardianFresh()) {
    enterGuardianLock("Guardian link unavailable at withdrawal request.");
    return;
  }
  uint32_t amount = 0;
  if (!parseUnsigned(amountText, 1000000UL, amount) || amount == 0 || amount % 50UL != 0) {
    ++txDeniedCount;
    emitEvent("WITHDRAWAL_DENIED", "reason=invalid_amount_or_denomination");
    return;
  }
  Account &a = accounts[(uint8_t)activeAccount];
  if (amount > maxWithdrawal) {
    ++txDeniedCount;
    emitEvent("WITHDRAWAL_DENIED", "reason=per_transaction_limit");
    return;
  }
  if (amount > a.balance) {
    ++txDeniedCount;
    emitEvent("WITHDRAWAL_DENIED", "reason=insufficient_balance");
    return;
  }
  if ((uint32_t)(millis() - budgetWindowStartedAt) >= BUDGET_WINDOW_MS) {
    budgetWindowStartedAt = millis();
    windowWithdrawn = 0;
  }
  if (windowWithdrawn > windowLimit || amount > windowLimit - windowWithdrawn) {
    ++txDeniedCount;
    emitEvent("WITHDRAWAL_DENIED", "reason=uptime_window_limit");
    return;
  }
  uint16_t plan[4] = {0, 0, 0, 0};
  if (!makeNotePlan(amount, plan)) {
    ++txDeniedCount;
    emitEvent("WITHDRAWAL_DENIED", "reason=virtual_cash_unavailable");
    return;
  }

  txPendingAmount = amount;
  memcpy(txPendingPlan, plan, sizeof(plan));
  snprintf(txPendingId, sizeof(txPendingId), "T%07lu", (unsigned long)(++txCounter));
  txPendingStartedAt = millis();
  lastCustomerActivityAt = millis();
  setAtmState(ATM_WITHDRAW_PENDING);

  char payload[48];
  snprintf(payload, sizeof(payload), "id=%s;amount=%lu", txPendingId, (unsigned long)amount);
  sendFrame("REQUEST", payload);
  char details[40];
  snprintf(details, sizeof(details), "id=%s;amount=%lu", txPendingId, (unsigned long)amount);
  emitEvent("WITHDRAWAL_PENDING", details);
}

void handleCommand(char *line) {
  char work[USB_LINE_MAX];
  strncpy(work, line, sizeof(work) - 1);
  work[sizeof(work) - 1] = '\0';
  for (size_t i = 0; work[i]; ++i) work[i] = (char)toupper((unsigned char)work[i]);

  char *argv[7] = {0};
  uint8_t argc = 0;
  char *save = NULL;
  char *token = strtok_r(work, " \t", &save);
  while (token && argc < 7) {
    argv[argc++] = token;
    token = strtok_r(NULL, " \t", &save);
  }
  if (token) {
    emitEvent("COMMAND_REJECTED", "reason=too_many_fields");
    secureClear(work, sizeof(work));
    return;
  }
  if (argc == 0) { secureClear(work, sizeof(work)); return; }

  if (strcmp(argv[0], "HELP") == 0) {
    printHelp();
  } else if (strcmp(argv[0], "STATUS") == 0) {
    printStatus();
  } else if (strcmp(argv[0], "JOURNAL") == 0) {
    Serial.println(F("ATM_JOURNAL_BEGIN"));
    for (uint8_t i = 0; i < journalCount; ++i) {
      const uint8_t idx = (uint8_t)((journalNext + JOURNAL_SIZE - journalCount + i) % JOURNAL_SIZE);
      Serial.println(journal[idx]);
    }
    Serial.println(F("ATM_JOURNAL_END"));
  } else if (strcmp(argv[0], "ADD_ACCOUNT") == 0 && argc == 4) {
    handleAddAccount(argv[1], argv[2], argv[3]);
  } else if (strcmp(argv[0], "SET_CASH") == 0 && argc == 5) {
    handleSetCash(argv[1], argv[2], argv[3], argv[4]);
  } else if (strcmp(argv[0], "SET_POLICY") == 0 && argc == 3) {
    handleSetPolicy(argv[1], argv[2]);
  } else if (strcmp(argv[0], "CARD") == 0 && argc == 2) {
    handleCard(argv[1]);
  } else if (strcmp(argv[0], "PIN") == 0 && argc == 2) {
    handlePin(argv[1]);
  } else if (strcmp(argv[0], "BALANCE") == 0 && argc == 1) {
    handleBalance();
  } else if (strcmp(argv[0], "WITHDRAW") == 0 && argc == 2) {
    handleWithdraw(argv[1]);
  } else if (strcmp(argv[0], "CANCEL") == 0 && argc == 1) {
    if (atmState == ATM_PIN_PENDING || atmState == ATM_AUTHENTICATED) {
      emitEvent("SESSION_CANCELLED", "reason=customer_cancel");
      resetCustomerSession();
    } else {
      emitEvent("CANCEL_IGNORED", "reason=no_customer_session");
    }
  } else if (strcmp(argv[0], "LOGOUT") == 0 && argc == 1) {
    if (atmState == ATM_AUTHENTICATED) {
      emitEvent("LOGOUT", "reason=customer_requested");
      resetCustomerSession();
    } else {
      emitEvent("LOGOUT_IGNORED", "reason=no_authenticated_session");
    }
  } else if (strcmp(argv[0], "FIXTURE_MISMATCH") == 0 && argc == 1) {
    sendFrame("EVENT", "source=SIMULATED;event=PROFILE_MISMATCH");
    emitEvent("FIXTURE_SENT", "source=SIMULATED");
  } else {
    emitEvent("COMMAND_REJECTED", "reason=unknown_command_or_arguments");
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
        emitEvent("COMMAND_REJECTED", "reason=overlong_line");
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
  Serial.println(F("SENTINEL ATM CONTROLLER V2 READY"));
  Serial.println(F("EDUCATIONAL DEMO: fictional accounts; no physical dispensing."));
  Serial.println(F("No default card or PIN exists. Runtime provisioning required."));
  Serial.print(F("BUILD (self-reported): "));
  Serial.println(F("UNO-ATM-V2"));
  Serial.print(F("SESSION: "));
  Serial.println(sessionId);
  printHelp();
  sendFrame("HELLO", "UNO-ATM-V2");
  lastHelloAt = millis();
}

void loop() {
  const uint32_t now = millis();
  pollGuardian();
  pollUsb();

  if (!handshakeComplete && now - lastHelloAt >= HELLO_RETRY_MS) {
    sendFrame("HELLO", "UNO-ATM-V2");
    lastHelloAt = now;
  }

  if (handshakeComplete && !statePublished) sendState();
  if (handshakeComplete && now - lastHeartbeatAt >= HEARTBEAT_MS)
    sendHeartbeat(now);

  if (handshakeComplete && lastGuardianFrameAt != 0 &&
      (uint32_t)(now - lastGuardianFrameAt) > GUARDIAN_TIMEOUT_MS) {
    enterGuardianLock("Guardian response timeout.");
  }

  if (atmState == ATM_PIN_PENDING &&
      (uint32_t)(now - pinEntryStartedAt) > PIN_ENTRY_TIMEOUT_MS) {
    emitEvent("PIN_TIMEOUT", "reason=entry_timeout");
    resetCustomerSession();
  }
  if (atmState == ATM_AUTHENTICATED &&
      (uint32_t)(now - lastCustomerActivityAt) > SESSION_TIMEOUT_MS) {
    emitEvent("SESSION_TIMEOUT", "reason=idle_timeout");
    resetCustomerSession();
  }
  if (atmState == ATM_WITHDRAW_PENDING &&
      (uint32_t)(now - txPendingStartedAt) > 1800UL) {
    ++txDeniedCount;
    emitEvent("WITHDRAWAL_DENIED", "reason=guardian_decision_timeout");
    enterGuardianLock("No matching per-transaction guardian decision arrived.");
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
      setAtmState(freeAccountSlot() >= 0 ? ATM_IDLE : ATM_UNCOMMISSIONED);
      emitEvent("LOCKOUT_EXPIRED", "reason=timed_lockout_completed");
    }
  }
}
