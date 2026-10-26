---
description: Critical invariants for authoring Cloud Firestore queries to prevent silent omission of documents across evolving schemas.
globs: ["src/lib/firestore*.ts", "src/lib/dataset*.ts", "mobile/src/lib/dataset*.ts", "server/**/*.ts"]
---

# Firestore Query Invariants

1. **Beware Silent Omission in `orderBy`:**
   - In Cloud Firestore, any query containing `orderBy('someField')` will silently drop any document that lacks `someField` or has it set to `null`/`undefined`.
   - Never add `orderBy` constraints to queries querying collections with evolving, optional, or multi-version schema attributes unless that field is guaranteed to be present and indexed on 100% of documents.
   - Prefer querying with base filters (`where`) and applying in-memory sorting (`Array.prototype.sort()`) on the resulting array.

2. **Handle Composite Index & Offline Fallbacks Gracefully:**
   - Multi-field queries (`where` + `orderBy`) require composite indexes. Always wrap queries with try/catch fallbacks to basic queries.
