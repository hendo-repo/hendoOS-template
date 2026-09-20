# Isolated installer library

`src/effects/install.ts` is the sole installer writer. It runs under Bun using built-in `bun:sqlite` and Bun's Node-compatible filesystem APIs. It loads no external native bindings and invokes no shell, Python or Node runtime. It installs rendered bytes into an explicit, existing target. Source, stage and target must be absolute, disjoint real directories without symlink components. It does not select live homes or register hooks.

## API and ownership

```ts
install(options: InstallOptions): Promise<InstallReport>
uninstall(options: UninstallOptions): Promise<InstallReport>
recoverInstall(options: RecoveryOptions): Promise<InstallReport>

interface InstallOptions {
  sourceRoot: string;
  stageRoot: string;
  targetRoot: string;
  manifest: unknown;
  owner: string;
  expectedGeneration?: number;
  modes?: Record<string, number>;
  failpoints?: Failpoints;
}
interface UninstallOptions {
  targetRoot: string;
  owner: string;
  expectedGeneration?: number;
  failpoints?: Failpoints;
}
interface RecoveryOptions {
  targetRoot: string;
  owner: string;
  assumeDead?: boolean;
  failpoints?: Failpoints;
}
```

Options reject unknown fields, accessors, inherited objects, wrong types and invalid generations. Manifest data must be plain JSON data. JavaScript Proxies are outside this contract because reflection can execute their traps. The shared strict `InstallManifestSchema` is unchanged: version 1, nonempty owner and harness, positive generation, and nonempty source/output lists with safe relative paths and SHA-256 digests.

`expectedGeneration` means the currently installed generation. An expectation on an empty target refuses. Generation regression refuses. Changed content, requested permission changes, new ownership and removal of unchanged owned outputs require a newer generation. Missing owned files can be recreated. Unowned collisions and modified owned outputs refuse. Modified stale entries remain recorded with their old digest and mode and produce `partial`.

Reserved controls are exported as:

| Constant | Relative path |
| --- | --- |
| `CONTROL_DIR` | `.aos` |
| `CONTROL_STATE_PATH` | `.aos/state.json` |
| `CONTROL_JOURNAL_PATH` | `.aos/journal.jsonl` |
| `CONTROL_LOCK_PATH` | `.aos/lock` |
| `CONTROL_COORDINATION_PATH` | `.aos/coordination.sqlite` |
| `CONTROL_STAGING_PATH` | `.aos/staging` |
| `CONTROL_BACKUP_PATH` | `.aos/backup` |

All `.aos` paths, including case aliases, are reserved. A completed install retains the coordination file and ownership state. A completed uninstall retains the coordination file. Valid no-op recovery/uninstall calls can also initialize it. Unknown control files remain untouched.

Ownership state stays version 1 with `owner`, `generation`, `harness`, and `entries: {path, digest, mode?}[]`. Optional `directories` records directories created for artifacts. Old state without directory provenance remains readable; its empty directories are preserved.

## Explicit permissions

Use `modes: { 'hooks/check': 0o755 }` to request executable output. Keys must exactly match manifest output paths. Values are integer permission bits from `0000` through `0777` with owner-read (`0400`) required for future digest verification. Special bits, strings, fractions, negative values, aliases and unrelated paths refuse before target writes. The input is portable permission notation, not a claim that every operating system implements it.

New outputs default to `0600`. Omitted modes on already owned outputs retain their recorded mode, including during content upgrades. Source and stage permissions never imply executable intent. The installer creates a private staged file, writes its bytes, applies the exact requested mode through that new file's handle, verifies the resulting mode, flushes it and rechecks the digest before placement. This defeats umask masking without chmod on an existing target or unrelated hard link. A mode-only upgrade replaces the owned file through the same backup transaction as a content upgrade.

Current permission bits, including special bits, must match recorded ownership before replacement, stale removal or uninstall. A user mode change is preserved even if bytes still match. Rollback and forward recovery also verify recorded modes. Backups retain the original inode and mode.

