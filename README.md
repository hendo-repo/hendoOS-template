# AOS

An experimental Bun and TypeScript implementation of a context compiler and
fail-closed policy evaluator. It is not a port of a shell/PowerShell framework:
the core is TypeScript that runs under Bun, with no FFI, no Node or Python core,
and no native bindings.

**Status: PROVISIONAL, unfinished, and unverified for live use.** Nothing here
installs itself into a real configuration directory. The native hook adapter
exists as a non-blocking shadow observer: it emits an `aos.shadow/v1`
`additionalContext` report and never a `permissionDecision`, so the observed
tool proceeds exactly as if no hook had run. Read `docs/support.md` for the
per-surface support matrix and the evidence behind every line before relying on
anything.

## What exists

| Path | Surface | State |
| --- | --- | --- |
| `src/schema/`, `src/compose/`, `src/policy/`, `src/protocols/` | Pure core: frontmatter parsing, activation, deterministic composition, policy evaluation, JSON/hash/path helpers | Implemented; no filesystem, network, clock or random input |
| `src/edges/cli.ts` | Shadow runtime CLI: `orient`, `gate`, `reference`, `receipts`, `serve` | Implemented; every outcome is `provisional: true`, `enforcement: false` |
| `src/edges/mcp.ts` | MCP stdio server over the same runtime (protocol `2025-06-18`) | Implemented |
| `src/edges/manage.ts` | Source-checkout management CLI: `render`, `install`, `uninstall`, `recover`, `drift`, `doctor` | Implemented |
| `src/effects/render.ts` | Stages a self-contained delivery; returns a strict build manifest | Implemented |
| `src/effects/install.ts` | The only installer writer: journaled install, uninstall, recovery | Implemented |
| `src/effects/drift.ts` | Read-only drift detection against an independent manifest | Implemented |
| `src/edges/working-loop.ts` | Explicit JSON edge for spine skills, durable recall/indexes, and idempotent closeout | Implemented for Codex and Hermes project roots |
| `src/edges/vault.ts` | Read-only vault inventory and exact manifest comparison | Implemented; explicit roots only |
| `src/edges/hook.ts` | Native `PreToolUse` adapter (`Edit`/`Write`, POSIX) | Implemented as a **shadow test adapter**: it reports `would-allow`/`would-deny`/`indeterminate` and emits no native permission decision |
| `src/state/store.ts` | SQLite receipt/state store | Implemented |
| `content/` | Starter corpus and membership manifest | Implemented (generation 2) |
| `scripts/` | Verification, public scan/export, benchmark, and opt-in live skill proof | Implemented |
| `public-export.manifest.json`, `scripts/export-public.ts` | Revision-bound, exact-allowlist public template export | Implemented; publication still requires reviewed GitHub changes |
| `templates/vault/` | Empty public durable-knowledge scaffold | Implemented |

The `content/` corpus is a small starter set, not a complete framework port. Only
the three accepted OS-spine skills (`session-agent`, `closeout`, `self-audit`)
are canonical; no general skill library is loaded. The hook adapter covers one
harness, one event, and two tools. No vendor version is asserted.

## Install dependencies

Bun is the only toolchain. Use stable **Bun 1.4.2 or newer**; 1.4.2 is the pinned
floor and a different version requires its own evidence.

```sh
bun install --frozen-lockfile
```

## Run the checks

```sh
bun run typecheck          # bun run --bun tsc --noEmit
bun test tests             # the maintained suite; vault evidence is data, not test input
bun test tests/manage.test.ts   # the management CLI subprocess tests
bun verify                 # typecheck + tests + architecture + public scan + content
```

`bun verify` emits newline-delimited `aos.verify/v1` JSON and exits nonzero when
any required gate is not `pass`. It runs five gates in order: typecheck, tests,
architecture, public-source scan, content validation. See `docs/testing.md` for
its limits, the public-source scanner's environment variables and the benchmark
harness.

The maintained repository is private. Public releases are generated from a named
private commit using the exact allowlist in `public-export.manifest.json`; private
history, `config/`, and `vault/` are not copied. See
`docs/publication.md` for the staging, scanning, clean-clone, and contribution
return-path contract.

Tests use temporary directories. They do not write to a real configuration
directory, a home directory, or the repository working tree.

## Run the shadow runtime

These commands compose context and evaluate the observations you supply. They
never observe a live session, and an `allow` is a shadow policy result only.

```sh
bun src/edges/cli.ts --help
bun src/edges/cli.ts orient --state /tmp/aos-demo/state.sqlite --content ./content --request ./orient.json
bun src/edges/cli.ts gate   --state /tmp/aos-demo/state.sqlite --content ./content --request ./gate.json
bun src/edges/cli.ts reference --state /tmp/aos-demo/state.sqlite --content ./content --request ./reference.json
bun src/edges/cli.ts receipts --state /tmp/aos-demo/state.sqlite --content ./content --owner demo --session demo --limit 20
```

