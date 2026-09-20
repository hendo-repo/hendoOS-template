# Generated memory and session indexes

This document describes the older SQLite pointer-index API. Phase 3 durable
Markdown knowledge uses the separate reference-validating, paginated generation
contract in `docs/working-loop.md`; its project/lesson/session/harness indexes do
not inherit the 256-entry ceiling below.

Status: **BOUNDED / PARTIAL**. `src/state/indexes.ts` and `src/edges/indexes.ts` generate
Markdown indexes of *imported pointer metadata*. They do not read knowledge prose, do not
verify that a referenced document exists, and do not migrate any existing vault, note, or
configuration store. No ambient home, vault, or content discovery is performed.

Knowledge prose and configuration stay plaintext. The SQLite file holds validated pointers and
session metadata only, in an explicitly named database that the caller must supply.

## Data model

| Concern | Rule |
| --- | --- |
| Database | Explicit path only. `:memory:`, `file:` URIs, control characters, an aliased parent directory, a symlink, or a hard-linked file are refused. |
| Namespace | Every row is keyed `(owner, kind, id)` with `kind` in `memory` \| `session`. Owners are isolated: a query for one owner never returns another owner's rows. |
| Table | `aos_index_entries_v1`, with a unique `(owner, kind, reference)` constraint so one owner cannot point two ids at the same document. |
| Payload | Canonical JSON, at most 4096 bytes, enforced by a SQLite `CHECK`. |
| Modes | `write` creates the table and imports; `read` opens read-only with `query_only`. |

`check` reports metadata invariants for one explicit owner/kind. It is not a proof that a
reference resolves or that a declared status is true.

## Limits

Exported as `INDEX_LIMITS`.

| Limit | Value | Effect when exceeded |
| --- | --- | --- |
| `entries` | 256 | `generate`/`check` return `incomplete` with `reason` naming the entry limit; no artifact. |
| `requestBytes` | 262144 | Request input is refused (`input-bytes`, `input-file-limit`). |
| `frameBytes` | 4096 | CLI result frame is refused rather than emitted truncated. |
| `maxBytes` | 131072 | Caller-chosen Markdown ceiling; overflow yields no artifact. |
| `maxLineBytes` | 4096 | Caller-chosen per-line ceiling; overflow yields no artifact. |
| `timeoutMs` | 5000 | CLI deadline (1..10000 by flag). |

Schema bounds: identifier `token` at most 64 characters; `reference` at most 240; `title` at
most 240 characters *and* at most 512 UTF-8 bytes, NFC, no control/line-separator characters,
no leading or trailing whitespace. Timestamps must be UTC millisecond form
(`YYYY-MM-DDTHH:MM:SS.sssZ`) and round-trip through `toISOString`. A `session` entry also
carries `startedAt`, which may not follow `updatedAt`.

## Fail-closed reporting

`IndexReport` is `{ schema: 'aos.index/v1', status: 'complete' | 'empty' | 'incomplete', reason,
count, artifact }`.

- **Empty owner scope** → `empty`, `artifact: null`, `reason` states that completeness is
  unknown. An empty scope is never reported as a successful complete result.
- **Overflow (entries, bytes, or line length)** → `incomplete`, `artifact: null`, with a reason
  that names explicit paging or on-demand lookup as the safe alternative. A selected prefix is
  never published, and no lexical top-K ranking is performed.
- **Malformed stored state** (unparsable payload, a payload that disagrees with its indexed
  id/reference, a duplicate reference) → `incomplete`, never a partial list.
- No path silently truncates a relevant entry, drops a safety-relevant pointer, or fabricates
  an empty success.

## Deterministic output

Entries are ordered by identifier under `ORDER BY id COLLATE BINARY`, so the same stored rows
produce byte-identical Markdown regardless of import order, and the reported `digest` is stable.
The document has a fixed frontmatter shape:

```
---
schema: aos.index/v1
generated_by: aos-indexes-v1
owner: "<owner>"
kind: memory|session
status: complete
count: <n>
source_digest: sha256:<64 hex over canonical scope+entries>
---
```

Metadata cannot become structure: ASCII punctuation in a title is emitted as numeric HTML
entities, so a title cannot open a Markdown link, an HTML tag, a code span, or frontmatter —
and it still stays readable in the body rather than being dropped.

## CLI

Runs from the source checkout. One request per invocation; diagnostics on stderr, one JSON
frame on stdout.

```sh
bun src/edges/indexes.ts --request ./import.json
bun src/edges/indexes.ts --request ./generate.json --timeout-ms 2000
bun src/edges/indexes.ts --request -            # request JSON on stdin
```

