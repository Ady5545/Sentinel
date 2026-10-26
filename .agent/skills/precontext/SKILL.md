---
name: precontext
description: Tells the agent which critical project context, architecture, rules, and schema files to discover and read, how to use codebase-memory-mcp knowledge graph tools, and enforces strict token-optimization and context-efficiency invariants before starting development or code modifications in any codebase.
---

# Precontext: Mandatory Orientation Before Development

Before planning, modifying code, refactoring, or authoring features in any codebase, an agent must discover, read, and internalize foundational project context files and leverage the codebase knowledge graph.

This prevents common architectural violations such as:
- Breaking core architectural invariants and boundaries (e.g. client vs server authority, unverified direct database writes).
- Introducing breaking changes across multi-platform surfaces (e.g. desktop web vs mobile PWA vs API services).
- Violating timing, precision, or strict latency requirements.
- Leaking PII, sensitive credentials, or violating regulatory retention boundaries.
- Re-introducing deprecated endpoints, outdated dependencies, or purged routines.

---

## 1. Codebase Knowledge Graph Orientation (codebase-memory-mcp)

Before jumping into manual file searches or grepping, **always prefer `codebase-memory-mcp` tools** to discover the project structure, symbol graph, and call paths:

1. **High-Level Topology:**
   - Call `get_architecture` or `index_status` / `list_projects` to review the architectural layers, module breakdown, and indexing generation.
2. **Symbol & Dependency Tracing:**
   - Use `search_graph` to locate handlers, classes, routes, models, or core services by pattern.
   - Use `trace_path` (`direction="inbound"` or `"outbound"`) to map callers and dependencies before proposing any structural changes.
   - Use `get_code_snippet` to retrieve targeted implementation snippets without dumping whole files.
3. **Coverage Verification:**
   - Run `check_index_coverage` on candidate paths. If a section is unindexed, stale, or excluded, fall back to targeted reads or grep.
4. **Cypher Querying:**
   - Use `query_graph` for multi-hop relationship queries (e.g. endpoints to database models).

---

## 2. Primary Required Reading (Discover & Read First)

Every agent must inspect core guidance files in the repository root, `docs/`, or `.ai/`/`.github/` directories prior to authoring non-trivial changes:

1. **AI Development Rules & Invariants:**
   - Look for: `RULES.md`, `.ai/RULES.md`, `.cursorrules`, `CLAUDE.md`, or `.agent/rules/`.
   - *Key topics to extract:* Architecture boundaries, data mutation rules, security invariants, design token constraints, and verification requirements.

2. **System Context & Technology Stack:**
   - Look for: `CONTEXT.md`, `.ai/CONTEXT.md`, `README.md`, or `docs/ARCHITECTURE.md`.
   - *Key topics to extract:* Platform architecture, authentication models, directory structure, dependency baselines, and deployment targets.

3. **Architectural Decisions Ledger:**
   - Look for: `DECISIONS.md`, `.ai/DECISIONS.md`, or `docs/decisions/` (ADRs).
   - *Key topics to extract:* Past architectural compromises, decommissioned endpoints, data flow designs, and why specific patterns were chosen.

---

## 3. Domain-Specific Reading (Read Based on Task Scope)

Depending on the specific area of development, discover and inspect the relevant repository specifications:

