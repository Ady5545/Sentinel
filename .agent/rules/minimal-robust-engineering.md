# Minimal & Robust Engineering Invariants (KISS, DRY, YAGNI, SOLID)

## Scope & Intent
Enforce deliberate, minimal, robust, and maintainable implementation habits. Prevent speculative design, over-engineering, code bloat, and accidental regressions of existing functionality.

---

## 1. Pre-Implementation Silent Reasoning
Before writing or modifying any code, silently reason through:
1. **Requirement & Assumptions:** What is the exact requirement and what assumptions are being made?
2. **Simplest Viable Design:** What is the simplest, cleanest solution that fully satisfies all stated requirements?
3. **Preservation Invariants:** Does existing functionality, UX, accessibility (ARIA, semantic HTML), error handling, or test coverage need to be strictly preserved?
4. **Exclusions (Anti-Goals):** What should **NOT** be added because it is not currently required?
5. **Minimal Surface Area:** What is the smallest possible set of file and line changes needed?

---

## 2. Core Principles & Anti-Over-Engineering Guardrails
- **Apply KISS, DRY, YAGNI, and SOLID:** Use the minimum code necessary without oversimplifying, removing required functionality, or breaking behavior.
- **No Speculative Abstractions:** Do not add speculative wrappers, interfaces, configuration options, dependencies, design patterns, or “future-proofing” unless required by the stated problem.
- **No Hard-Coding Configurable Logic:** Do not hard-code behavior that should remain configurable or general.
- **Direct over Clever:** Prefer direct, readable, self-explanatory code over clever or complex patterns.
- **Surgical Changes:** Modify the smallest possible surface area to accomplish the goal.

---

## 3. Preservation of Existing Features & Tests
- Do **not** remove, disable, or simplify away existing functionality, accessibility labels, descriptive text, error handling, or tests unless explicitly instructed.
- Ensure all existing contracts, interfaces, and expected behaviors remain intact.

---

## 4. Requirement Ambiguity Protocol
- If requirements are ambiguous or incomplete, ask only the clarifying questions necessary before implementing.
- Once clarified, proceed with the direct, minimal implementation.
