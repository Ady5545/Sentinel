/*
 * SENTINEL ESP32 Independent Guardian Firmware v1
 * Target: ESP32 Dev Module
 * UART2: RX=GPIO16, TX=GPIO17, 9600 8N1
 * USB diagnostics: Serial at 115200
 *
 * Research prototype only. Not a physical dispenser interlock.
 */
#include <Arduino.h>
#include <string.h>
#include <stdlib.h>

static const int PEER_RX_PIN = 16;
static const int PEER_TX_PIN = 17;
static const unsigned long PEER_BAUD = 9600;
static const unsigned long USB_BAUD = 115200;
static const unsigned long HEARTBEAT_TIMEOUT_MS = 1800;
static const unsigned long STATUS_INTERVAL_MS = 2000;
static const size_t FRAME_MAX = 120;

enum GuardianMode { STARTING, OBSERVING, PERMITTED, REVOKED };
GuardianMode mode = STARTING;
char sessionId[13] = {0};
char rxBuffer[FRAME_MAX + 1];
size_t rxLength = 0;
bool droppingLongFrame = false;
uint32_t txSequence = 0;
uint32_t lastUnoSequence = 0;
uint32_t lastValidUnoAt = 0;
uint32_t lastHeartbeatAt = 0;
uint32_t lastStatusAt = 0;
bool sessionEstablished = false;
bool heartbeatSeen = false;
bool revokeLatched = false;
char lastControllerState[24] = "UNKNOWN";