Legacy entries without `mode` have unknown permission ownership. Identical-content repeats without explicit mode requests remain readable and unchanged, with no new mode claim. Existing legacy files are preserved during replacement and uninstall, which report a conflict or partial result. Missing files may be recreated under a new explicit/default mode. Interrupted legacy plans without permission evidence require manual resolution; recovery does not guess. This conservative compatibility policy intentionally gives up automatic removal of hash-only legacy files to avoid deleting user permission changes.

## Exclusion and crash recovery

The design has no timed leases. Each operation opens the stable coordination file and holds an explicit SQLite `BEGIN IMMEDIATE` transaction across all asynchronous filesystem work. Contenders receive a nonblocking `lock-held` refusal. An in-process guard also prevents overlapping calls in this module from opening or closing the database while another call owns it. No asynchronous callback is passed to SQLite's synchronous transaction helper.

The database contains no application tables or durable lease rows; the live transaction provides exclusion only. Closing the connection or process death releases that lock. **A SQLite transaction is not held across process death.** The separate flushed marker and journal retain the unfinished operation. Install and uninstall refuse those markers; recovery must first obtain a new SQLite lock, then validate the evidence. An active recovery therefore excludes other operations even though the marker still names the original dead process.

The coordination inode is never unlinked or replaced by this library, including after uninstall. Removing it while callers could be running would let separate processes lock different inodes. Do not remove or replace it, its sidecars, the control directory or the target while any operation could be active. Its usual empty SQLite file is deliberate: no SQL data needs to be committed. There is no lease expiration, heartbeat or stale-owner takeover protocol.

The marker's owner, nonce, operation and generation must agree with the journal. A live marker PID conservatively blocks recovery by default. PID reuse can cause a false refusal. `assumeDead` skips only that PID diagnostic after acquiring SQLite exclusion; it cannot steal a live operation's lock. Unexpected process-probe errors count as alive. Marker and journal evidence is validated even with `assumeDead`.

