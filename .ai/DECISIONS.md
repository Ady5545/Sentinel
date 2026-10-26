# SENTINEL Architectural Decisions (ADRs)

## ADR-001: Separation of Controller and Guardian Roles
- **Status:** Accepted
- **Context:** ATMs are frequently attacked by jackpotting (black-box attacks where malware directly instructs the cash dispenser).
- **Decision:** Separate the controller (Arduino UNO) executing UI/card flow from an independent guardian (ESP32) that holds supervisory policy and physical relay authority.
- **Consequences:** Compromise of the UNO controller does not allow arbitrary dispense without guardian authorization.

## ADR-002: ASCII Key-Value Protocol with CRC and Sequence Numbers
- **Status:** Accepted
- **Context:** Arduino UNO has only 2 KB SRAM and 32 KB flash. Complex binary protocols (Protobuf) or heavy JSON parsers cause buffer overflows and heap fragmentation.
- **Decision:** Use single-line ASCII frames (`[TYPE]:field=val;seq=N\n`) with deterministic delimiters and fixed stack buffers.
- **Consequences:** Easy to inspect on serial monitors, extremely low memory overhead, bounded parsing time.

## ADR-003: Idempotent Commit Acknowledgements & Half-Duplex Turn Taking
- **Status:** Accepted
- **Context:** Serial transmission across breadboards or physical UART can drop packets. Retrying a dispense commit must not double-disburse cash or crash the state machine.
- **Decision:** Implement sequence-locked commit tracking where duplicate commit reports reuse the exact original ACK payload without incrementing ledger metrics. Block operator commands until commits are acknowledged.
- **Consequences:** Eliminates ghost transactions and state desynchronization during transient link loss.
