---
lifecycle: experimental
---

# Read-only drift checks

Import `InstallManifestSchema`, `InstallManifest`, and `InstallEntry` from
`src/schema/install.ts`. The strict Zod schema accepts this JSON object:

```ts
interface InstallManifest {
  schemaVersion: 1;
  owner: string;                 // nonblank
  generation: number;            // positive safe integer
  harness: string;               // generic nonempty name
  sources: { path: string; digest: string }[];
  outputs: { path: string; digest: string }[];
}
```

Both lists must be nonempty. Digests are exactly `sha256:` plus 64 lowercase hex
characters, with no trailing newline. Paths must already be safe relative POSIX
paths in NFC form. Traversal, absolute paths, backslashes, control characters,
prototype names, Windows device names and ambiguous trailing dots/spaces are
rejected. Duplicate paths, case-fold aliases (including directory components),
and file/descendant conflicts are rejected within each list. Unknown object
fields are rejected. Source and output lists are separate namespaces.

Import these functions and types from `src/effects/drift.ts`:

```ts
interface CheckDriftOptions {
  sourceRoot: string;
  targetRoot: string;
  manifest: unknown;
  owner: string;
  expectedGeneration?: number;
}
checkDrift(options: CheckDriftOptions): Promise<DriftReport>;
checkDriftTargets(targets: readonly CheckDriftOptions[]): Promise<DriftAggregateReport>;
```

Pass an independent build manifest. Detection never loads a manifest from the
target, changes its hashes, or repairs files. A caller that supplies hashes
regenerated from altered target bytes has discarded its independent evidence;
this API cannot reconstruct that evidence. Ownership is an exact comparison,
not authentication or a signature. When supplied, `expectedGeneration` must
match exactly; mismatches in either direction produce `stale`.

`DriftReport` is JSON-safe: `status`, `checked`, `skipped`, `coverage`, `issues`.
Coverage contains `sources` and `outputs`, each with `expected`, `checked`, and
`skipped` counts. A conclusive missing file counts as checked; blocked reads
count as skipped. Invalid input has zero coverage because no inventory is
trusted. Root or ownership failures skip the entire valid inventory.

| Result | Meaning |
| --- | --- |
| `clean` | Both nonempty inventories were completely checked and match |
| `drift` | Complete checks found missing/modified files, stale source bytes, or generation skew |
| `indeterminate` | Input, ownership, roots, or any file check could not establish complete coverage |

`DriftIssue` has `kind`, `scope`, `message`, optional safe relative `path`, and
optional safety `code`. Kinds are `missing`, `modified`, `stale`, `ownership`,
`malformed`, and `unreadable`. Scopes are `manifest`, `roots`, `source`, `output`.
Reports omit absolute roots, file content, raw errors, owners and digests.
An unreadable item dominates a known mismatch: mixed evidence is indeterminate.

`DriftAggregateReport` contains `status`, summed `checked` and `skipped`, and
ordered `targets: DriftReport[]`. Empty sets and any indeterminate target yield
indeterminate. Otherwise any drift yields drift; only all-clean yields clean.
The aggregate is a sequence of observations, not an atomic snapshot.

## Filesystem primitives

Import `validateRoots(sourceRoot, targetRoot): Promise<PathResult<SafeRoots>>`
and `readFileDigest(root, path): Promise<PathResult<string>>` from
`src/effects/paths.ts`. `SafeRoots` has `sourceRoot` and `targetRoot` strings.
`PathResult<T>` is `{ ok: true; value: T } | PathFailure`. `PathFailure` contains
`ok: false`, `code`, and a fixed diagnostic `message`. Codes are `missing`,
`symlink`, `not-directory`, `not-file`, `overlap`, `unsafe-path`, `changed`, and
`unreadable`. The exported pure `isInstallPath(value: string): boolean` is
available from the schema module for caller preflight.

Roots must be explicit absolute existing directories. No live harness default
is resolved. Root overlap is checked lexically and physically, with conservative
case folding and device/inode comparison. Siblings are allowed. All root and
file components are inspected with `lstat`; symlinks are rejected, including
dangling links and links in ancestor components. Callers using an OS temporary
directory alias must first select its real directory as their explicit root.
Files must be regular files. Hashing reads actual bytes with Bun SHA256 through
a read-only, no-follow descriptor. File identity and metadata are checked before
and after reading. No shell or subprocess participates.

## Limits and evidence

These checks assume filesystem ancestors remain stable during the call. Native
portable path-based APIs cannot close every check/open race against a process
that can swap ancestor directories concurrently. These helpers are preflight
and observation primitives, not a race-proof authorization boundary for a future
installer. Such an installer must provide its own mutation-time protections.
Unlisted files are ignored, and regular-file hard links are allowed. No recursive
directory inventory or ownership of unlisted files is claimed. Read access can
update filesystem access times; no application writes occur.

`tests/drift.test.ts` uses unique temporary fixtures, positive and negative
controls, and before/after byte and metadata snapshots (excluding access times).
It checks both inventories, malformed inputs, missing/modified/stale files,
ownership, generation skew, symlinks, overlap, partial aggregation, and byte
hashing. Permission-denial proof depends on a non-root test process.

The legacy unset-home fresh-install behavior can report green. AOS requires an
explicit target and returns indeterminate for an unset or absent root. This is a
documented compatibility difference; these tests do not claim an actual legacy
differential run. There is no CLI or installer in this slice.
