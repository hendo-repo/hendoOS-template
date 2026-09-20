# Vault operation

The private `vault/` tree is the canonical durable-knowledge store. The public
template ships only `templates/vault/`; `vault/`, local bindings, backups, and
quarantine evidence are never exported.

## Everyday Git protocol

Use an explicit branch and never run synchronization concurrently with an
editor or another writer on the same checkout.

1. Inspect `git status --short --branch`. Resolve or deliberately retain every
   local change; do not auto-stash it.
2. Run `git fetch origin`, then compare with
   `git rev-list --left-right --count HEAD...origin/main`.
3. If behind or diverged, inspect the incoming diff and reconcile explicitly.
   Never auto-reset, force-push, or silently choose one side of a note conflict.
4. Run `node vault/bin/hendo-vault-audit.js` and the relevant retrieval checks.
5. Commit only selected durable changes on a branch, push normally, and use a
   reviewable pull request for shared changes.
6. After merge, verify the remote revision with `git ls-remote origin
   refs/heads/main`, then fast-forward the local checkout.

An offline commit is valid work, but it is visibly unreplicated until fetch,
reconciliation, push, and remote-revision verification succeed. A rejected or
interrupted push does not authorize retry by force.

## Backups and restore

Git is the live replicator, not the only backup. Keep a dated, independently
readable source archive through the agreed retention window. A backup is proven
only after checksum verification, extraction into a disposable root, and a
manifest comparison. A second clean Git clone must independently pass the vault
audit and retrieval checks before a cutover is accepted.

The original Drive snapshot is rollback evidence, not another live writer. Do
not point Drive synchronization and Git-backed editing at the same directory.

## Local bindings and Obsidian

Machine paths belong in ignored local bindings, never committed configuration.
Point Obsidian at the repository's `vault/` directory only after the Git and
backup restore proofs pass. Ignore workspace/session UI state while preserving
portable `.obsidian` preferences. Mobile access is a separate surface: record it
as unsupported or deferred until a concrete sync design is accepted and tested.

The official Obsidian CLI is optional operational convenience, not the vault
acceptance boundary. If a distribution-packaged Electron launcher cannot register
the CLI, use the matching standalone binary from an official Obsidian release;
keep it separate from the distribution's GUI launcher and verify its version and
vault binding before use. Never manufacture a lookalike wrapper. The repository's
native audit and search tools remain the non-GUI verification surface.

## Large files and quarantine

Choose LFS or an external retrieval path from measured inventory, not by
assumption. If ordinary Git is used, keep every file below the remote's hard
limit and record growth as a review trigger. Credentials, local authentication,
machine bindings, and harness-specific skill mirrors stay outside the candidate
and are retained only in restricted quarantine/backup evidence for review.

Read-only inventory and tree comparison:

```sh
bun src/edges/vault.ts inventory --root /absolute/vault --output /absolute/inventory.json
bun src/edges/vault.ts compare --left /absolute/source.json --right /absolute/restored.json
```

The inventory records path, size, mode, digest, links, attachments, collisions,
and credential rule identifiers. It never emits a matched credential value.
