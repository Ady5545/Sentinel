/*
 * SENTINEL ESP32 Independent Guardian Firmware v2
 * Target: ESP32 Dev Module
 * UART2: RX=GPIO16, TX=GPIO17, 9600 8N1
 * USB diagnostics/operator configuration: Serial at 115200
 *
 * This is a research guardian, not a physical dispenser interlock and not
 * cryptographic attestation. CRC/session/sequence checks do not authenticate
 * a malicious UNO. Security limits are configurable RAM policy with defaults.
 */
#include <Arduino.h>
#include <string.h>
#include <stdlib.h>
#include <ctype.h>

static const int PEER_RX_PIN = 16;
static const int PEER_TX_PIN = 17;
static const unsigned long PEER_BAUD = 9600;
static const unsigned long USB_BAUD = 115200;
static const unsigned long DEFAULT_HEARTBEAT_TIMEOUT_MS = 1800UL;
static const unsigned long DEFAULT_LINK_TIMEOUT_MS = 2600UL;
static const unsigned long USB_STATUS_INTERVAL_MS = 2000UL;
static const unsigned long PEER_STATUS_INTERVAL_MS = 1000UL;
static const unsigned long DEFAULT_COMMIT_TIMEOUT_MS = 1800UL;
static const unsigned long DEFAULT_PIN_FAILURE_WINDOW_MS = 60000UL;
static const uint8_t DEFAULT_PIN_FAILURES_PER_WINDOW = 9;
static const uint32_t DEFAULT_MAX_TRANSACTION = 20000UL;
static const uint32_t DEFAULT_WINDOW_LIMIT = 40000UL;
static const unsigned long DEFAULT_BUDGET_WINDOW_MS = 86400000UL;
static const size_t FRAME_MAX = 120;
static const size_t USB_LINE_MAX = 96;

enum GuardianMode { GUARDIAN_STARTING, GUARDIAN_OBSERVING, GUARDIAN_REVOKED };
GuardianMode mode = GUARDIAN_STARTING;
char sessionId[13] = {0};
char rxBuffer[FRAME_MAX];
size_t rxLength = 0;
bool droppingLongFrame = false;
char usbBuffer[USB_LINE_MAX];
size_t usbLength = 0;
bool droppingUsbLine = false;
uint32_t txSequence = 0;
uint32_t lastUnoSequence = 0;
uint32_t lastValidUnoAt = 0;
uint32_t lastHeartbeatAt = 0;
uint32_t lastStatusAt = 0;
uint32_t lastPeerStatusAt = 0;
uint32_t budgetWindowStartedAt = 0;
uint32_t approvedWindowAmount = 0;
uint32_t maxTransaction = DEFAULT_MAX_TRANSACTION;
uint32_t windowLimit = DEFAULT_WINDOW_LIMIT;
unsigned long heartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS;
unsigned long linkTimeoutMs = DEFAULT_LINK_TIMEOUT_MS;
unsigned long commitTimeoutMs = DEFAULT_COMMIT_TIMEOUT_MS;
unsigned long pinFailureWindowMs = DEFAULT_PIN_FAILURE_WINDOW_MS;
uint8_t pinFailuresPerWindow = DEFAULT_PIN_FAILURES_PER_WINDOW;
unsigned long budgetWindowMs = DEFAULT_BUDGET_WINDOW_MS;
uint32_t lastTransactionNumber = 0;
uint32_t pendingPermitAmount = 0;
uint32_t pendingPermitStartedAt = 0;
uint32_t pinFailureWindowStartedAt = 0;
uint8_t pinFailuresInWindow = 0;
bool sessionEstablished = false;
bool heartbeatSeen = false;
bool revokeLatched = false;
bool reportedAuthenticated = false;
bool awaitingCommit = false;
char lastAtmState[22] = "UNKNOWN";
char pendingPermitId[12] = {0};
uint32_t committedTransactions = 0;
uint32_t deniedTransactions = 0;

void secureClear(char *buffer, size_t length) {
  volatile char *p = buffer;
  while (length--) *p++ = '\0';
}