```json
{"action":"import","database":"/tmp/demo/state.sqlite","batch":{"version":1,"owner":"demo",
  "entries":[{"kind":"memory","id":"alpha","reference":"notes/alpha.md","title":"Alpha note",
  "updatedAt":"2026-01-02T03:04:05.000Z","status":"active"}]}}
```

```json
{"action":"generate","database":"/tmp/demo/state.sqlite","output":"/tmp/demo/memory.md",
  "options":{"owner":"demo","kind":"memory","maxBytes":131072,"maxLineBytes":4096}}
```

```json
{"action":"check","database":"/tmp/demo/state.sqlite","scope":{"owner":"demo","kind":"memory"}}
```

Create the database's parent directory first. Unknown fields, unknown actions, and a
non-integer or out-of-range timeout are refused. Exit code 0 means the action completed; 1
covers refusals and incomplete reports. A refusal still prints a JSON frame
(`{"schema":"aos.index-cli/v1","status":"incomplete","reason":"...","artifact":null}`).

Publication is create-only and atomic: the Markdown is written to a mode-`0600` temporary file
in the output directory, synced, then hard-linked into place. An existing output path — the
generated file, a hand-written file, or a symlink — is refused (`output-exists`,
`output-parent-alias`) and left byte-for-byte intact. Failure at any point leaves no partial
artifact and no temporary file behind.

## Library API

```ts
import { IndexStore, INDEX_LIMITS, IndexError } from './src/state/indexes.ts';

const writer = new IndexStore('/tmp/demo/state.sqlite', 'write');
writer.import({ version: 1, owner: 'demo', entries: [ /* IndexEntry */ ] }); // { inserted, replayed }
writer.close();

const reader = new IndexStore('/tmp/demo/state.sqlite', 'read');
const report = reader.generate({ owner: 'demo', kind: 'memory', maxBytes: 131072, maxLineBytes: 4096 });
reader.close();
```

- `IndexStore(path, mode)` — `read` | `write`; a `read` store refuses `import`.
- `import(input, deadline?)` — immutable and idempotent: an exact replay succeeds and counts as
  `replayed`; a changed payload or reused reference is `entry-conflict` and rolls the batch back.
- `check(input)` / `generate(input)` — validate the scope/options, then read one snapshot.
- `parseIndexInput(schema, input)` — bounded plain-data gate (rejects accessors, non-plain
  prototypes, non-finite numbers, cycles, excessive depth) before schema parsing.
- `parseIndexJson(text)` — JSON grammar plus duplicate-key rejection.

`IndexError.code` values: `explicit-database-required`, `plain-data-required`, `input-complexity`,
`invalid-json`, `duplicate-json-key`, `input-bytes`, `input-file-limit`, `invalid-input`,
`duplicate-entry`, `entry-conflict`, `read-only`, `timeout`, `malformed-state`, `output-limit`,
`entry-limit`, `output-exists`, `output-parent-alias`, `database-parent-alias`, `database-alias`,
`frame-limit`, `usage`, `timeout-limit`.

## Verification

```sh
bun test tests/indexes.test.ts
bun test
bun run --bun tsc --noEmit
bun verify
```

`tests/indexes.test.ts` covers real SQLite persistence and reopen, independent writer handles,
owner/kind isolation, invalid identifiers/references/statuses/timestamps, duplicate and conflict
handling, malicious titles (Markdown/HTML/link/separator/NFC), exact byte and line ceilings, the
entry ceiling, malformed stored state, deterministic generation, atomic output ownership, and
subprocess runs of the real source-checkout CLI.

Measured with `bun test --coverage` on the scoped suite: **`src/state/indexes.ts` 100% lines,
100% functions**; the CLI edge module measures 85% lines / 91% functions when exercised
in-process (its stdin and timeout branches are additionally covered through subprocess runs, which
the in-process coverage counter cannot see). This is a measured figure for the scoped suite, not
whole-repository coverage.

## Residual limitations

- No FTS, embedding, ranking, or model retrieval. The engine returns ordered metadata only.
- No vault, note-store, or configuration migration; no private corpus is read, and no ambient
  discovery of homes, knowledge roots, or owners is attempted.
- `check` validates metadata invariants and internal consistency, not reference existence,
  freshness, or the truth of a declared status.
- `generate` reads one statement (one snapshot). Cross-process writers rely on SQLite locking
  with a 100 ms busy timeout; a long import from another process can produce `entry-conflict` or a
  timeout refusal rather than a wait.
- The CLI deadline bounds request reading, import, and generation, not the entire process
  lifetime.
- Output publication never updates an existing generated file: there is no overwrite, rotate, or
  ownership-marker re-issue path. Callers that need a refresh must remove the file first.
