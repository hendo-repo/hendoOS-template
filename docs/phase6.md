# Phase 6 harness proof and repair boundary

Phase 6 is accepted per version and launch surface, never per product name. The
machine-readable matrix is `config/harness-surfaces.json`; its schema rejects
duplicate harness/version/surface rows. `verified`, `non-model-verified`,
`unverified`, and `unsupported` are distinct claims.

## R1-R5 integrity repairs

The working loop reads both native `hendoos.note/v1` notes and bounded legacy
vault notes in the durable source classes `01-Projects`, `03-Decisions`,
`04-Lessons`, `06-Sessions`, and `30-Archive/Sessions`. Raw/wiki/output/template
material is reported as `unsupported-class`. `90-Indexes` and `95-Views` are
derived and excluded from source scanning; the audit reports their excluded
count. Missing roots and unreadable supported files are errors, not ordinary
`not-found` recall.

Legacy metadata is adapted in memory. Source files are not bulk rewritten.
Recall returns project notes, applicable active decisions, and lessons with the
source path, source format, digest, scope, lifecycle, storage trust, origin,
authority, and note-local audit findings. Superseded decisions remain
historical. Trigger matching is bounded lexical token/stem overlap, not semantic
retrieval: the complete paginated `listAll` escape path and native vault search
remain necessary. A paraphrase can still miss, and a lexical hit can be stale or
irrelevant.

Storage trust does not imply instructional authority. A candidate is
`instructional` only when it is trusted, explicitly instructional, and has no
note-local scanner finding. Session closeout records are mixed-origin,
untrusted evidence. Quoted or fenced hostile examples are excluded from the
instruction scanner, while active instruction-shaped text and secret-shaped
material remain visible findings. This scanner is triage evidence, not a
sandbox.

Closeout validates the proposed project and session notes in an isolated draft
root before durable mutation. It then uses a shared project lock and a
read/lock/re-read comparison: a writer that read stale project bytes visibly
refuses rather than overwriting a newer writer. Project replacement, exclusive
session creation, immutable index generation, pointer publication, and final
receipt are separate durable boundaries; they are not described as a multi-file
atomic transaction. Failure receipts name the last boundary and remain
retryable. Retry uses the closeout marker and exact session bytes to avoid loss
or duplication.

Corpus findings outside the two changed notes do not silently permit malformed
drafts and do not force a partial mutation. Indexes may represent an audited
corpus with retained findings, but their manifest names the exact source digest.
Publication re-audits the source immediately before selecting the generation;
an older snapshot cannot replace a newer source view.

Skill rendering is a read-only plan followed by a checked apply. Existing
same-name unmanaged packages and edited managed packages are conflicts. Apply
rechecks source catalog and target pre-images, rolls back partial writes, keeps
unrelated variants, and records removed expectations as retained residue rather
than manufacturing parity. Exact canonical bytes may be co-owned by the Codex
and Hermes render records.

## Codex 0.155.1 adapter

The official Codex hook contract was re-read on 2026-09-20:
<https://developers.openai.com/docs/hooks>. Current Codex requires unmanaged
hooks to be reviewed and trusted; `/hooks` is the interactive review surface.
Project trust, a settings hash, or file presence is not an ARMED receipt.

`codex-pre-tool-use/1` accepts a bounded native `PreToolUse` event and records a
receipt before replying. The default configuration mode is `shadow`. Shadow
replies are deterministic for the same observation and never contain
`permissionDecision`. Opt-in `enforce` emits native `deny` only when the parser
proves that an `apply_patch` target is protected or outside the configured
workspace. A supported in-workspace patch receives no native decision, so normal
Codex consent and sandboxing still apply. Bash and malformed/unsupported inputs
are indeterminate and never promoted to allow.

The path parser covers the installed native `apply_patch` command shape only.
It does not claim shell parsing, process containment, filesystem mediation,
hosted-tool coverage, or security-sandbox status. Specialized paths can bypass
hooks, multiple matching hooks start concurrently, and missing or unlaunchable
hook commands cannot emit a fallback. The staged wrapper does emit a no-decision
failure when it starts but an owned bundle/config/runtime is unavailable.

The lifecycle renderer bundles the adapter, quotes its exact absolute POSIX
command, merges one owned `hooks.PreToolUse` item, and uses the existing
ownership-aware installer. The private live proof uses a disposable Codex home,
explicit hook-trust bypass only for that vetted automation run, an independently
checked protected-file canary, the raw receipt's `tool=apply_patch`, and a
same-shape permitted patch. Normal interactive operation still requires the
operator to review the exact hook through `/hooks`.

## Outcome corpus

`scripts/prove-phase6.ts` runs nine isolated Codex child sessions: three routine
pickup cases, three relevant/irrelevant/stale guidance cases, and three
trust/handoff cases. Every result records the exact revision, Bun/Codex/model,
surface, elapsed time, exit/timeout, JSONL event count, byte counts, expected and
observed artifact digests, loaded-source evidence visible in the event stream,
and hook receipts. Artifact bytes decide acceptance; model declarations do not.
The relevant-lesson case distinguishes loaded-and-applied from
loaded-but-ignored. Optional memory absence must not cause false refusal.

The operator authorized live model scenarios only in Codex. Claude ordinary
startup/compaction/resume, Hermes native child and hook-return behavior, Cursor
headless/IDE/cloud, and every non-Linux live model surface remain explicitly
unverified or unsupported in the matrix. The Codex child corpus is the explicit
replacement for the older Codex-plus-Hermes cohort obligation; it does not
silently create Hermes parity.

## Handoff and failure semantics

`hendoos.handoff/v1` validates schema, parent/child identity, terminal status,
artifact path/digest, owner, blockers, out-of-scope paths, evidence, and process
dispositions. Acceptance independently reads a bounded regular artifact and
runs caller-supplied semantic verification. Denied, stalled, timed-out,
cancelled, parent-interrupted, missing/wrong artifacts, unresolved blockers,
out-of-scope edits, and owned surviving processes are non-acceptance. Prompt-only
caps and a one-line child response are never treated as resource enforcement or
delivery proof.

## Limits

This phase demonstrates one Linux x86_64 Codex exec/child slice plus portable
synthetic contracts. It does not prove TUI, desktop, IDE, cloud, macOS, Windows,
power-loss atomicity, universal hook coverage, causal efficiency gains, or
containment against a hostile process. Unknown model/tool monetary cost remains
unknown. Phase 7 owns broader platform proof, independent review, onboarding,
and the daily pilot.
