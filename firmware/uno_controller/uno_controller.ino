/*
 * SENTINEL UNO Controller Firmware v1
 * Target: Arduino Uno / ATmega328P
 * UART to ESP32: SoftwareSerial RX=D2, TX=D3, 9600 8N1
 * USB diagnostics: Serial at 115200
 *
 * Research simulator only. No physical dispenser output is implemented.
 */
#include <Arduino.h>
#include <SoftwareSerial.h>
#include <string.h>
#include <stdlib.h>

static const uint8_t PEER_RX_PIN = 2;
static const uint8_t PEER_TX_PIN = 3;
static const unsigned long PEER_BAUD = 9600;
static const unsigned long USB_BAUD = 115200;
static const unsigned long HEARTBEAT_MS = 500;
static const unsigned long HELLO_RETRY_MS = 1000;
static const unsigned long GUARDIAN_TIMEOUT_MS = 2500;
static const size_t FRAME_MAX = 120;
static const char *CONTROLLER_BUILD = "UNO-SENTINEL-V1";

SoftwareSerial GuardianSerial(PEER_RX_PIN, PEER_TX_PIN);

enum ControllerState { BOOT_SAFE, IDLE, SESSION_ACTIVE, REQUEST_PENDING, GUARDIAN_LOCKED };
enum GuardianState { GUARDIAN_UNKNOWN, GUARDIAN_OBSERVING, GUARDIAN_PERMITTED, GUARDIAN_REVOKED };
ControllerState controllerState = BOOT_SAFE;
GuardianState guardianState = GUARDIAN_UNKNOWN;

char sessionId[13] = {0};
char rxBuffer[FRAME_MAX + 1];
size_t rxLength = 0;
bool droppingLongFrame = false;
uint32_t txSequence = 0;
uint32_t lastGuardianSequence = 0;
uint32_t lastGuardianFrameAt = 0;
uint32_t lastHeartbeatAt = 0;
uint32_t lastHelloAt = 0;
uint32_t lastStatusAt = 0;
bool handshakeComplete = false;
bool permitFresh = false;
bool revokeLatched = false;

const char *stateName(ControllerState s) {
  switch (s) {
    case BOOT_SAFE: return "BOOT_SAFE";
    case IDLE: return "IDLE";
    case SESSION_ACTIVE: return "SESSION_ACTIVE";
    case REQUEST_PENDING: return "REQUEST_PENDING";
    case GUARDIAN_LOCKED: return "GUARDIAN_LOCKED";
  }
  return "UNKNOWN";
}

void makeSession() {
  // Uniqueness aid for a bench demo only; not a cryptographic nonce.
  snprintf(sessionId, sizeof(sessionId), "U%08lX", (unsigned long)micros());
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
  const uint32_t seq = ++txSequence;
  int n = snprintf(prefix, sizeof(prefix), "S1|%s|%s|%lu|%s", type, sessionId,
                   (unsigned long)seq, (payload && payload[0]) ? payload : "-");
  if (n <= 0 || (size_t)n >= sizeof(prefix)) {
    Serial.println(F("[FAULT] Outgoing frame too long; fail closed."));
    guardianState = GUARDIAN_REVOKED;
    permitFresh = false;
    return;
  }
  uint16_t crc = crc16CcittFalse((const uint8_t *)prefix, (size_t)n);
  GuardianSerial.print(prefix);
  GuardianSerial.print('|');
  if (crc < 0x1000) GuardianSerial.print('0');
  if (crc < 0x0100) GuardianSerial.print('0');
  if (crc < 0x0010) GuardianSerial.print('0');
  GuardianSerial.print(crc, HEX);
  GuardianSerial.print('\n');
}

bool parseFrame(char *line, char fields[6][48], uint32_t &seqOut) {
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
  while (part && count < 6) {
    if (strlen(part) >= sizeof(fields[count])) return false;
    strcpy(fields[count++], part);
    part = strtok_r(NULL, "|", &save);
  }
  if (part || count != 5) return false;
  // Fields 0..4: version, type, session, sequence, payload.
  strcpy(fields[5], "");
  if (strcmp(fields[0], "S1") != 0 || !validSession(fields[2])) return false;
  if (!fields[3][0]) return false;
  for (size_t i = 0; fields[3][i]; ++i) if (fields[3][i] < '0' || fields[3][i] > '9') return false;
  seqOut = strtoul(fields[3], &end, 10);
  if (!end || *end != '\0' || seqOut == 0) return false;
  return true;
}

void enterLock(const char *reason) {
  if (controllerState != GUARDIAN_LOCKED || !revokeLatched) {
    Serial.print(F("[LOCKED] "));
    Serial.println(reason);
  }
  controllerState = GUARDIAN_LOCKED;
  guardianState = GUARDIAN_REVOKED;
  permitFresh = false;
  revokeLatched = true;
}

