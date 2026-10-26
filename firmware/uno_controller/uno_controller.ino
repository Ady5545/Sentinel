/*
 * SENTINEL EASY DEMO — Arduino Uno
 * Peer UART: RX D2, TX D3, 4800 baud
 * USB Serial Monitor: 115200 baud, line ending = Newline
 *
 * Educational simulation only. No real bank, PIN pad, or cash hardware.
 * The ESP32's reply is required for healthy status. If the guardian is
 * unavailable, the virtual dispenser stays disabled.
 */
#include <Arduino.h>
#include <SoftwareSerial.h>
#include <string.h>
#include <stdlib.h>

static const uint8_t GUARDIAN_RX = 2;
static const uint8_t GUARDIAN_TX = 3;
static const unsigned long LINK_BAUD = 4800;
static const unsigned long USB_BAUD = 115200;
static const unsigned long HEARTBEAT_MS = 500;
static const unsigned long GUARDIAN_TIMEOUT_MS = 2200;

SoftwareSerial GuardianSerial(GUARDIAN_RX, GUARDIAN_TX);

char peerLine[96];
size_t peerLength = 0;
char usbLine[64];
size_t usbLength = 0;
unsigned long lastGuardianAt = 0;
unsigned long lastHelloAt = 0;
bool guardianOnline = false;
bool revoked = false;
bool attackPending = false;
long demoBalance = 10000; // fictional demo credits

void printStatus() {
  const bool fresh = guardianOnline &&
    (unsigned long)(millis() - lastGuardianAt) <= GUARDIAN_TIMEOUT_MS;
  Serial.print(F("STATUS | guardian="));
  if (revoked) Serial.print(F("REVOKED"));
  else if (fresh && !attackPending) Serial.print(F("ONLINE"));
  else Serial.print(F("WAITING / FAIL-CLOSED"));
  Serial.print(F(" | virtual_balance="));
  Serial.print(demoBalance);
  Serial.print(F(" | virtual_dispensing="));
  Serial.println((fresh && !revoked && !attackPending) ? F("ENABLED") : F("DENIED"));
}

void lockFromGuardian(const char *reason) {
  if (!revoked) {
    revoked = true;
    guardianOnline = false;
    attackPending = false;
    Serial.print(F("[SECURITY] Guardian revoked authority: "));
    Serial.println(reason);
    Serial.println(F("[ATM] Virtual dispensing DENIED until both boards are restarted."));
  }
}

void handlePeerLine(char *line) {
  if (strcmp(line, "GUARDIAN|ONLINE") == 0 && !revoked && !attackPending) {
    guardianOnline = true;
    lastGuardianAt = millis();
    return;
  }
  if (strncmp(line, "GUARDIAN|REVOKED|", 17) == 0) {
    lockFromGuardian(line + 17);
    return;
  }
  // Ignore unknown startup text, but never grant authority from it.
}

void pollPeer() {
  while (GuardianSerial.available()) {
    char c = (char)GuardianSerial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      peerLine[peerLength] = '\0';
      if (peerLength) handlePeerLine(peerLine);
      peerLength = 0;
    } else if (peerLength < sizeof(peerLine) - 1) {
      peerLine[peerLength++] = c;
    } else {
      peerLength = 0; // discard overlong line
      guardianOnline = false;
    }
  }
}

void handleCommand(char *line) {
  while (*line == ' ' || *line == '\t') ++line;
  if (!*line) return;

  if (strcmp(line, "HELP") == 0) {
    Serial.println(F("Commands: HELP, STATUS, WITHDRAW 500, DEMO_ATTACK"));
    Serial.println(F("Demo starts with 10000 fictional credits; no real cash is dispensed."));
  } else if (strcmp(line, "STATUS") == 0) {
    printStatus();
  } else if (strcmp(line, "DEMO_ATTACK") == 0 || strcmp(line, "FIXTURE_MISMATCH") == 0) {
    if (revoked) {
      Serial.println(F("[DEMO] Already revoked. Restart both boards to reset the demo."));
      return;
    }
    attackPending = true;
    guardianOnline = false;
    GuardianSerial.println(F("EVENT|SIMULATED|PROFILE_MISMATCH"));
    Serial.println(F("[DEMO] Sent SIMULATED PROFILE_MISMATCH event to SENTINEL."));
    Serial.println(F("[ATM] Dispensing disabled while guardian decision is pending."));
    Serial.println(F("[NOTE] 'Sent' does not prove 'received'; check the ESP32 monitor."));
  } else if (strncmp(line, "WITHDRAW ", 9) == 0) {
    char *end = NULL;
    long amount = strtol(line + 9, &end, 10);
    while (end && (*end == ' ' || *end == '\t')) ++end;
    const bool fresh = guardianOnline &&
      (unsigned long)(millis() - lastGuardianAt) <= GUARDIAN_TIMEOUT_MS;
    if (!end || *end || amount <= 0 || amount > 5000) {
      Serial.println(F("[ATM] Use WITHDRAW <amount> (1 to 5000)."));
    } else if (revoked || attackPending || !fresh) {
      Serial.println(F("[ATM] DENIED — guardian not confirmed healthy."));
    } else if (amount > demoBalance) {
      Serial.println(F("[ATM] DENIED — insufficient fictional demo balance."));
    } else {
      demoBalance -= amount;
      Serial.print(F("[ATM] SIMULATED withdrawal approved: "));
      Serial.print(amount);
      Serial.print(F(" credits. Balance="));
      Serial.println(demoBalance);
      Serial.println(F("[NOTE] This is a software simulation, not physical dispensing."));
    }
  } else {
    Serial.println(F("[COMMAND] Unknown command. Type HELP."));
  }
}

void pollUsb() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      usbLine[usbLength] = '\0';
      handleCommand(usbLine);
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
  GuardianSerial.begin(LINK_BAUD);
  Serial.println();
  Serial.println(F("SENTINEL EASY DEMO | UNO ONLINE"));
  Serial.println(F("UART: RX D2 / TX D3 / 4800 baud"));
  Serial.println(F("Hardcoded demo balance: 10000 fictional credits."));
  Serial.println(F("Waiting for ESP32 guardian. Dispensing starts DENIED."));
  Serial.println(F("Type HELP for the 4 simple commands."));
}

void loop() {
  pollPeer();
  pollUsb();

  const unsigned long now = millis();
  if (guardianOnline && (unsigned long)(now - lastGuardianAt) > GUARDIAN_TIMEOUT_MS) {
    guardianOnline = false;
    Serial.println(F("[LINK] Guardian heartbeat lost. Virtual dispensing DENIED."));
  }
  if (!revoked && !attackPending && (unsigned long)(now - lastHelloAt) >= HEARTBEAT_MS) {
    GuardianSerial.println(F("UNO|ONLINE"));
    lastHelloAt = now;
  }
}
