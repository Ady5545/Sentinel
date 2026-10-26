# SENTINEL — Judge Demo Runbook (27 October 2026)

## Goal

Present the **SENTINEL desktop ATM simulator** to judges. Do not use Arduino IDE Serial Monitor as the presentation interface. The boards have a separately tested, simplified UART demo; the desktop simulator's V3.4 hardware bridge is a different integration path and must not be represented as connected to the simplified firmware.

## Start the desktop simulator on the Mac

From Terminal:

```bash
cd ~/Documents/Ady/Sentinel
git fetch origin
git checkout fix/one-way-sentinel-fixture-demo-2026-10-27
git pull --ff-only origin fix/one-way-sentinel-fixture-demo-2026-10-27
npm install
npm run dev
```

Keep the Electron window open. If this checkout is in another folder, run the commands from that SENTINEL repository folder. This launches the native desktop app and its local Vite renderer; it is not the GitHub Pages website. The core simulation works offline and does not need either board connected.

## Main judge sequence (about 2–3 minutes)

1. Open **Experiment Lab** from the left navigation.
2. Explain that the same controlled synthetic evidence is replayed in two modes, and that the outcome is determined by the virtual dispenser gate.
3. Select **Unprotected baseline**.
4. Click **Run controlled compromise scenario**. Point to the **UNAUTHORIZED DISPENSE** result and the virtual cash released. State that this is the deliberately unprotected software comparison.
5. Click **Reset run** or select **SENTINEL active** (mode changes reset the scenario). Confirm the protected mode is selected.
6. Click **Run controlled compromise scenario** again. Show **AUTHORITY REVOKED**, **BLOCKED**, the policy findings, and unchanged cassette/account values.
7. Open **SENTINEL console** to show the authority state and findings. Open **Event journal** to show the recorded sequence.
8. If time allows, open **ATM terminal** and demonstrate a normal fictional customer flow. Demo PIN is `1234`; it is synthetic and must not be described as a real customer credential.

## What to say

> “SENTINEL is an offline-first educational ATM security simulator. We replay the same controlled integrity-violation fixture in an unprotected baseline and in protected mode. In baseline, the virtual dispenser accepts the unauthorized request. With SENTINEL active, the rule engine evaluates the evidence, revokes authority, and the domain-owned virtual dispenser gate blocks the release. The displayed cash, accounts, and peripherals are simulated.”

Be precise: the profile mismatch, stale heartbeat/frame, sequence divergence, privileged path, and illegal transition on this screen are **software-generated test evidence**. The software demo does not prove arbitrary real-world malware detection or a physical dispenser interlock.

## Physical boards — separate demonstration only

The latest simplified firmware uses:
- Uno peer UART: SoftwareSerial RX D2 / TX D3, 4800 baud.
- ESP32 UART2: RX GPIO16 / TX GPIO17, 4800 baud.
- USB serial monitors: 115200 baud.
- Uno D3 TX must pass through a suitable 5 V-to-3.3 V level shifter before ESP32 GPIO16 RX; grounds must be common. ESP32 GPIO17 TX connects to Uno D2 RX.

The physical logs recently confirmed: Uno heartbeat received → ESP32 processed the software-generated `PROFILE_MISMATCH` event → ESP32 latched revocation → Uno received revocation → virtual dispensing denied. Save those logs as backup evidence, but do not show Serial Monitor to judges unless specifically asked.

**Important compatibility boundary:** the simplified `SENTINEL EASY DEMO` firmware is not the full V3.4 framed protocol expected by the desktop Hardware Bridge. Do not connect it in the app and claim the desktop has verified live HIL readiness. Use **software-only presentation mode** for the judge flow.

## Before presenting

- [ ] Launch Electron and check all left-navigation screens open.
- [ ] Keep the app in **SENTINEL active / protected** mode after the comparison.
- [ ] Reset the scenario before a fresh run; a revoked run is intentionally latched.
- [ ] Do not rely on Wi-Fi or GitHub Pages.
- [ ] Keep the two serial logs and wiring photo available only as backup.
- [ ] Call all accounts, balances, notes and sensor/controller evidence fictional or simulated.