void handleGuardianLine(char *line) {
  char fields[6][48] = {{0}};
  uint32_t seq = 0;
  if (!parseFrame(line, fields, seq)) {
    enterLock("Malformed frame or CRC/session validation failure.");
    return;
  }
  if (strcmp(fields[2], sessionId) != 0) {
    enterLock("Guardian frame belongs to another session.");
    return;
  }
  if (seq != lastGuardianSequence + 1) {
    enterLock("Guardian sequence duplicate, gap, or stale frame.");
    return;
  }
  lastGuardianSequence = seq;
  lastGuardianFrameAt = millis();

  const char *type = fields[1];
  const char *payload = fields[4];
  if (strcmp(type, "HELLO") == 0 || strcmp(type, "ACK") == 0) {
    if (strcmp(type, "HELLO") == 0 && strncmp(payload, "ESP32-SENTINEL-V1", 17) != 0) {
      enterLock("Unexpected guardian identity payload.");
      return;
    }
    handshakeComplete = true;
    if (controllerState == BOOT_SAFE) controllerState = IDLE;
    if (!revokeLatched) guardianState = GUARDIAN_OBSERVING;
    Serial.println(F("[LINK] Guardian handshake observed; identity is self-reported."));
  } else if (strcmp(type, "PERMIT") == 0) {
    if (!handshakeComplete || revokeLatched || strcmp(payload, "FRESH") != 0) {
      enterLock("Invalid or unexpected permit.");
      return;
    }
    permitFresh = true;
    guardianState = GUARDIAN_PERMITTED;
  } else if (strcmp(type, "REVOKE") == 0) {
    enterLock(payload);
  } else if (strcmp(type, "STATUS") == 0) {
    Serial.print(F("[GUARDIAN] "));
    Serial.println(payload);
  } else {
    enterLock("Unknown guardian message type.");
  }
}

void pollGuardian() {
  while (GuardianSerial.available()) {
    char c = (char)GuardianSerial.read();
    if (c == '\n') {
      if (!droppingLongFrame && rxLength > 0) {
        rxBuffer[rxLength] = '\0';
        handleGuardianLine(rxBuffer);
      } else if (droppingLongFrame) {
        enterLock("Overlong guardian frame discarded.");
      }
      rxLength = 0;
      droppingLongFrame = false;
    } else if (c != '\r') {
      if (rxLength >= FRAME_MAX - 1) {
        droppingLongFrame = true;
      } else if (!droppingLongFrame) {
        rxBuffer[rxLength++] = c;
      }
    }
  }
}

void setup() {
  Serial.begin(USB_BAUD);
  GuardianSerial.begin(PEER_BAUD);
  makeSession();
  controllerState = BOOT_SAFE;
  Serial.println();
  Serial.println(F("SENTINEL UNO CONTROLLER READY"));
  Serial.println(F("MODE: research prototype; virtual dispenser only"));
  Serial.print(F("BUILD (self-reported): "));
  Serial.println(CONTROLLER_BUILD);
  Serial.print(F("SESSION: "));
  Serial.println(sessionId);
  sendFrame("HELLO", CONTROLLER_BUILD);
  lastHelloAt = millis();
}

void loop() {
  const uint32_t now = millis();
  pollGuardian();

  if (!handshakeComplete && now - lastHelloAt >= HELLO_RETRY_MS) {
    sendFrame("HELLO", CONTROLLER_BUILD);
    lastHelloAt = now;
  }

  if (handshakeComplete && now - lastHeartbeatAt >= HEARTBEAT_MS) {
    char payload[32];
    snprintf(payload, sizeof(payload), "state=%s;up=%lu", stateName(controllerState), (unsigned long)now);
    sendFrame("HEARTBEAT", payload);
    lastHeartbeatAt = now;
  }

  if (handshakeComplete && now - lastStatusAt >= 2000) {
    char payload[32];
    snprintf(payload, sizeof(payload), "state=%s;permit=%s", stateName(controllerState), permitFresh ? "yes" : "no");
    sendFrame("STATE", payload);
    lastStatusAt = now;
  }

  if (handshakeComplete && lastGuardianFrameAt != 0 && now - lastGuardianFrameAt > GUARDIAN_TIMEOUT_MS) {
    enterLock("Guardian response timeout.");
  }

  // Serial console commands are demonstration controls, never physical outputs.
  if (Serial.available()) {
    String command = Serial.readStringUntil('\n');
    command.trim();
    if (command == "status") {
      Serial.print(F("state=")); Serial.print(stateName(controllerState));
      Serial.print(F(" guardian=")); Serial.print(guardianState == GUARDIAN_PERMITTED ? F("PERMITTED") : F("NOT_PERMITTED"));
      Serial.print(F(" session=")); Serial.println(sessionId);
    } else if (command == "demo_request") {
      if (controllerState == GUARDIAN_LOCKED || !handshakeComplete || !permitFresh || revokeLatched) {
        Serial.println(F("[DENIED] No fresh guardian permission; no request emitted."));
      } else {
        sendFrame("REQUEST", "id=DEMO-001;amount=100");
        controllerState = REQUEST_PENDING;
        Serial.println(F("[DEMO] Request sent; no money or hardware is actuated."));
      }
    } else if (command == "fixture_mismatch") {
      // Deliberately untrusted test evidence, clearly labelled as a fixture.
      sendFrame("EVENT", "source=SIMULATED;event=PROFILE_MISMATCH");
      Serial.println(F("[FIXTURE] Simulated mismatch event sent."));
    } else if (command == "recover") {
      Serial.println(F("[RECOVERY] Explicit reset requested; reboot both boards for a clean session."));
    } else if (command.length() > 0) {
      Serial.println(F("Commands: status, demo_request, fixture_mismatch, recover"));
    }
  }
}