const char *modeName() {
  switch (mode) {
    case STARTING: return "STARTING";
    case OBSERVING: return "OBSERVING";
    case PERMITTED: return "PERMITTED";
    case REVOKED: return "REVOKED";
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
  size_t n = strlen(s);
  if (n < 8 || n > 12) return false;
  for (size_t i = 0; i < n; ++i)
    if (!((s[i] >= 'A' && s[i] <= 'Z') || (s[i] >= '0' && s[i] <= '9'))) return false;
  return true;
}

void sendFrame(const char *type, const char *payload) {
  char prefix[FRAME_MAX];
  uint32_t seq = ++txSequence;
  int n = snprintf(prefix, sizeof(prefix), "S1|%s|%s|%lu|%s", type,
                   sessionId[0] ? sessionId : "ESP000001", (unsigned long)seq,
                   (payload && payload[0]) ? payload : "-");
  if (n <= 0 || (size_t)n >= sizeof(prefix)) {
    Serial.println(F("[FAULT] Outgoing frame too long; fail closed."));
    mode = REVOKED;
    revokeLatched = true;
    return;
  }
  uint16_t crc = crc16CcittFalse((const uint8_t *)prefix, (size_t)n);
  Serial2.print(prefix);
  Serial2.print('|');
  char crcText[5];
  snprintf(crcText, sizeof(crcText), "%04X", crc);
  Serial2.print(crcText);
  Serial2.print('\n');
}

bool parseFrame(char *line, char fields[5][48], uint32_t &seqOut) {
  size_t len = strlen(line);
  if (len < 12 || len > FRAME_MAX - 1) return false;
  char *lastSep = strrchr(line, '|');
  if (!lastSep || strlen(lastSep + 1) != 4) return false;
  char *end = NULL;
  unsigned long receivedCrc = strtoul(lastSep + 1, &end, 16);
  if (!end || *end != '\0' || receivedCrc > 0xFFFF) return false;
  uint16_t expected = crc16CcittFalse((const uint8_t *)line, (size_t)(lastSep - line));
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
  if (part || count != 5 || strcmp(fields[0], "S1") != 0 || !validSession(fields[2])) return false;
  if (!fields[3][0]) return false;
  for (size_t i = 0; fields[3][i]; ++i) if (fields[3][i] < '0' || fields[3][i] > '9') return false;
  seqOut = strtoul(fields[3], &end, 10);
  if (!end || *end != '\0' || seqOut == 0) return false;
  return true;
}

void revoke(const char *reason) {
  bool wasLatched = revokeLatched;
  mode = REVOKED;
  revokeLatched = true;
  if (!wasLatched) {
    Serial.print(F("[REVOKE] "));
    Serial.println(reason);
    sendFrame("REVOKE", reason);
  }
}

bool payloadHas(const char *payload, const char *needle) {
  return strstr(payload, needle) != NULL;
}

bool allowedState(const char *payload) {
  return payloadHas(payload, "state=BOOT_SAFE") ||
         payloadHas(payload, "state=IDLE") ||
         payloadHas(payload, "state=SESSION_ACTIVE") ||
         payloadHas(payload, "state=REQUEST_PENDING");
}

void handleUnoLine(char *line) {
  char fields[5][48] = {{0}};
  uint32_t seq = 0;
  if (!parseFrame(line, fields, seq)) {
    revoke("Malformed frame, overlong input, or CRC/session validation failure.");
    return;
  }

  const char *type = fields[1];
  const char *incomingSession = fields[2];
  const char *payload = fields[4];

  if (!sessionEstablished) {
    if (strcmp(type, "HELLO") != 0 || !payloadHas(payload, "UNO-SENTINEL-V1")) {
      revoke("Expected UNO HELLO handshake; received unexpected first frame.");
      return;
    }
    strncpy(sessionId, incomingSession, sizeof(sessionId) - 1);
    sessionEstablished = true;
    lastUnoSequence = seq;
    lastValidUnoAt = millis();
    mode = OBSERVING;
    sendFrame("HELLO", "ESP32-SENTINEL-V1;source=PROTOCOL_VALIDATED");
    sendFrame("ACK", "HELLO_ACCEPTED");
    Serial.print(F("[LINK] Session established: "));
    Serial.println(sessionId);
    return;
  }

  if (strcmp(incomingSession, sessionId) != 0) {
    revoke("Unexpected session change; explicit restart required.");
    return;
  }
  if (seq != lastUnoSequence + 1) {
    revoke("UNO sequence duplicate, gap, or stale frame.");
    return;
  }
  lastUnoSequence = seq;
  lastValidUnoAt = millis();

  if (strcmp(type, "HELLO") == 0) {
    if (!payloadHas(payload, "UNO-SENTINEL-V1")) { revoke("Unexpected repeated HELLO payload."); return; }
    sendFrame("ACK", "HELLO_ALREADY_ACCEPTED");
  } else if (strcmp(type, "HEARTBEAT") == 0) {
    if (!allowedState(payload)) {
      revoke("Illegal controller state in heartbeat.");
      return;
    }
    if (payloadHas(payload, "state=GUARDIAN_LOCKED")) {
      revoke("UNO reports locked state.");
      return;
    }
    heartbeatSeen = true;
    lastHeartbeatAt = millis();
    mode = revokeLatched ? REVOKED : OBSERVING;
    if (!revokeLatched) {
      mode = PERMITTED;
      sendFrame("PERMIT", "FRESH");
    }
  } else if (strcmp(type, "STATE") == 0) {
    if (!allowedState(payload)) {
      revoke("Illegal controller state transition or unknown state.");
      return;
    }
    if (payloadHas(payload, "state=GUARDIAN_LOCKED")) {
      revoke("UNO reports guardian lock.");
      return;
    }
    strncpy(lastControllerState, payload, sizeof(lastControllerState) - 1);
    lastControllerState[sizeof(lastControllerState) - 1] = '\0';
  } else if (strcmp(type, "EVENT") == 0) {
    if (payloadHas(payload, "PROFILE_MISMATCH") || payloadHas(payload, "PRIVILEGED_PATH") ||
        payloadHas(payload, "SEQUENCE_DIVERGENCE") || payloadHas(payload, "SIMULATED")) {
      revoke("Defined integrity-violation test evidence observed.");
    } else {
      Serial.print(F("[EVENT] BOARD_REPORTED: "));
      Serial.println(payload);
    }
  } else if (strcmp(type, "REQUEST") == 0) {
    if (mode != PERMITTED || revokeLatched || !heartbeatSeen ||
        millis() - lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) {
      revoke("Request observed without fresh guardian policy state.");
    } else {
      sendFrame("ACK", "REQUEST_OBSERVED_NO_PHYSICAL_DISPENSE");
      Serial.println(F("[REQUEST] Observed; virtual desktop gate must independently decide."));
    }
  } else {
    revoke("Unknown UNO message type.");
  }
}

void pollUno() {
  while (Serial2.available()) {
    char c = (char)Serial2.read();
    if (c == '\n') {
      if (!droppingLongFrame && rxLength > 0) {
        rxBuffer[rxLength] = '\0';
        handleUnoLine(rxBuffer);
      } else if (droppingLongFrame) {
        revoke("Overlong frame discarded.");
      }
      rxLength = 0;
      droppingLongFrame = false;
    } else if (c != '\r') {
      if (rxLength >= FRAME_MAX - 1) droppingLongFrame = true;
      else if (!droppingLongFrame) rxBuffer[rxLength++] = c;
    }
  }
}

void setup() {
  Serial.begin(USB_BAUD);
  Serial2.begin(PEER_BAUD, SERIAL_8N1, PEER_RX_PIN, PEER_TX_PIN);
  mode = STARTING;
  Serial.println();
  Serial.println(F("SENTINEL ESP32 GUARDIAN READY"));
  Serial.println(F("PROVENANCE: serial reports are not cryptographic attestation"));
  Serial.println(F("UART2: RX GPIO16 / TX GPIO17 / 9600 8N1"));
}

void loop() {
  const uint32_t now = millis();
  pollUno();

  if (sessionEstablished && heartbeatSeen && !revokeLatched &&
      now - lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) {
    revoke("UNO heartbeat timeout.");
  }
  if (!sessionEstablished && now - lastStatusAt >= 3000) {
    Serial.println(F("[WAIT] Waiting for UNO HELLO; no permit."));
    lastStatusAt = now;
  }
  if (now - lastStatusAt >= STATUS_INTERVAL_MS && sessionEstablished) {
    Serial.print(F("[STATUS] mode="));
    Serial.print(modeName());
    Serial.print(F(" last="));
    Serial.print(lastControllerState);
    Serial.print(F(" seq="));
    Serial.println(lastUnoSequence);
    lastStatusAt = now;
  }

  if (Serial.available()) {
    String command = Serial.readStringUntil('\n');
    command.trim();
    if (command == "status") {
      Serial.print(F("mode=")); Serial.print(modeName());
      Serial.print(F(" session=")); Serial.print(sessionEstablished ? sessionId : "NONE");
      Serial.print(F(" heartbeat=")); Serial.println(heartbeatSeen ? F("seen") : F("none"));
    } else if (command == "fixture_revoke") {
      revoke("SIMULATED: operator-injected guardian test fixture.");
    } else if (command == "recover") {
      Serial.println(F("[RECOVERY] Latched revocation cannot be cleared in-session. Reset/reflash both boards for a fresh session."));
    } else if (command.length() > 0) {
      Serial.println(F("Commands: status, fixture_revoke, recover"));
    }
  }
}