const char *modeName() {
  switch (mode) {
    case GUARDIAN_STARTING: return "STARTING";
    case GUARDIAN_OBSERVING: return "OBSERVING";
    case GUARDIAN_REVOKED: return "REVOKED";
  }
  return "UNKNOWN";
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

bool sendFrame(const char *type, const char *payload) {
  char prefix[FRAME_MAX];
  const uint32_t seq = ++txSequence;
  const int n = snprintf(prefix, sizeof(prefix), "S2|%s|%s|%lu|%s", type,
                         sessionId[0] ? sessionId : "ESP000001",
                         (unsigned long)seq, (payload && payload[0]) ? payload : "-");
  if (n <= 0 || (size_t)n >= sizeof(prefix)) {
    Serial.println(F("[FAULT] Outgoing frame overflow; guardian revoked."));
    mode = GUARDIAN_REVOKED;
    revokeLatched = true;
    return false;
  }
  const uint16_t crc = crc16CcittFalse((const uint8_t *)prefix, (size_t)n);
  Serial2.print(prefix);
  Serial2.print('|');
  char crcText[5];
  snprintf(crcText, sizeof(crcText), "%04X", crc);
  Serial2.print(crcText);
  Serial2.print('\n');
  return true;
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
    if (result > maximum / 10UL ||
        (result == maximum / 10UL && digit > maximum % 10UL)) return false;
    result = result * 10UL + digit;
  }
  if (result > maximum) return false;
  value = result;
  return true;
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

bool stateNameValid(const char *state) {
  return strcmp(state, "UNCOMMISSIONED") == 0 ||
         strcmp(state, "IDLE") == 0 ||
         strcmp(state, "PIN_PENDING") == 0 ||
         strcmp(state, "AUTHENTICATED") == 0 ||
         strcmp(state, "WITHDRAW_PENDING") == 0 ||
         strcmp(state, "LOCKED") == 0 ||
         strcmp(state, "GUARDIAN_LOCKED") == 0;
}

bool isAuthenticatedState(const char *state) {
  return strcmp(state, "AUTHENTICATED") == 0 ||
         strcmp(state, "WITHDRAW_PENDING") == 0;
}

bool transitionAllowed(const char *from, const char *to) {
  if (strcmp(from, to) == 0) return true;
  if (strcmp(from, "UNKNOWN") == 0)
    return strcmp(to, "UNCOMMISSIONED") == 0 || strcmp(to, "IDLE") == 0;
  if (strcmp(from, "UNCOMMISSIONED") == 0)
    return strcmp(to, "IDLE") == 0 || strcmp(to, "GUARDIAN_LOCKED") == 0;
  if (strcmp(from, "IDLE") == 0)
    return strcmp(to, "PIN_PENDING") == 0 || strcmp(to, "LOCKED") == 0 ||
           strcmp(to, "UNCOMMISSIONED") == 0 || strcmp(to, "GUARDIAN_LOCKED") == 0;
  if (strcmp(from, "PIN_PENDING") == 0)
    return strcmp(to, "AUTHENTICATED") == 0 || strcmp(to, "IDLE") == 0 ||
           strcmp(to, "LOCKED") == 0 || strcmp(to, "GUARDIAN_LOCKED") == 0;
  if (strcmp(from, "AUTHENTICATED") == 0)
    return strcmp(to, "WITHDRAW_PENDING") == 0 || strcmp(to, "IDLE") == 0 ||
           strcmp(to, "LOCKED") == 0 || strcmp(to, "GUARDIAN_LOCKED") == 0;
  if (strcmp(from, "WITHDRAW_PENDING") == 0)
    return strcmp(to, "AUTHENTICATED") == 0 || strcmp(to, "LOCKED") == 0 ||
           strcmp(to, "GUARDIAN_LOCKED") == 0;
  if (strcmp(from, "LOCKED") == 0)
    return strcmp(to, "IDLE") == 0 || strcmp(to, "UNCOMMISSIONED") == 0 ||
           strcmp(to, "GUARDIAN_LOCKED") == 0;
  if (strcmp(from, "GUARDIAN_LOCKED") == 0)
    return strcmp(to, "GUARDIAN_LOCKED") == 0;
  return false;
}

bool validTransactionId(const char *id, uint32_t &number) {
  if (!id || id[0] != 'T' || strlen(id) < 2 || strlen(id) > 10) return false;
  return parseUnsigned(id + 1, 999999999UL, number) && number > 0;
}

void revoke(const char *reason) {
  if (revokeLatched) return;
  mode = GUARDIAN_REVOKED;
  revokeLatched = true;
  awaitingCommit = false;
  Serial.print(F("[REVOKE] "));
  Serial.println(reason);
  sendFrame("REVOKE", "POLICY_REVOKE");
}

void denyRequest(const char *id, const char *reason) {
  char payload[48];
  snprintf(payload, sizeof(payload), "id=%s;reason=%s", id, reason);
  ++deniedTransactions;
  sendFrame("DENY", payload);
  Serial.print(F("[DENY] "));
  Serial.println(payload);
}

void handleState(const char *payload) {
  char nextState[24];
  char authText[4];
  char txText[12];
  if (!parsePayloadField(payload, "atm", nextState, sizeof(nextState)) ||
      !parsePayloadField(payload, "auth", authText, sizeof(authText)) ||
      !parsePayloadField(payload, "tx", txText, sizeof(txText)) ||
      !stateNameValid(nextState) || (strcmp(authText, "0") != 0 && strcmp(authText, "1") != 0)) {
    revoke("Invalid STATE payload schema.");
    return;
  }
  uint32_t txCount = 0;
  if (!parseUnsigned(txText, 4294967295UL, txCount)) {
    revoke("Invalid STATE transaction counter.");
    return;
  }
  if (!transitionAllowed(lastAtmState, nextState)) {
    revoke("Illegal ATM state transition.");
    return;
  }
  const bool auth = strcmp(authText, "1") == 0;
  if (auth != isAuthenticatedState(nextState)) {
    revoke("Authentication flag conflicts with reported state.");
    return;
  }
  if (strcmp(nextState, "GUARDIAN_LOCKED") == 0 && !revokeLatched) {
    revoke("UNO reported guardian lock without a prior guardian event.");
    return;
  }
  strncpy(lastAtmState, nextState, sizeof(lastAtmState) - 1);
  lastAtmState[sizeof(lastAtmState) - 1] = '\0';
  reportedAuthenticated = auth;
}

void handleHeartbeat(const char *payload) {
  char state[24];
  char uptimeText[16];
  uint32_t uptime = 0;
  if (!parsePayloadField(payload, "state", state, sizeof(state)) ||
      !parsePayloadField(payload, "up", uptimeText, sizeof(uptimeText)) ||
      !stateNameValid(state) || strcmp(state, lastAtmState) != 0 ||
      !parseUnsigned(uptimeText, 4294967295UL, uptime)) {
    revoke("Malformed or inconsistent heartbeat.");
    return;
  }
  heartbeatSeen = true;
  lastHeartbeatAt = millis();
}

void handleEvent(const char *payload) {
  if (strstr(payload, "source=SIMULATED") != NULL &&
      (strstr(payload, "PROFILE_MISMATCH") != NULL ||
       strstr(payload, "PRIVILEGED_PATH") != NULL ||
       strstr(payload, "SEQUENCE_DIVERGENCE") != NULL)) {
    revoke("Configured simulated integrity-violation fixture received.");
    return;
  }
  if (strstr(payload, "event=PIN_FAIL") != NULL) {
    const uint32_t now = millis();
    if ((uint32_t)(now - pinFailureWindowStartedAt) > pinFailureWindowMs) {
      pinFailureWindowStartedAt = now;
      pinFailuresInWindow = 0;
    }
    if (pinFailuresInWindow < 255) ++pinFailuresInWindow;
    if (pinFailuresInWindow >= pinFailuresPerWindow) {
      revoke("Independent guardian PIN-failure rate threshold exceeded.");
      return;
    }
  }
  if (strstr(payload, "event=PIN_OK") != NULL) {
    // Successful authentication is an observation, not proof that the UNO is honest.
    Serial.println(F("[OBSERVE] UNO reports successful demo PIN verification."));
  }
  if (strstr(payload, "event=UNKNOWN_CARD") != NULL)
    Serial.println(F("[OBSERVE] Unknown demo card was reported by UNO."));
  if (strstr(payload, "id=") != NULL && awaitingCommit) {
    char id[12], amountText[12];
    uint32_t amount = 0;
    if (!parsePayloadField(payload, "id", id, sizeof(id)) ||
        !parsePayloadField(payload, "amount", amountText, sizeof(amountText)) ||
        strcmp(id, pendingPermitId) != 0 ||
        !parseUnsigned(amountText, 1000000UL, amount) ||
        amount != pendingPermitAmount) {
      revoke("Transaction commit did not match one-shot guardian permit.");
      return;
    }
    awaitingCommit = false;
    pendingPermitId[0] = '\0';
    pendingPermitAmount = 0;
    ++committedTransactions;
    Serial.println(F("[AUDIT] Matching controller-reported virtual transaction commit observed."));
  }
}

void handleRequest(const char *payload) {
  char id[12];
  char amountText[12];
  uint32_t amount = 0;
  uint32_t transactionNumber = 0;
  if (!parsePayloadField(payload, "id", id, sizeof(id)) ||
      !parsePayloadField(payload, "amount", amountText, sizeof(amountText)) ||
      !validTransactionId(id, transactionNumber) ||
      !parseUnsigned(amountText, 1000000UL, amount) || amount == 0 || amount % 50UL != 0) {
    revoke("Malformed transaction request.");
    return;
  }
  if (revokeLatched || mode == GUARDIAN_REVOKED) return;
  if (awaitingCommit) {
    revoke("New request arrived before previous transaction was reconciled.");
    return;
  }
  if (strcmp(lastAtmState, "WITHDRAW_PENDING") != 0 || !reportedAuthenticated) {
    revoke("Dispense request without an observed authenticated pending state.");
    return;
  }
  if (!heartbeatSeen || (uint32_t)(millis() - lastHeartbeatAt) > heartbeatTimeoutMs) {
    revoke("Transaction request arrived without a fresh heartbeat.");
    return;
  }
  if (transactionNumber <= lastTransactionNumber) {
    revoke("Transaction ID replay or non-monotonic identifier.");
    return;
  }
  lastTransactionNumber = transactionNumber;
  if (amount > maxTransaction) {
    denyRequest(id, "TX_LIMIT");
    return;
  }
  if ((uint32_t)(millis() - budgetWindowStartedAt) >= budgetWindowMs) {
    budgetWindowStartedAt = millis();
    approvedWindowAmount = 0;
  }
  if (approvedWindowAmount > windowLimit || amount > windowLimit - approvedWindowAmount) {
    denyRequest(id, "WINDOW_LIMIT");
    return;
  }

  approvedWindowAmount += amount;
  strncpy(pendingPermitId, id, sizeof(pendingPermitId) - 1);
  pendingPermitId[sizeof(pendingPermitId) - 1] = '\0';
  pendingPermitAmount = amount;
  pendingPermitStartedAt = millis();
  awaitingCommit = true;
  char permitPayload[20];
  snprintf(permitPayload, sizeof(permitPayload), "id=%s", id);
  sendFrame("PERMIT", permitPayload);
  Serial.print(F("[PERMIT] One-shot observation issued for "));
  Serial.print(id);
  Serial.print(F("; amount="));
  Serial.println(amount);
}

void handleUnoLine(char *line) {
  char fields[5][48] = {{0}};
  uint32_t seq = 0;
  if (!parseFrame(line, fields, seq)) {
    revoke("Malformed frame, overlong input, CRC or protocol-version failure.");
    return;
  }
  const char *type = fields[1];
  const char *incomingSession = fields[2];
  const char *payload = fields[4];

  if (!sessionEstablished) {
    if (strcmp(type, "HELLO") != 0 || strcmp(payload, "UNO-ATM-V2") != 0) {
      revoke("Expected initial UNO-ATM-V2 HELLO.");
      return;
    }
    strncpy(sessionId, incomingSession, sizeof(sessionId) - 1);
    sessionId[sizeof(sessionId) - 1] = '\0';
    sessionEstablished = true;
    lastUnoSequence = seq;
    lastValidUnoAt = millis();
    mode = GUARDIAN_OBSERVING;
    budgetWindowStartedAt = millis();
    pinFailureWindowStartedAt = millis();
    sendFrame("HELLO", "ESP32-SENTINEL-V2");
    sendFrame("ACK", "HELLO_ACCEPTED");
    Serial.print(F("[LINK] Session established: "));
    Serial.println(sessionId);
    return;
  }
  if (strcmp(incomingSession, sessionId) != 0) {
    revoke("Unexpected UNO session change; clean restart required.");
    return;
  }
  if (seq != lastUnoSequence + 1) {
    revoke("UNO frame sequence gap, duplicate or replay.");
    return;
  }
  lastUnoSequence = seq;
  lastValidUnoAt = millis();

  if (strcmp(type, "HELLO") == 0) {
    revoke("Unexpected repeated HELLO inside established session.");
  } else if (strcmp(type, "ACK") == 0) {
    // ACKs are observations only; they can never grant authority.
    Serial.println(F("[OBSERVE] UNO ACK received."));
  } else if (strcmp(type, "STATE") == 0) {
    handleState(payload);
  } else if (strcmp(type, "HEARTBEAT") == 0) {
    handleHeartbeat(payload);
    if (!revokeLatched && heartbeatSeen) mode = GUARDIAN_OBSERVING;
  } else if (strcmp(type, "REQUEST") == 0) {
    handleRequest(payload);
  } else if (strcmp(type, "EVENT") == 0) {
    handleEvent(payload);
  } else {
    revoke("Unknown UNO message type.");
  }
}

void pollUno() {
  while (Serial2.available()) {
    const char c = (char)Serial2.read();
    if (c == '\n') {
      if (!droppingLongFrame && rxLength > 0) {
        rxBuffer[rxLength] = '\0';
        handleUnoLine(rxBuffer);
      } else if (droppingLongFrame) {
        revoke("Overlong UNO frame discarded.");
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
  Serial.print(F("GUARDIAN_STATUS|mode="));
  Serial.print(modeName());
  Serial.print(F("|session="));
  Serial.print(sessionEstablished ? sessionId : "NONE");
  Serial.print(F("|atm="));
  Serial.print(lastAtmState);
  Serial.print(F("|heartbeat="));
  Serial.print(heartbeatSeen ? F("SEEN") : F("NONE"));
  Serial.print(F("|age_ms="));
  Serial.print(heartbeatSeen ? (uint32_t)(millis() - lastHeartbeatAt) : 0);
  Serial.print(F("|commits_observed="));
  Serial.print(committedTransactions);
  Serial.print(F("|denied="));
  Serial.println(deniedTransactions);
}

void handleUsbCommand(char *line) {
  char work[USB_LINE_MAX];
  strncpy(work, line, sizeof(work) - 1);
  work[sizeof(work) - 1] = '\0';
  for (size_t i = 0; work[i]; ++i) work[i] = (char)toupper((unsigned char)work[i]);
  char *argv[9] = {0};
  uint8_t argc = 0;
  char *save = NULL;
  char *part = strtok_r(work, " \t", &save);
  while (part && argc < 9) {
    argv[argc++] = part;
    part = strtok_r(NULL, " \t", &save);
  }
  if (part) {
    Serial.println(F("[COMMAND] Too many fields."));
  } else if (argc == 0) {
    // empty line
  } else if (strcmp(argv[0], "STATUS") == 0 && argc == 1) {
    printStatus();
  } else if ((strcmp(argv[0], "SET_LIMITS") == 0 && argc == 3 ||
              strcmp(argv[0], "SET_POLICY") == 0 && argc == 9) && !awaitingCommit) {
    uint32_t maxValue = 0, windowValue = 0;
    bool valid = parseUnsigned(argv[1], 1000000UL, maxValue) &&
                 parseUnsigned(argv[2], 1000000UL, windowValue) &&
                 maxValue > 0 && windowValue >= maxValue;
    uint32_t hbValue = heartbeatTimeoutMs, linkValue = linkTimeoutMs;
    uint32_t budgetValue = budgetWindowMs, pinFailValue = pinFailuresPerWindow;
    uint32_t pinWindowValue = pinFailureWindowMs, commitValue = commitTimeoutMs;
    if (valid && argc == 9) {
      valid = parseUnsigned(argv[3], 10000UL, hbValue) && hbValue >= 500UL &&
              parseUnsigned(argv[4], 30000UL, linkValue) && linkValue > hbValue &&
              parseUnsigned(argv[5], 86400000UL, budgetValue) && budgetValue >= 60000UL &&
              parseUnsigned(argv[6], 30UL, pinFailValue) && pinFailValue >= 3UL &&
              parseUnsigned(argv[7], 600000UL, pinWindowValue) && pinWindowValue >= 10000UL &&
              parseUnsigned(argv[8], 10000UL, commitValue) && commitValue >= 500UL;
    }
    if (valid) {
      maxTransaction = maxValue;
      windowLimit = windowValue;
      if (argc == 9) {
        heartbeatTimeoutMs = hbValue;
        linkTimeoutMs = linkValue;
        budgetWindowMs = budgetValue;
        pinFailuresPerWindow = (uint8_t)pinFailValue;
        pinFailureWindowMs = pinWindowValue;
        commitTimeoutMs = commitValue;
      }
      approvedWindowAmount = 0;
      budgetWindowStartedAt = millis();
      Serial.println(F("[CONFIG] Guardian policy updated in RAM."));
    } else {
      Serial.println(F("[CONFIG] Invalid limits; require WINDOW >= MAX, LINK > HEARTBEAT, and values in documented ranges."));
    }
  } else if (strcmp(argv[0], "FIXTURE_REVOKE") == 0 && argc == 1) {
    revoke("SIMULATED: operator-injected guardian revocation fixture.");
  } else if (strcmp(argv[0], "HELP") == 0 && argc == 1) {
    Serial.println(F("Commands: STATUS, SET_LIMITS <MAX_TXN> <WINDOW_LIMIT>, SET_POLICY <MAX_TXN> <WINDOW_LIMIT> <HEARTBEAT_MS> <LINK_TIMEOUT_MS> <WINDOW_MS> <PIN_FAILS> <PIN_WINDOW_MS> <COMMIT_MS>, FIXTURE_REVOKE, HELP"));
    Serial.println(F("Limits are RAM-only. Restart both boards to clear a latched revoke."));
  } else {
    Serial.println(F("[COMMAND] Invalid command or arguments."));
  }
  secureClear(work, sizeof(work));
}

void pollUsb() {
  while (Serial.available()) {
    const char c = (char)Serial.read();
    if (c == '\n') {
      if (!droppingUsbLine && usbLength > 0) {
        usbBuffer[usbLength] = '\0';
        handleUsbCommand(usbBuffer);
      } else if (droppingUsbLine) {
        Serial.println(F("[COMMAND] Overlong USB command discarded."));
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
  Serial2.begin(PEER_BAUD, SERIAL_8N1, PEER_RX_PIN, PEER_TX_PIN);
  mode = GUARDIAN_STARTING;
  budgetWindowStartedAt = millis();
  pinFailureWindowStartedAt = millis();
  Serial.println();
  Serial.println(F("SENTINEL ESP32 GUARDIAN V2 READY"));
  Serial.println(F("Claims: protocol/state policy observation only; no secure element or physical interlock."));
  Serial.println(F("UART2: RX GPIO16 / TX GPIO17 / 9600 8N1"));
  Serial.println(F("Type HELP for local RAM policy commands."));
}

void loop() {
  const uint32_t now = millis();
  pollUno();
  pollUsb();

  if (sessionEstablished && !revokeLatched && heartbeatSeen &&
      (uint32_t)(now - lastHeartbeatAt) > heartbeatTimeoutMs) {
    revoke("UNO heartbeat timeout.");
  }
  if (sessionEstablished && !revokeLatched &&
      (uint32_t)(now - lastValidUnoAt) > linkTimeoutMs) {
    revoke("UNO protocol traffic timeout.");
  }
  if (awaitingCommit && (uint32_t)(now - pendingPermitStartedAt) > commitTimeoutMs) {
    revoke("Controller did not report the matching transaction commit.");
  }
  if (sessionEstablished && !revokeLatched &&
      (uint32_t)(now - lastPeerStatusAt) >= PEER_STATUS_INTERVAL_MS) {
    sendFrame("STATUS", "HEALTHY");
    lastPeerStatusAt = now;
  }
  if ((uint32_t)(now - lastStatusAt) >= USB_STATUS_INTERVAL_MS) {
    if (!sessionEstablished) Serial.println(F("[WAIT] Waiting for UNO-ATM-V2 HELLO; no transaction permit."));
    else printStatus();
    lastStatusAt = now;
  }
}