### A. Core Architecture & Environment
- **Architecture Overview:** `docs/ARCHITECTURE.md` or system diagrams in `docs/`.
- **Development Setup & Commands:** `docs/DEVELOPMENT.md`, `CONTRIBUTING.md`, or `README.md`.
- **Package & Dependency Manifests:** `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, or equivalent.

### B. Data Models, Schemas & Security
- **Data Model & Database Schemas:** `docs/DATA_MODEL.md`, Prisma/Drizzle/SQL schemas, or ORM model directories.
- **Security Boundaries & Retention:** `docs/SECURITY.md`, `security_spec.md`, or API auth middleware.
- **Access Rules & Permissions:** `firestore.rules`, PostgreSQL RLS policies, IAM policies, or RBAC definitions.
- **Data Provenance & Ingestion Specs:** Specifications governing data ingestion, provenance signing, and audit trails.

### C. Domain Logic & Business Rules
- **Core Domain Specifications:** Functional specifications in `docs/specs/` or equivalent domain folders.
- **Validation Rules & Contracts:** Input validators, schema validations (Zod, Joi, Pydantic), and shared interfaces.
- **Server Engines & Core Processing:** Backend calculation engines, worker queues, and orchestration layers.

### D. UI, Styling & Design System
- **Design System & Theme Tokens:** `docs/DESIGN_SYSTEM.md`, Tailwind config, CSS custom properties, or component library tokens.
- **Brand Guidelines:** `docs/BRAND_GUIDELINES.md` or visual specifications.
- **Canonical Navigation & Layouts:** Primary navigation shells and shared layouts.
- **Multi-Surface Structure:** Separate surface directories (e.g. `src/` for web, `mobile/src/` for mobile, `admin/` for internal tooling).

---

## 4. Universal Pre-Modification Checklist

Before proposing or executing code changes:

- [ ] Have you queried `codebase-memory-mcp` (`get_architecture`, `search_graph`, `trace_path`) to understand relationships and callers?
- [ ] Have you checked for active vs deprecated routes, functions, or parameters to avoid re-introducing dead patterns?
- [ ] Are data mutations routed through authoritative backend/API handlers rather than untrusted client-side direct calls?
- [ ] Are project-specific precision, performance, or timing constraints preserved?
- [ ] If modifying shared components or layouts, did you check responsive viewports, multi-surface parity, and theme compatibility?
- [ ] Are all dependency versions and package manager commands aligned with repository requirements?
- [ ] Are your context notes, prompts, and tool calls compliant with the token optimization and context efficiency invariants?

---

## 5. Token Optimization & Context Efficiency Protocol

All context gathering, prompt authoring, tool invocations, and response generation must obey strict token efficiency invariants:

### A. Strict Optimization Rule
- **Core Invariant:** Optimise for the fewest tokens that preserve the full meaning, correctness, and usefulness of the task. Shorter is not automatically better if it causes ambiguity, missing requirements, or implementation errors.
- **Adaptive Application:** Simple tasks should receive minimal context and instructions; complex engineering tasks should retain sufficient detail for reliable execution.
- **Prevent Over-Compression:** Do not omit necessary implementation details, safety checks, test requirements, user constraints, or evidence. Never replace concrete instructions with vague phrases such as "fix everything" or "make it better."

### B. Context & Information Prioritization
- **Context Efficiency:** Include only information relevant to the current task. Exclude unrelated history, repetition, redundant explanations, and unnecessary background.
- **Context Prioritization:** Prioritise the current request, explicit constraints, recent decisions, relevant project state, and essential historical context.
- **Preserve Critical Details:** Never remove requirements, filenames, paths, API contracts, error messages, edge cases, acceptance criteria, security constraints, or other information needed for correctness.

### C. Agent, Prompt & Tool Execution Efficiency
- **Prompt Compression:** Use direct instructions, concise wording, compact bullet points, and clear labels. Prefer simple English over unnecessarily complex language.
- **Output Efficiency:** Avoid repeating the user's prompt, excessive introductions, unnecessary summaries, and verbose explanations. Deliver the requested result directly.
- **Agent and Tool Efficiency:** Avoid unnecessary tool calls, repeated searches, redundant file reads, duplicate investigations, and repeated work. Reuse verified findings and existing context whenever possible.
- **Coding-Task Efficiency:** Keep implementation instructions precise. Specify scope, required changes, constraints, validation commands, and completion criteria without unnecessary prose.
- **Planning and Auditing:** Consolidate overlapping findings, distinguish blockers from minor improvements, and provide actionable recommendations instead of repeating observations.
- **Long-Context Management:** Maintain compact, structured working notes containing decisions, current state, unresolved issues, and next steps. Retain critical facts when summarising.
- **Budget Awareness:** When a model or tool has a known token limit or cost constraint, adjust response length and investigation depth accordingly without sacrificing essential verification.
