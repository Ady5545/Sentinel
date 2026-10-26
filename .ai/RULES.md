# SENTINEL Development & Coding Invariants

## 1. Memory & Buffer Safety in Firmware
- Never use dynamic memory allocation (`malloc`, `free`, `new`, `String` class) on Arduino UNO (`uno_controller.ino`). Always use fixed-size static buffers with bounds checking (`snprintf_P`, `sizeof`).
- Securely zero out sensitive data (such as entered PIN buffers) immediately after use via `secureClear`.

## 2. Protocol Integrity
- Every transmitted frame must include an incrementing sequence number.
- Payload fields must strictly follow canonical ordering.
- Never bypass the guardian handshake before initiating a dispense sequence.

## 3. Host & UI Standards
- Maintain strict separation between Electron Main (`electron/main.cjs`) and Renderer (`src/App.tsx`).
- Never expose raw Node.js primitives or arbitrary file writes to the renderer without IPC sanitization.
- The UI must handle disconnections gracefully and indicate link latency and dropped frames.