Bun documents its [built-in SQLite API](https://bun.sh/docs/runtime/sqlite). The exclusion model follows SQLite's [file locking contract](https://www.sqlite.org/lockingv3.html). It requires a local filesystem with working SQLite locks.

## Mutation and recovery rules

Install validates roots, modes, manifest, every source digest and every staged digest before creating target controls. It repeats verification after obtaining exclusion, then reads ownership under that lock. Input changes after the first check can leave the stable coordination file but cannot authorize output mutation. Staged bytes are rechecked again when copied.

A flushed strict journal records the complete plan before artifact mutation. Validation checks sequence, phase order, owner/generation, state transitions, safe paths, exact backup destinations, modes, and the relationship of each action to old/new ownership. Torn or inconsistent journals refuse automatic recovery.

For replacement or removal, the original file is hard-linked into its planned backup after digest and mode checks. Only then is its target name removed. Placement links the new staged inode to the absent destination; `link` refuses an existing destination. The staged inode stays as rollback evidence. A journaled move scratch link may remain if the process dies before its removal. No overwrite rename or fallback is used. Ownership-state publication also uses an exclusive link after removing verified prior state; the plan covers the interval where state is absent.

**A multi-file install is not atomic.** Readers can observe mixed generations and absent paths during replacement, removal or state publication. `atomicity: 'per-file-link'` describes individual new-name placement. It replaces the former rename label because the implementation no longer performs renames.

The commit boundary is the flushed `committed` record after new state is flushed and linked. Recovery before that record rolls back, including death while state is absent or after state placement. Recovery after commit verifies the resulting state and affected outputs, then cleans up. An explicit abort after commit requests rollback; a durable `rolling-back` record preserves that choice. Recovery can itself be interrupted and retried.

Rollback removes a placed file only when its digest, mode and inode agree with staging evidence. It restores only a digest/mode-verified backup into an absent name, or accepts a destination already linked to that backup. An unrelated replacement with identical bytes is preserved. Changed files, corrupt backups, unknown legacy modes, changed state, symlinks and missing evidence produce `partial` or `refused`, retaining recovery evidence.

Cleanup never recursively removes trees. It removes exact planned scratch files after digest/mode checks and uses `rmdir` on recorded directories. Unknown scratch files block cleanup and remain. Uninstall removes only unchanged owned artifacts, state and empty directories with recorded provenance. User files, user directories, permission edits and content edits remain. Modified entries retain ownership so a later uninstall can reassess them.

## Reports and executable proof

Reports contain JSON-safe status, counts, mutation counters, relative residue paths, `recoveryRequired`, and fixed issue codes/messages. They omit absolute roots, owner values, hashes, bytes and raw errors. Relative artifact paths remain visible; do not put private data in artifact names.

- `installed`, `removed`, `unchanged`, `recovered`: completed within the contract above.
- `refused`: request or recovery evidence rejected.
- `rolled-back`: prior artifact/state content and recorded modes restored.
- `interrupted`: injected interruption left pending work.
- `partial`: modified ownership or unresolved recovery evidence remains.

Counters describe checked/planned artifacts and applied actions, not syscalls or a durable audit log. `recoveryRequired: false` on a partial uninstall means the transaction finalized but modified owned files remain.

Test-only `failpoints: { at, mode }` supports `abort`, `crash` and immediate `exit` (code 70). A configured point fires once per operation. Recovery interruption uses the same option. Boundaries are:

```text
after-lock             after-journal          after-plan
after-stage            after-backup-link      after-backup
after-move-link         after-place-link       after-place
before-state           after-state-unlink     after-state-write
after-state            after-recovery-decision
after-rollback-unlink   after-restore-link     before-cleanup
after-cleanup-file      after-cleanup-journal
```

Recovery-specific cleanup points run only during recovery. Placement points do not occur in uninstall. `after-backup` also fires for additions; `after-place` also fires for removals. `after-place-link` means the exclusive destination link exists while scratch evidence remains.

Run `bun test tests/install.test.ts`, then `bun run verify`. Tests include actual subprocess SIGKILL, competing installs and recoveries, active recovery with a stale original PID, repeated interrupted recovery, forged/torn evidence, exact executable permissions, direct shim execution, and content/mode preservation.

Safety assertion changes are deliberate: empty targets now retain one permanent coordination inode; snapshots exclude only that control and empty control-directory metadata, with separate exact-name/inode/mode/size and sidecar checks. Zero-write preflight tests still explicitly require an empty target. The placement label changed from rename to link. The active-lock test now uses a valid manifest so preflight rejection does not hide the exclusion check. No previous test was removed. Legacy permission preservation is additional coverage, not a relaxed deletion assertion.

## Remaining limits

- Execution evidence is from Bun 1.4.2 on macOS Apple Silicon only. Linux and Windows have not been executed here. Portable APIs do not establish platform support. Exact modes, hard links, SQLite locks and directory `fsync` must work; failures refuse or leave recoverable evidence. Network filesystems and cross-device artifact trees are outside the contract.
- Locks serialize cooperating callers. They do not stop editors or hostile writers. Targets, ancestors, control files and mount topology must remain stable. Exclusive links prevent overwrite at publication, but pathname inspection/hash checks followed by unlink are still separate calls. No hostile filesystem race guarantee is claimed.
- Owner strings and locally consistent records are not cryptographic authorship. A process that can forge all controls and linked inode evidence has the installer's filesystem authority.
- File and directory flushes are used, but power loss, hardware failure, torn scratch writes and filesystem corruption are not simulated. Torn or partial evidence is preserved for inspection. A failed cleanup may leave empty-directory residue. Process-death testing does not establish power-loss durability.
- ACLs, extended attributes, file timestamps and source permissions are not managed. Existing legacy state lacks permission provenance. There is no automatic adoption or permission repair of unrelated files.
- There is no reader snapshot, distributed lock, all-platform certification or external harness registration. Finish recovery before treating an interrupted target as usable.
