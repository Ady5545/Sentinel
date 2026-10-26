/*
 * SENTINEL ESP32 Independent Guardian Firmware v3.4
 * Target: ESP32 Dev Module
 * UART2: RX=GPIO16, TX=GPIO17, 4800 8N1
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
static const unsigned long PEER_BAUD = 4800;
static const unsigned long USB_BAUD = 115200;
static const unsigned long DEFAULT_HEARTBEAT_TIMEOUT_MS = 1800UL;
static const unsigned long DEFAULT_LINK_TIMEOUT_MS = 2600UL;
static const unsigned long HELLO_RETRY_MS = 800UL;
static const unsigned long HANDSHAKE_TIMEOUT_MS = 8000UL;
static const unsigned long USB_STATUS_INTERVAL_MS = 2000UL;
static const unsigned long DEFAULT_COMMIT_TIMEOUT_MS = 1800UL;
static const unsigned long DEFAULT_PIN_FAILURE_WINDOW_MS = 60000UL;
static const uint8_t DEFAULT_PIN_FAILURES_PER_WINDOW = 9;
static const uint32_t DEFAULT_MAX_TRANSACTION = 20000UL;
static const uint32_t DEFAULT_WINDOW_LIMIT = 40000UL;
static const unsigned long DEFAULT_BUDGET_WINDOW_MS = 86400000UL;
static const size_t FRAME_MAX = 120;
static const size_t USB_LINE_MAX = 96;

enum GuardianMode { GUARDIAN_STARTING, GUARDIAN_NEGOTIATING, GUARDIAN_OBSERVING, GUARDIAN_REVOKED };
GuardianMode mode = GUARDIAN_STARTING;
char sessionId[13] = {0};
char rxBuffer[FRAME_MAX];
size_t rxLength = 0;
bool droppingLongFrame = false;
uint32_t startupNoiseDrops = 0;
char usbBuffer[USB_LINE_MAX];
size_t usbLength = 0;
bool droppingUsbLine = false;
uint32_t txSequence = 0;
uint32_t lastUnoSequence = 0;
uint32_t initialUnoHelloSequence = 0;
uint32_t handshakeStartedAt = 0;
uint32_t lastHelloAt = 0;
uint32_t handshakeRetryCount = 0;
uint32_t duplicateUnoHelloCount = 0;
uint32_t lastValidUnoAt = 0;
uint32_t lastHeartbeatAt = 0;
uint32_t lastStatusAt = 0;
// Defer HEALTHY until the Uno's SoftwareSerial transmitter has fully returned to receive mode.
bool pendingHealthyStatus = false;
uint32_t healthyStatusDueAt = 0;
uint32_t healthyStatusSequence = 0;
uint32_t healthyStatusAckSequence = 0;
uint8_t healthyStatusAttempts = 0;
static const uint32_t HEALTHY_STATUS_TURNAROUND_MS = 100UL;
static const uint32_t HEALTHY_STATUS_RETRY_MS = 250UL;
static const uint8_t HEALTHY_STATUS_MAX_ATTEMPTS = 3;
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
bool handshakeConfirmed = false;
bool heartbeatSeen = false;
bool revokeLatched = false;
bool reportedAuthenticated = false;
bool awaitingCommit = false;
char lastAtmState[22] = "UNKNOWN";
char pendingPermitId[12] = {0};
uint32_t committedTransactions = 0;
uint32_t deniedTransactions = 0;
uint32_t lastCommittedEventSequence = 0;
uint32_t lastCommitAckSequence = 0;
uint32_t lastCommitAmount = 0;
char lastCommittedEventPayload[48] = {0};
char lastCommitAckPayload[48] = {0};

void secureClear(char *buffer, size_t length) {
  volatile char *p = buffer;
  while (length--) *p++ = '\0';
}

const char *modeName() {
  switch (mode) {
    case GUARDIAN_STARTING: return "STARTING";
    case GUARDIAN_NEGOTIATING: return "NEGOTIATING";
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

bool sendFrameAtSequence(const char *type, const char *payload, uint32_t seq) {
  // A newer outbound decision supersedes pending HEALTHY retries. Never emit
  // an older STATUS after a newer PERMIT, DENY, or REVOKE sequence.
  if (strcmp(type, "STATUS") != 0) pendingHealthyStatus = false;
  if (seq == 0) {
    Serial.println(F("[FAULT] Sequence zero is invalid; guardian revoked."));
    mode = GUARDIAN_REVOKED;
    revokeLatched = true;
    return false;
  }
  char prefix[FRAME_MAX];
  const int n = snprintf(prefix, sizeof(prefix), "S3|%s|%s|%lu|%s", type,
                         sessionId[0] ? sessionId : "ESP000001",
                         (unsigned long)seq, (payload && payload[0]) ? payload : "-");
  if (n <= 0 || (size_t)n >= sizeof(prefix)) {
    Serial.println(F("[FAULT] Outgoing frame overflow; guardian revoked."));
    mode = GUARDIAN_REVOKED;
    revokeLatched = true;
    return false;
  }
  if (seq > txSequence) txSequence = seq;
  const uint16_t crc = crc16CcittFalse((const uint8_t *)prefix, (size_t)n);
  Serial2.print(prefix);
  Serial2.print('|');
  char crcText[5];
  snprintf(crcText, sizeof(crcText), "%04X", crc);
  Serial2.print(crcText);
  Serial2.print('\n');
  // Local completion only: this does not prove the Uno accepted the frame.
  if (strcmp(type, "STATUS") == 0) {
    Serial2.flush();
    Serial.println(F("[STATUS_TX] UART flush completed; peer acceptance still unconfirmed."));
  }
  return true;
}

bool sendFrame(const char *type, const char *payload) {
  if (txSequence == 0xFFFFFFFFUL) {
    Serial.println(F("[FAULT] Outgoing sequence exhausted; guardian revoked."));
    mode = GUARDIAN_REVOKED;
    revokeLatched = true;
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
  if (strcmp(fields[0], "S3") != 0 || !validSession(fields[2])) return false;
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
  bool found = false;
  while (*cursor) {
    const char *end = strchr(cursor, ';');
    const size_t tokenLen = end ? (size_t)(end - cursor) : strlen(cursor);
    const char *equals = (const char *)memchr(cursor, '=', tokenLen);
    if (tokenLen == 0 || !equals || equals == cursor || equals >= cursor + tokenLen - 1 ||
        memchr(equals + 1, '=', (size_t)((cursor + tokenLen) - (equals + 1))) != NULL) return false;
    if ((size_t)(equals - cursor) == keyLen && strncmp(cursor, key, keyLen) == 0) {
      if (found) return false;
      const size_t valueLen = tokenLen - keyLen - 1;
      if (valueLen >= outSize) return false;
      memcpy(out, equals + 1, valueLen);
      out[valueLen] = '\0';
      found = true;
    }
    if (!end) break;
    cursor = end + 1;
    if (!*cursor) return false;
  }
  return found;
}

bool payloadHasExactKeys(const char *payload, const char *const *keys, uint8_t keyCount) {
  if (!payload || !payload[0] || !keys || keyCount == 0 || keyCount > 8) return false;
  uint16_t seen = 0;
  const char *cursor = payload;
  while (*cursor) {
    const char *end = strchr(cursor, ';');
    const size_t tokenLen = end ? (size_t)(end - cursor) : strlen(cursor);
    const char *equals = (const char *)memchr(cursor, '=', tokenLen);
    if (tokenLen == 0 || !equals || equals == cursor || equals >= cursor + tokenLen - 1 ||
        memchr(equals + 1, '=', (size_t)((cursor + tokenLen) - (equals + 1))) != NULL) return false;
    uint8_t match = keyCount;
    const size_t keyLen = (size_t)(equals - cursor);
    for (uint8_t i = 0; i < keyCount; ++i) {
      if (strlen(keys[i]) == keyLen && strncmp(cursor, keys[i], keyLen) == 0) {
        match = i;
        break;
      }
    }
    if (match == keyCount) return false;
    const uint16_t bit = (uint16_t)(1U << match);
    if (seen & bit) return false;
    seen |= bit;
    if (!end) break;
    cursor = end + 1;
    if (!*cursor) return false;
  }
  return seen == (uint16_t)((1U << keyCount) - 1U);
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
  // A peer that has not completed negotiation cannot safely correlate a REVOKE frame.
  if (heartbeatSeen) sendFrame("REVOKE", "POLICY_REVOKE");
}

void denyRequest(const char *id, uint32_t amount, const char *reason) {
  char payload[64];
  const int n = snprintf(payload, sizeof(payload), "id=%s;amount=%lu;reason=%s",
                         id, (unsigned long)amount, reason);
  if (n <= 0 || (size_t)n >= sizeof(payload) || deniedTransactions == 0xFFFFFFFFUL) {
    revoke("DENY payload/counter failure.");
    return;
  }
  ++deniedTransactions;
  if (!sendFrame("DENY", payload)) {
    revoke("Unable to transmit correlated DENY.");
    return;
  }
  Serial.print(F("[DENY] "));
  Serial.println(payload);
}

void handleState(const char *payload) {
  const char *const stateKeys[] = {"atm", "auth", "tx"};
  if (!payloadHasExactKeys(payload, stateKeys, 3)) {
    revoke("STATE payload contains missing, duplicate, or unknown fields.");
    return;
  }
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
  if (txCount != committedTransactions) {
    revoke("Controller-reported committed transaction count diverged from guardian observations.");
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

void handleHeartbeat(const char *payload, uint32_t heartbeatSequence) {
  const char *const heartbeatKeys[] = {"state", "up"};
  if (!payloadHasExactKeys(payload, heartbeatKeys, 2)) {
    revoke("HEARTBEAT payload contains missing, duplicate, or unknown fields.");
    return;
  }
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
  // Do not reply from inside the RX parser. Keep a bounded turnaround so the
  // Uno's AltSoftSerial peer link finishes its heartbeat receive turn first.
  // Schedule a short, non-blocking turnaround so the Uno is listening again.
  if (!revokeLatched) {
    pendingHealthyStatus = true;
    healthyStatusAckSequence = heartbeatSequence;
    healthyStatusSequence = (txSequence == 0xFFFFFFFFUL) ? 0 : txSequence + 1UL;
    healthyStatusAttempts = 0;
    healthyStatusDueAt = lastHeartbeatAt + HEALTHY_STATUS_TURNAROUND_MS;
    Serial.print(F("[STATUS_TX] HEALTHY scheduled; due_ms="));
    Serial.print(healthyStatusDueAt);
    Serial.print(F(" seq="));
    Serial.println(healthyStatusSequence);
  }
}

void handleEvent(const char *payload, uint32_t frameSequence) {
  char eventName[24];
  char source[24];
  char id[12];
  char amountText[12];
  char countText[8];
  if (!parsePayloadField(payload, "event", eventName, sizeof(eventName))) {
    revoke("EVENT payload has no unique typed event code.");
    return;
  }

  if (strcmp(eventName, "PROFILE_MISMATCH") == 0 ||
      strcmp(eventName, "PRIVILEGED_PATH") == 0 ||
      strcmp(eventName, "SEQUENCE_DIVERGENCE") == 0) {
    const char *const fixtureKeys[] = {"source", "event"};
    if (!payloadHasExactKeys(payload, fixtureKeys, 2) ||
        !parsePayloadField(payload, "source", source, sizeof(source)) ||
        strcmp(source, "SIMULATED") != 0) {
      revoke("Malformed or incorrectly labelled synthetic fixture event.");
      return;
    }
    revoke("Configured simulated integrity-violation fixture received.");
    return;
  }

  if (strcmp(eventName, "PIN_FAIL") == 0) {
    const char *const pinFailKeys[] = {"source", "event", "count"};
    uint32_t reportedCount = 0;
    if (!payloadHasExactKeys(payload, pinFailKeys, 3) ||
        !parsePayloadField(payload, "source", source, sizeof(source)) ||
        strcmp(source, "BOARD_REPORTED") != 0 ||
        !parsePayloadField(payload, "count", countText, sizeof(countText)) ||
        !parseUnsigned(countText, 255UL, reportedCount) || reportedCount == 0) {
      revoke("Malformed board-reported PIN_FAIL event.");
      return;
    }
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
    return;
  }

  if (strcmp(eventName, "TX_COMMITTED") == 0) {
    const char *const commitKeys[] = {"event", "id", "amount"};
    uint32_t amount = 0;
    if (!payloadHasExactKeys(payload, commitKeys, 3) ||
        !parsePayloadField(payload, "id", id, sizeof(id)) ||
        !parsePayloadField(payload, "amount", amountText, sizeof(amountText)) ||
        !parseUnsigned(amountText, 1000000UL, amount) ||
        !awaitingCommit || strcmp(id, pendingPermitId) != 0 ||
        amount != pendingPermitAmount) {
      revoke("TX_COMMITTED did not match the one-shot guardian permit.");
      return;
    }
    char canonicalCommit[48];
    const int commitLength = snprintf(canonicalCommit, sizeof(canonicalCommit),
        "event=TX_COMMITTED;id=%s;amount=%lu", id, (unsigned long)amount);
    if (commitLength <= 0 || (size_t)commitLength >= sizeof(canonicalCommit) ||
        strcmp(payload, canonicalCommit) != 0) {
      revoke("TX_COMMITTED payload is not in canonical field order.");
      return;
    }
    if (committedTransactions == 0xFFFFFFFFUL || txSequence == 0xFFFFFFFFUL) {
      revoke("Guardian commit/sequence counter exhausted; clean paired restart required.");
      return;
    }
    strncpy(lastCommittedEventPayload, canonicalCommit, sizeof(lastCommittedEventPayload) - 1);
    lastCommittedEventPayload[sizeof(lastCommittedEventPayload) - 1] = '\0';
    lastCommittedEventSequence = frameSequence;
    lastCommitAmount = amount;

    char ackPayload[48];
    const int ackLength = snprintf(ackPayload, sizeof(ackPayload),
        "ack_seq=%lu;id=%s;amount=%lu", (unsigned long)frameSequence,
        id, (unsigned long)amount);
    if (ackLength <= 0 || (size_t)ackLength >= sizeof(ackPayload)) {
      revoke("TX_COMMITTED acknowledgement payload overflow.");
      return;
    }
    lastCommitAckSequence = txSequence + 1UL;
    strncpy(lastCommitAckPayload, ackPayload, sizeof(lastCommitAckPayload) - 1);
    lastCommitAckPayload[sizeof(lastCommitAckPayload) - 1] = '\0';

    Serial.print(F("[RECONCILE] Matching controller-reported virtual commit id="));
    Serial.print(id);
    Serial.print(F(";amount="));
    Serial.println(amount);
    ++committedTransactions;
    awaitingCommit = false;
    pendingPermitId[0] = '\0';
    pendingPermitAmount = 0;

    if (!sendFrameAtSequence("ACK", lastCommitAckPayload, lastCommitAckSequence)) {
      revoke("Unable to transmit TX_COMMITTED acknowledgement.");
      return;
    }
    Serial.print(F("[COMMIT_ACK_TX] ACK sequence="));
    Serial.print(lastCommitAckSequence);
    Serial.print(F(" acknowledges UNO EVENT sequence="));
    Serial.println(lastCommittedEventSequence);
    return;
  }

  if (strcmp(eventName, "PIN_OK") == 0 || strcmp(eventName, "UNKNOWN_CARD") == 0 ||
      strcmp(eventName, "CARD_ACCEPTED") == 0 || strcmp(eventName, "PIN_CHANGED") == 0) {
    const char *const observeKeys[] = {"source", "event"};
    if (!payloadHasExactKeys(payload, observeKeys, 2) ||
        !parsePayloadField(payload, "source", source, sizeof(source)) ||
        strcmp(source, "BOARD_REPORTED") != 0) {
      revoke("Malformed board-reported observation event.");
      return;
    }
    if (strcmp(eventName, "PIN_OK") == 0) {
      Serial.println(F("[OBSERVE] UNO reports successful demo PIN verification."));
    } else if (strcmp(eventName, "UNKNOWN_CARD") == 0) {
      Serial.println(F("[OBSERVE] Unknown demo card was reported by UNO."));
    }
    return;
  }

  revoke("Unknown UNO EVENT code.");
}

void handleRequest(const char *payload) {
  const char *const requestKeys[] = {"id", "amount"};
  if (!payloadHasExactKeys(payload, requestKeys, 2)) {
    revoke("REQUEST payload contains missing, duplicate, or unknown fields.");
    return;
  }
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
  if (!handshakeConfirmed) {
    revoke("Transaction request before V3 handshake completion.");
    return;
  }
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
    denyRequest(id, amount, "TX_LIMIT");
    return;
  }
  if ((uint32_t)(millis() - budgetWindowStartedAt) >= budgetWindowMs) {
    budgetWindowStartedAt = millis();
    approvedWindowAmount = 0;
  }
  if (approvedWindowAmount > windowLimit || amount > windowLimit - approvedWindowAmount) {
    denyRequest(id, amount, "WINDOW_LIMIT");
    return;
  }

  if (approvedWindowAmount > windowLimit || amount > windowLimit - approvedWindowAmount) {
    revoke("Guardian budget accounting overflow or limit inconsistency.");
    return;
  }
  approvedWindowAmount += amount;
  strncpy(pendingPermitId, id, sizeof(pendingPermitId) - 1);
  pendingPermitId[sizeof(pendingPermitId) - 1] = '\0';
  pendingPermitAmount = amount;
  pendingPermitStartedAt = millis();
  awaitingCommit = true;
  char permitPayload[36];
  const int permitLength = snprintf(permitPayload, sizeof(permitPayload),
      "id=%s;amount=%lu", id, (unsigned long)amount);
  if (permitLength <= 0 || (size_t)permitLength >= sizeof(permitPayload)) {
    revoke("PERMIT payload overflow.");
    return;
  }
  if (!sendFrame("PERMIT", permitPayload)) {
    Serial.println(F("[FAULT] PERMIT transmission failed; no successful send is asserted."));
    return;
  }
  Serial.print(F("[PERMIT] One-shot observation issued for "));
  Serial.print(id);
  Serial.print(F("; amount="));
  Serial.println(amount);
}

void handleUnoLine(char *line) {
  // A latched revocation is terminal until both boards are reset. Never let a
  // later HELLO overwrite REVOKED with NEGOTIATING.
  if (revokeLatched) return;

  char fields[5][48] = {{0}};
  uint32_t seq = 0;
  if (!parseFrame(line, fields, seq)) {
    // UART startup can expose a partial/noisy line before the first valid
    // session. Drop that pre-session noise; after session establishment,
    // malformed frames remain fail-closed and latch revocation.
    if (!sessionEstablished) {
      ++startupNoiseDrops;
      if (startupNoiseDrops == 1 || startupNoiseDrops % 5UL == 0) {
        Serial.println(F("[LINK_DROP] Ignoring malformed pre-session UART noise; waiting for valid UNO HELLO."));
      }
      return;
    }
    revoke("Malformed frame, overlong input, CRC or protocol-version failure.");
    return;
  }
  const char *type = fields[1];
  const char *incomingSession = fields[2];
  const char *payload = fields[4];

  if (!sessionEstablished) {
    if (strcmp(type, "HELLO") != 0 || strcmp(payload, "UNO-ATM-V3") != 0 || seq != 1) {
      revoke("Expected initial S3 UNO-ATM-V3 HELLO with sequence 1.");
      return;
    }
    strncpy(sessionId, incomingSession, sizeof(sessionId) - 1);
    sessionId[sizeof(sessionId) - 1] = '\0';
    sessionEstablished = true;
    initialUnoHelloSequence = seq;
    lastUnoSequence = seq;
    lastValidUnoAt = millis();
    handshakeStartedAt = lastValidUnoAt;
    lastHelloAt = lastValidUnoAt;
    mode = GUARDIAN_NEGOTIATING;
    budgetWindowStartedAt = millis();
    pinFailureWindowStartedAt = millis();
    if (!sendFrameAtSequence("HELLO", "ESP32-SENTINEL-V3", 1)) {
      revoke("Unable to transmit V3 handshake HELLO.");
      return;
    }
    Serial.print(F("[LINK] V3 negotiation started for session: "));
    Serial.println(sessionId);
    return;
  }

  if (strcmp(incomingSession, sessionId) != 0) {
    revoke("Unexpected UNO session change; clean paired restart required.");
    return;
  }

  // A retry of the last committed event must be byte-identical and retain its
  // original sequence. Reuse the exact ACK identity without recounting it.
  if (strcmp(type, "EVENT") == 0 && lastCommittedEventSequence != 0 &&
      seq == lastCommittedEventSequence && strcmp(payload, lastCommittedEventPayload) == 0) {
    if (!lastCommitAckPayload[0] || lastCommitAckSequence == 0 ||
        !sendFrameAtSequence("ACK", lastCommitAckPayload, lastCommitAckSequence)) {
      revoke("Unable to replay the original TX_COMMITTED acknowledgement.");
      return;
    }
    Serial.println(F("[COMMIT_ACK_TX] Replayed identical acknowledgement for duplicate commit report."));
    return;
  }

  // An identical initial HELLO is an idempotent retry only before the first
  // valid heartbeat. It never advances the receive sequence or repeats effects.
  if (strcmp(type, "HELLO") == 0 && seq == initialUnoHelloSequence &&
      strcmp(payload, "UNO-ATM-V3") == 0 && !heartbeatSeen) {
    lastValidUnoAt = millis();
    if (revokeLatched) return;
    if (handshakeConfirmed) {
      sendFrameAtSequence("ACK", "HELLO_ACCEPTED", 2);
    } else {
      sendFrameAtSequence("HELLO", "ESP32-SENTINEL-V3", 1);
    }
    ++duplicateUnoHelloCount;
    if ((duplicateUnoHelloCount % 5UL) == 1UL) {
      Serial.print(F("[LINK_RETRY] Replayed fixed-sequence handshake response; duplicate HELLOs="));
      Serial.println(duplicateUnoHelloCount);
    }
    return;
  }

  // An exact duplicate of the non-authorizing controller handshake ACK is benign.
  if (strcmp(type, "ACK") == 0 && seq == 2 &&
      strcmp(payload, "HELLO_ACCEPTED") == 0 && handshakeConfirmed && !heartbeatSeen) {
    Serial.println(F("[LINK_RETRY] Duplicate controller handshake ACK ignored."));
    return;
  }

  if (seq != lastUnoSequence + 1UL) {
    revoke("UNO frame sequence gap, duplicate or replay.");
    return;
  }
  lastUnoSequence = seq;
  lastValidUnoAt = millis();

  if (strcmp(type, "HELLO") == 0) {
    revoke("Unexpected repeated HELLO outside the V3 startup retry window.");
  } else if (strcmp(type, "ACK") == 0) {
    if (handshakeConfirmed || strcmp(payload, "HELLO_ACCEPTED") != 0) {
      revoke("Unexpected or malformed UNO handshake ACK.");
      return;
    }
    if (!sendFrameAtSequence("ACK", "HELLO_ACCEPTED", 2)) {
      revoke("Unable to transmit final V3 handshake ACK.");
      return;
    }
    handshakeConfirmed = true;
    mode = GUARDIAN_NEGOTIATING;  // No observing/permit state before a valid heartbeat.
    Serial.println(F("[LINK] V3 handshake confirmed; waiting for first valid heartbeat."));
  } else if (!handshakeConfirmed) {
    // One-way demo fallback: accept only a typed EVENT before handshake, and
    // let handleEvent validate its exact schema and SIMULATED source. This
    // allows the controlled integrity fixture to be demonstrated when the
    // ESP32->UNO return wire is unavailable; it never grants ATM authority.
    if (strcmp(type, "EVENT") == 0) {
      Serial.println(F("[TEST] Pre-handshake EVENT received; validating controlled fixture only."));
      handleEvent(payload, seq);
    } else {
      revoke("UNO sent non-fixture traffic before V3 handshake completion.");
    }
  } else if (strcmp(type, "STATE") == 0) {
    handleState(payload);
  } else if (strcmp(type, "HEARTBEAT") == 0) {
    handleHeartbeat(payload, seq);
    if (!revokeLatched && heartbeatSeen) mode = GUARDIAN_OBSERVING;
  } else if (strcmp(type, "REQUEST") == 0) {
    handleRequest(payload);
  } else if (strcmp(type, "EVENT") == 0) {
    handleEvent(payload, seq);
  } else {
    revoke("Unknown UNO message type.");
  }
}

void pollUno() {
  uint8_t bytesProcessed = 0;
  static const uint8_t MAX_PEER_RX_BYTES_PER_LOOP = 64;
  while (Serial2.available() && bytesProcessed < MAX_PEER_RX_BYTES_PER_LOOP) {
    const char c = (char)Serial2.read();
    ++bytesProcessed;
    if (c == '\n') {
      if (!droppingLongFrame && rxLength > 0) {
        rxBuffer[rxLength] = '\0';
        handleUnoLine(rxBuffer);
      } else if (droppingLongFrame) {
        if (sessionEstablished) {
          revoke("Overlong UNO frame discarded.");
        } else {
          ++startupNoiseDrops;
          if (startupNoiseDrops == 1 || startupNoiseDrops % 5UL == 0) {
            Serial.println(F("[LINK_DROP] Ignoring overlong pre-session UART noise; waiting for valid UNO HELLO."));
          }
        }
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
  } else if (((strcmp(argv[0], "SET_LIMITS") == 0 && argc == 3) ||
              (strcmp(argv[0], "SET_POLICY") == 0 && argc == 9)) && !awaitingCommit) {
    uint32_t maxValue = 0, windowValue = 0;
    bool valid = parseUnsigned(argv[1], 1000000UL, maxValue) &&
                 parseUnsigned(argv[2], 1000000UL, windowValue) &&
                 maxValue > 0 && windowValue >= maxValue;
    uint32_t hbValue = heartbeatTimeoutMs, linkValue = linkTimeoutMs;
    uint32_t budgetValue = budgetWindowMs, pinFailValue = pinFailuresPerWindow;
    uint32_t pinWindowValue = pinFailureWindowMs, commitValue = commitTimeoutMs;
    if (valid && argc == 9) {
      valid = parseUnsigned(argv[3], 10000UL, hbValue) && hbValue >= 700UL &&
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
  Serial.println(F("SENTINEL ESP32 GUARDIAN V3.4 READY"));
  Serial.println(F("Claims: protocol/state policy observation only; no secure element or physical interlock."));
  Serial.println(F("UART2: RX GPIO16 / TX GPIO17 / 4800 8N1"));
  Serial.println(F("Type HELP for local RAM policy commands."));
}

void loop() {
  pollUno();
  pollUsb();
  const uint32_t now = millis();

  // Defer STATUS until the Uno has finished the heartbeat send/receive turn.
  // If a frame is corrupted/lost, retry the identical sequence. The Uno ignores
  // only exact, recent duplicates.
  if (pendingHealthyStatus &&
      (int32_t)(now - healthyStatusDueAt) >= 0) {
    if (!revokeLatched && handshakeConfirmed && healthyStatusSequence != 0) {
      char statusPayload[40];
      const int statusPayloadLength = snprintf(statusPayload, sizeof(statusPayload),
          "HEALTHY;ack_seq=%lu", (unsigned long)healthyStatusAckSequence);
      if (statusPayloadLength <= 0 || (size_t)statusPayloadLength >= sizeof(statusPayload)) {
        pendingHealthyStatus = false;
        revoke("STATUS acknowledgement payload overflow.");
        return;
      }
      Serial.print(F("[STATUS_TX] Attempt "));
      Serial.print((uint8_t)(healthyStatusAttempts + 1));
      Serial.print('/');
      Serial.print(HEALTHY_STATUS_MAX_ATTEMPTS);
      Serial.print(F(" STATUS ack_seq="));
      Serial.print(healthyStatusAckSequence);
      Serial.print(F(" seq="));
      Serial.println(healthyStatusSequence);
      const bool sent = sendFrameAtSequence("STATUS", statusPayload, healthyStatusSequence);
      Serial.print(F("[STATUS_TX] sendFrame_return="));
      Serial.println(sent ? F("true") : F("false"));
      if (!sent) {
        pendingHealthyStatus = false;
        revoke("Unable to transmit healthy guardian status.");
      } else {
        ++healthyStatusAttempts;
        if (healthyStatusAttempts >= HEALTHY_STATUS_MAX_ATTEMPTS) {
          pendingHealthyStatus = false;
        } else {
          healthyStatusDueAt = now + HEALTHY_STATUS_RETRY_MS;
        }
      }
    } else {
      pendingHealthyStatus = false;
      Serial.print(F("[STATUS_TX] Skipped; revoked="));
      Serial.print(revokeLatched ? F("yes") : F("no"));
      Serial.print(F(" handshake="));
      Serial.println(handshakeConfirmed ? F("yes") : F("no"));
      if (!revokeLatched && handshakeConfirmed && healthyStatusSequence == 0) {
        revoke("Unable to allocate healthy status sequence.");
      }
    }
  }

  if (sessionEstablished && !heartbeatSeen && !revokeLatched) {
    // Keep the absolute deadline active until the first valid heartbeat proves
    // the final ACK reached the Uno and it resumed the normal protocol stream.
    if ((uint32_t)(now - handshakeStartedAt) >= HANDSHAKE_TIMEOUT_MS) {
      revoke("V3 handshake confirmation timeout; clean paired restart required.");
    } else if (!handshakeConfirmed &&
               (uint32_t)(now - lastHelloAt) >= HELLO_RETRY_MS) {
      ++handshakeRetryCount;
      if ((handshakeRetryCount % 5UL) == 1UL) {
        Serial.print(F("[LINK_RETRY] Re-sending identical ESP32 HELLO seq=1; retries="));
        Serial.println(handshakeRetryCount);
      }
      if (!sendFrameAtSequence("HELLO", "ESP32-SENTINEL-V3", 1)) {
        revoke("Unable to retransmit V3 handshake HELLO.");
      }
      lastHelloAt = now;
    }
  }

  if (sessionEstablished && !revokeLatched && handshakeConfirmed && heartbeatSeen &&
      (uint32_t)(now - lastHeartbeatAt) > heartbeatTimeoutMs) {
    revoke("UNO heartbeat timeout.");
  }
  if (sessionEstablished && !revokeLatched && handshakeConfirmed &&
      (uint32_t)(now - lastValidUnoAt) > linkTimeoutMs) {
    revoke("UNO protocol traffic timeout.");
  }
  if (awaitingCommit && (uint32_t)(now - pendingPermitStartedAt) > commitTimeoutMs) {
    revoke("Controller did not report the matching transaction commit.");
  }
  if ((uint32_t)(now - lastStatusAt) >= USB_STATUS_INTERVAL_MS) {
    if (!sessionEstablished && !revokeLatched) {
      Serial.println(F("[WAIT] Waiting for UNO-ATM-V3 HELLO; no transaction permit."));
    } else {
      printStatus();
    }
    lastStatusAt = now;
  }
}
