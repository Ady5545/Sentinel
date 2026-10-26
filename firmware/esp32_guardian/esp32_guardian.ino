/*
 * SENTINEL EASY DEMO — ESP32 Independent Guardian
 * UART2: RX GPIO16, TX GPIO17, 4800 baud
 * USB Serial Monitor: 115200 baud, line ending = Newline
 *
 * Educational demo protocol only; not production authentication or a physical
 * dispenser interlock. A SIMULATED event is a software fixture, not proof of
 * real-world hardware compromise.
 */
#include <Arduino.h>
#include <string.h>

static const int GUARDIAN_RX = 16;
static const int GUARDIAN_TX = 17;
static const unsigned long LINK_BAUD = 4800;
static const unsigned long USB_BAUD = 115200;
static const unsigned long ANNOUNCE_MS = 500;

char peerLine[96];
size_t peerLength = 0;
unsigned long lastAnnounceAt = 0;
bool unoSeen = false;
bool revoked = false;
char revokeReason[32] = "NONE";

void sendGuardianOnline() {
  Serial2.println(F("GUARDIAN|ONLINE"));
}

void revokeGuardian(const char *reason) {
  if (revoked) return;
  revoked = true;
  strncpy(revokeReason, reason, sizeof(revokeReason) - 1);
  revokeReason[sizeof(revokeReason) - 1] = '\0';

  Serial.println();
  Serial.print(F("[SENTINEL] SIMULATED integrity event received: "));
  Serial.println(reason);
  Serial.println(F("[REVOKE] Guardian latched REVOKED."));
  Serial.println(F("[REVOKE] Sending denial to UNO; no permit will be issued."));
  Serial2.print(F("GUARDIAN|REVOKED|"));
  Serial2.println(reason);
  Serial.println(F("[NOTE] This is a software-generated demo event, not proof of real hardware compromise."));
}

void handlePeerLine(char *line) {
  if (strcmp(line, "UNO|ONLINE") == 0) {
    if (!unoSeen) Serial.println(F("[LINK] UNO heartbeat received."));
    unoSeen = true;
    return;
  }

  if (strcmp(line, "EVENT|SIMULATED|PROFILE_MISMATCH") == 0) {
    revokeGuardian("PROFILE_MISMATCH");
  } else if (strcmp(line, "EVENT|SIMULATED|PRIVILEGED_PATH") == 0) {
    revokeGuardian("PRIVILEGED_PATH");
  } else if (strcmp(line, "EVENT|SIMULATED|SEQUENCE_DIVERGENCE") == 0) {
    revokeGuardian("SEQUENCE_DIVERGENCE");
  } else if (strncmp(line, "EVENT|", 6) == 0) {
    Serial.print(F("[DROP] Unsupported or non-simulated event: "));
    Serial.println(line);
  }
}

void pollPeer() {
  while (Serial2.available()) {
    char c = (char)Serial2.read();
    if (c == '\r') continue;
    if (c == '\n') {
      peerLine[peerLength] = '\0';
      if (peerLength) handlePeerLine(peerLine);
      peerLength = 0;
    } else if (peerLength < sizeof(peerLine) - 1) {
      peerLine[peerLength++] = c;
    } else {
      peerLength = 0;
      Serial.println(F("[DROP] Overlong UART line discarded."));
    }
  }
}

void handleUsbCommand(char *line) {
  if (strcmp(line, "HELP") == 0) {
    Serial.println(F("Commands: HELP, STATUS"));
    Serial.println(F("Trigger the demo with DEMO_ATTACK in the UNO Serial Monitor."));
  } else if (strcmp(line, "STATUS") == 0) {
    Serial.print(F("STATUS | UNO_seen="));
    Serial.print(unoSeen ? F("YES") : F("NO"));
    Serial.print(F(" | guardian="));
    Serial.print(revoked ? F("REVOKED") : F("MONITORING"));
    Serial.print(F(" | reason="));
    Serial.println(revokeReason);
  } else if (*line) {
    Serial.println(F("[COMMAND] Unknown command. Type HELP."));
  }
}

char usbLine[64];
size_t usbLength = 0;

void pollUsb() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      usbLine[usbLength] = '\0';
      handleUsbCommand(usbLine);
      usbLength = 0;
    } else if (usbLength < sizeof(usbLine) - 1) {
      usbLine[usbLength++] = c;
    } else {
      usbLength = 0;
      Serial.println(F("[COMMAND] Line too long; discarded."));
    }
  }
}

void setup() {
  Serial.begin(USB_BAUD);
  Serial2.begin(LINK_BAUD, SERIAL_8N1, GUARDIAN_RX, GUARDIAN_TX);
  Serial.println();
  Serial.println(F("SENTINEL EASY DEMO | ESP32 GUARDIAN ONLINE"));
  Serial.println(F("UART2: RX GPIO16 / TX GPIO17 / 4800 baud"));
  Serial.println(F("Waiting for UNO heartbeat; no transaction permit is issued."));
  Serial.println(F("Type HELP for commands."));
}

void loop() {
  pollPeer();
  pollUsb();

  const unsigned long now = millis();
  if (!revoked && (unsigned long)(now - lastAnnounceAt) >= ANNOUNCE_MS) {
    sendGuardianOnline();
    lastAnnounceAt = now;
  }
}
