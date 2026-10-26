---
name: doc-audit-sync
description: Systematic, token-optimized procedure for auditing, synchronizing, and bootstrapping multi-file documentation suites, ADRs, specs, and AI context files. Use when updating existing docs or generating missing README, CHANGELOG, ARCHITECTURE, DATA_MODEL, SECURITY, or .ai context files after codebase changes.
---

# Documentation Audit & Synchronization Skill

## When to Use
Use this skill whenever:
- A major feature, architectural change, or refactor is completed.
- Deprecated routes, APIs, or credentials (e.g. admin routes, passwords) are purged from code.
- Dependencies or engine floors (e.g. Node.js version, package manager) change.
- The project documentation suite (README, CHANGELOG, ARCHITECTURE, specs, ADRs, `.ai/` directory) needs verification against actual code.
- Essential documentation or AI orientation files do not exist yet and must be authored/bootstrapped from current codebase facts.

---

## Codebase Memory & Graph Verification (codebase-memory-mcp)
When exploring symbol relationships, dependencies, call hierarchies, and architectural links during doc sync, **ALWAYS prefer `codebase-memory-mcp` tools** before falling back to manual grep/find:
1. `get_architecture` — Inspect high-level architectural layers and module topologies.
2. `search_graph` / `query_graph` — Locate functions, classes, routes, or entities to verify documented vs actual signatures.
3. `trace_path` — Trace call paths and dependencies to ensure sequence diagrams and data flow docs match code reality.
4. `check_index_coverage` — Validate graph freshness before making exhaustive doc claims. Fall back to targeted grep/read for unindexed files or non-code files (e.g. Dockerfiles, configs).

---

## Procedure

### Step 1: Discover, Map, and Identify Missing Documentation Files
1. Identify all existing doc files across root, `docs/`, `docs/specs/`, `docs/decisions/`, `security/`, and `.ai/`.
2. Check for missing baseline documentation files:
   - **Repository Root:** `README.md`, `CHANGELOG.md`
   - **System Architecture & Setup:** `docs/ARCHITECTURE.md`, `docs/DEVELOPMENT.md`
   - **Data & Security Specs:** `docs/DATA_MODEL.md` (or schema specs), `docs/SECURITY.md`
   - **AI Context & Orientation Suite:** `.ai/CONTEXT.md`, `.ai/DECISIONS.md`, `.ai/RULES.md` (or equivalent `.agent/rules/`, `.cursorrules`, `CLAUDE.md`)
3. Flag any missing foundational files to be created in Step 4.

### Step 2: Extract Invariants from Source Code
Before touching or creating documents, verify true facts from source:
1. `package.json` / dependency manifests: Check `"name"`, `"version"`, `"engines"`, `"packageManager"`, and `"scripts"`.
2. Git commit history: Run `git log -n 10 --oneline` to find all recent features, fixes, and deprecations.
3. Security boundaries: Inspect route definitions, security rules/policies, and server endpoints to confirm active vs deleted endpoints.
4. Graph validation: Use `codebase-memory-mcp` to verify code symbol structures and module interactions.

### Step 3: Run Fast Scan for Obsolete Remnants
Run an in-session scan to search for stale keywords across all doc files:
- Deprecated routes or endpoints
- Obsolete secret keys, tokens, or passcodes
- Outdated runtime versions (e.g., old Node/Python runtimes)
- Inconsistent package managers (e.g., `bun` vs `npm` vs `pnpm`)

### Step 4: Apply Surgical Edits & Bootstrap Missing Files
- **For Existing Documents:**
  - Group updates by document tier.
  - Use surgical edits (`replace_file_content` / targeted line replacements).
  - Never overwrite entire existing files unless authoring a completely new document.
- **For Missing Documents (Create New):**
  - If baseline documents identified in Step 1 do not exist, bootstrap them using authoritative facts extracted in Step 2:
    - Create `.ai/` context files (`CONTEXT.md`, `RULES.md`, `DECISIONS.md`) to guide future agent workflows.
    - Create `docs/ARCHITECTURE.md` or `README.md` if the repository lacks orientation documents.
    - Create `CHANGELOG.md` seeded with initial version history or recent git commits.

### Step 5: Update Release Notes & AI Context
- Add entries to `CHANGELOG.md` under the current version (or initialize the changelog section).
- Update repository AI context files (`.ai/CONTEXT.md`, `.ai/DECISIONS.md`, `.ai/RULES.md`, `.cursorrules`, or `CLAUDE.md`) so future agent sessions operate on current context.

### Step 6: Automated Link & Reference Verification
Run a verification script to confirm all cross-referenced paths exist and no broken links remain.
