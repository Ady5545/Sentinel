# SENTINEL board firmware

This folder contains the first Arduino sketches for the existing two-board research prototype.

- [Arduino Uno controller](uno_controller/uno_controller.ino)
- [ESP32 independent guardian](esp32_guardian/esp32_guardian.ino)
- [Firmware contract and validation sequence](../../docs/FIRMWARE_V1_IMPLEMENTATION.md)
- [Protocol specification](../../docs/SENTINEL_PROTOCOL.md)

## Install and flash

Use Arduino IDE on the MacBook Air. Install the Espressif ESP32 board package if not already installed.

1. Select **ESP32 Dev Module**, open `esp32_guardian/esp32_guardian.ino`, select the ESP32 USB port, upload, and open its USB Serial Monitor at **115200 baud**. It should say `SENTINEL ESP32 GUARDIAN READY`.
2. Close that Serial Monitor, select **Arduino Uno**, open `uno_controller/uno_controller.ino`, select the Uno port, upload, and open its USB Serial Monitor at **115200 baud**. It should say `SENTINEL UNO CONTROLLER READY`.
3. Power both boards by their own USB connections. Connect common GND. Connect Uno D3 (software TX) through a suitable level shifter/divider to ESP32 GPIO16 (UART2 RX). Connect ESP32 GPIO17 (UART2 TX) to Uno D2 (software RX). Do not connect the peer to Uno D0/D1, which are used for USB serial upload/diagnostics.
4. Use a proper 5 V-to-3.3 V level shifter if available. Never connect Uno 5 V TX directly to an ESP32 GPIO. The previously used equal 2.2 kΩ divider outputs about 2.5 V and can be marginal for reliable ESP32 logic-high recognition.
5. Close the Arduino IDE Serial Monitor before selecting that same serial port in the SENTINEL desktop app.

## Bench commands

Commands are typed into the relevant board's USB Serial Monitor (115200 baud).

Uno:
- `status` — print controller/guardian observation.
- `demo_request` — send a virtual-only request if the current guardian permit is fresh.
- `fixture_mismatch` — emit a clearly labelled simulated integrity mismatch event.
- `recover` — explain the required clean reset; it does not clear a latched lock.

ESP32:
- `status` — print guardian state and heartbeat observation.
- `fixture_revoke` — inject a clearly labelled simulated revocation.
- `recover` — explain that the latched revocation requires a clean reset of both boards.

The conservative recovery flow in v1 is to reset both boards together, establishing a new session. A revocation is not cleared by sending a normal message.

## Expected first bench test

With both sketches flashed and the UART wired correctly, the Uno should report a guardian handshake, and the ESP32 should show valid heartbeats and a PERMITTED *observation*. Then send `fixture_mismatch` in the Uno monitor. The ESP32 should log a simulated test-evidence revocation; the Uno should enter GUARDIAN_LOCKED after it receives REVOKE. Send `demo_request`; the Uno must deny it. No physical output is ever driven.

If no handshake occurs, verify the selected board, pins, common ground, baud, RX/TX crossing and voltage-level interface. Open only one monitor at a time for the board whose USB port you are inspecting. Keep logs from both boards for debugging.

## Safety and claim boundaries

This is bench firmware for a school research prototype, not production ATM security firmware. CRC-16 detects accidental corruption but does not authenticate a sender. The reported build string is self-reported, not attestation. A compromised Uno can lie about its own state. The ESP32 is not a physical cash-dispenser interlock. The desktop simulator must independently evaluate hardware observations and enforce virtual dispenser denial before any end-to-end protection claim is made.
