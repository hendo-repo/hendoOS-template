---
name: closeout
description: Close a meaningful hendoOS workstream with evidence, tracker readback, a durable session log, factual project-state refresh, and deterministic index audit. Use only at closeout; replay the same closeout ID instead of duplicating writes.
version: 1.0.0
---

# Closeout

1. Gather the exact candidate identity, changed files, verification evidence, and remaining limitations.
2. Update the active tracker item and read it back. A claimed update without matching readback is incomplete.
3. Run the hendoOS closeout transaction with a unique closeout ID. Supply the expected project-note digest so a newer writer cannot be overwritten.
4. Write one provenance-labeled session log. Propose lessons or decisions under the configured write policy; do not silently promote either.
5. Refresh and audit project, lesson, session, and harness indexes atomically. A failed write remains visible and retryable.
6. Classify created artifacts and state the next action or the verified terminal state.

Repeating an identical closeout ID must replay the receipt without another write. A changed request under the same ID is a conflict.
