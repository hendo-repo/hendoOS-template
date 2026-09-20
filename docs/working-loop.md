# Phase 3 working loop

Phase 3 deliberately installs no general skill collection. The canonical set is
exactly `session-agent`, `closeout`, and `self-audit`, declared in
`skills/manifest.json`. The required set is fixed independently of renderer
output, every package carries pinned upstream provenance, and renderers copy
reviewed bytes into an explicit project root only. They never discover or write
an ambient home.

Codex and Hermes consume the generated `.agents/skills/<name>/SKILL.md` layout.
Normal discovery and slash selection must resolve the same file. A missing,
untrusted, duplicate, parent/project, user, or app-managed candidate is a visible
failure in the hendoOS discovery audit; hendoOS does not silently emulate a
host's first-wins behavior. The Codex layout follows the current
[official skill discovery contract](https://developers.openai.com/es-419/docs/build-skills),
which searches `.agents/skills` from the working directory through the repository
root and supports explicit or implicit invocation. The optional live proof uses disposable Git and
Hermes-home roots, launches no model turn, and requires every executable/runtime
path explicitly:

```sh
HENDOOS_CODEX_BINARY=/absolute/path/to/codex \
HENDOOS_HERMES_BINARY=/absolute/path/to/hermes \
HENDOOS_HERMES_PYTHON=/absolute/path/to/hermes/venv/bin/python \
HENDOOS_HERMES_AGENT_ROOT=/absolute/path/to/hermes-agent \
bun run prove:skills
```

The proof checks Codex project discovery from a child directory across fresh
app-server processes, Hermes exclusion before project trust, and Hermes slash
expansion from the exact rendered source after temporary trust. It is local
compatibility evidence, not a CI gate or a promise about future harness builds.

`src/edges/working-loop.ts` accepts one bounded JSON request on stdin. Its
actions catalog/render spine skills; audit, recall, explicitly load, and index
durable notes; or run closeout. Recall returns metadata first (`not-loaded`) and
requires a digest-bound body read (`loaded`), so absence, non-loading, changed
content, misunderstanding, and loaded-but-ignored feedback remain distinct.
Project notes lead, applicable active decisions follow, then matching lessons;
critical active lessons cannot be hidden by ordinary trigger ranking, and
`listAll` plus bounded pagination is the escape hatch. Native v1 notes and the
supported migrated-vault classes share one read contract without rewriting the
legacy files. Unsupported classes and excluded derived views are reported
separately. Lexical token/stem overlap is a small recall aid, not semantic
retrieval.

Durable Markdown notes have stable IDs, lifecycle, scope, harness audience,
provenance, source references, date ordering, trust, origin, and authority.
Recall and read responses carry source identity and note-local audit findings;
storage trust alone never makes text instructional. `learned_by` records
provenance only; it is never an audience filter. Raw observations and mixed
session summaries are untrusted evidence. Audits reject malformed frontmatter,
BOM bypasses, active prompt-injection patterns, common credential forms,
duplicate IDs, broken local references, symlinks, and resource-limit violations.
Native memory stores remain caches and are not authorities.

Indexes are deterministic, paginated, reference-backed, bound to a source
snapshot, and published as an immutable generation selected by one atomic
`CURRENT` pointer. Closeout uses a stable ID and request digest, checks tracker
update/readback identity, validates drafts before mutation, and uses a shared
project lock plus re-read to refuse stale writers. It writes one mixed-origin
session evidence note, updates factual project state, leaves lessons and
decisions as proposals, reruns scoped readback and source-bound index
publication, and retains a staged retryable failure receipt. These are separate
durable file operations, not multi-file atomicity. Replaying the same completed
request is safe; changing a request behind the same ID is refused.

Tracker prefixes use one shared comma-separated parser. Values normalize to
uppercase and reject empty items, leading digits, illegal characters, and
duplicates. Every accepted issue is exactly `PREFIX-<positive integer>`.
