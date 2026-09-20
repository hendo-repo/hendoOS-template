---
name: self-audit
description: Read-only audit of hendoOS spine discovery, durable-memory integrity, recall outcomes, closeout receipts, and generated-index reproducibility. Use when asked to audit the framework or before claiming the working loop is healthy. Never auto-remediate.
version: 1.1.0
---

# Self Audit

Audit without changing state:

1. Validate the canonical spine manifest, package files, provenance, and license fields.
2. Resolve Codex and Hermes discovery from explicit roots; report trust, shadowing, name collisions, and the exact selected source.
3. Scan durable notes for schema, reference, scope, lifecycle, prompt-injection, and secret findings. Raw observations never count as trusted decisions.
4. Verify project-first recall and durable evidence-linked feedback across `inaccessible`, `not-found`, `loaded`, `not-loaded`, `misunderstood`, `loaded-but-ignored`, `stale-or-incorrect`, `disproportionate`, `applied`, and `no-action`.
5. Regenerate indexes in memory and compare their digests with published artifacts.
6. Verify closeout receipts, tracker readbacks, session-log references, and unresolved failed transactions.

Return evidence and named gaps. Do not edit framework files, tracker items, notes, or generated outputs.