Create `/tmp/aos-demo` first. Every path must be explicit; the CLI never reads an
ambient home or infers configuration. Each operation accepts one JSON document on
stdin instead of `--request`. `docs/runtime.md` has complete request examples and
the exit-code contract.

The MCP server rides the same runtime over stdio:

```sh
bun src/edges/cli.ts serve --state /tmp/aos-demo/state.sqlite --content ./content
```

Handshake with `initialize`, then `notifications/initialized`, then `tools/call`.
`docs/contracts.md` documents the tool schemas.

## Manage a source-checkout delivery

`src/edges/manage.ts` is a thin boundary over the existing render, install,
uninstall, recover and drift APIs. It adds no policy and performs no file
mutation itself: `render` stages bytes, `install` applies an inspected stage, and
every effect belongs to `src/effects/`.

```sh
bun src/edges/manage.ts --help
bun src/edges/manage.ts render    --request ./render.json
bun src/edges/manage.ts install   --request ./install.json
bun src/edges/manage.ts drift     --request ./drift.json
bun src/edges/manage.ts uninstall --request ./uninstall.json
bun src/edges/manage.ts doctor
```

Behaviour that matters:

- One strict JSON options object from `--request FILE` or stdin through EOF,
  at most 256 KiB, default input deadline 5000 ms (`--input-timeout-ms 1..30000`).
- stdout is exactly one JSON value, including for help and for errors;
  diagnostics go to stderr.
- Unknown commands, unknown request fields, unknown flags, relative paths and
  invalid deadlines fail closed. A refused, partial, interrupted or indeterminate
  result exits `1`. Only a completed effect, clean drift, or supplied doctor
  checks exit `0`.
- `render` and `install` are separate steps on purpose: inspect the staged
  manifest and run read-only `drift` as the diff before you install it, then run
  `drift` again to verify the applied bytes and source revision.
- There is no force flag, no ambient home discovery, and no test failpoint
  option. `recover` ignores only the stale PID diagnostic, and only with an
  explicit `assumeDead: true`.
- `uninstall` does **not** remove operational state in a separate state directory
  and it retains the stable installer coordination file. Expect residue.
- `doctor` is read-only runtime/content/config diagnostics. With an explicit
  target it also classifies legacy/Bun marker coexistence while returning
  `authorization: none`; marker presence never authorizes either system. It does
  not test a live harness, operational state, target ownership or system health,
  and it says so in its own output.

See `docs/install.md` for the installer contract, `docs/harnesses.md` for the
rendered layout and the render/install pair.

## Trial the hook adapter in a disposable home

The adapter is a non-blocking shadow observer. It emits an `aos.shadow/v1`
`additionalContext` report (`would-allow` / `would-deny` / `indeterminate`) and
no `permissionDecision`, so it cannot change the host's decision. It is a test
adapter, not enforcement, and this trial deliberately points at a throwaway
directory rather than your real configuration.

```sh
bun test tests/hooks.test.ts
bun test tests/hooks.shadow.test.ts
bun test tests/restore.test.ts
```

Those suites render the adapter into a temporary tree, install it there, and
execute the exact shim command the generated registration names. They do not
launch the vendor application and do not touch a live settings file.

**Do not register this adapter in a live configuration directory.** Live host
registration, trust prompts and vendor version compatibility are unverified, and
no code path emits native `allow`. If you want to try the rendered artifacts by
hand, render into temporary roots first, inspect the staged `settings.json`,
install into another temporary root, and point `CLAUDE_CONFIG_DIR` at a
disposable directory only after you have read `docs/harnesses.md` in full.

## Limitations

- **No live enforcement.** The runtime is a shadow evaluator; the hook adapter
  is a shadow observer that emits no permission decision and no blocking exit.
  Neither authorizes a real action.
- **No parity claim.** The starter corpus, one harness adapter and one event are
  not a complete framework port, and no release or performance claim is made.
- **Platform evidence is local only.** The matrix and exact command scope that
  were reproduced are recorded in `docs/support.md`. Nothing else is claimed.
- **No FFI and no Node or Python core.** The core is TypeScript under Bun using
  built-in `bun:sqlite` and Bun's Node-compatible filesystem APIs.
- **Uninstall is not a clean sweep.** Operational state and the coordination
  file remain; see the residual gap in `docs/support.md`.

## Repository layout

```text
content/    starter corpus and membership manifest
config/     private portable operator data (never publicly exported)
docs/       contracts, install, drift, harnesses, runtime, testing, support
scripts/    verification gates, public-source scan, architecture check, benchmark
skills/     exactly three reviewed OS-spine skills plus pinned provenance
src/        core (schema, compose, policy, protocols), effects, edges, state
templates/  clean public examples and empty vault scaffold
tests/      Bun test suites
vault/      canonical private durable knowledge (never publicly exported)
```

Licensing and third-party attribution: see `LICENSE` and `NOTICE`.
