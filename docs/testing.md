# Verification and timing

Use stable Bun 1.4.2 or newer. Version 1.4.2 is the pinned CI target and
the enforced verification floor. Prerelease and malformed version strings
are rejected. Newer releases require their own evidence. Keep `private: true`;
the MIT license does not authorize an automatic package release.

From this repository:

```text
bun install --frozen-lockfile
bun run typecheck
bun test tests/verify.test.ts
bun verify
```

The verifier uses explicit argument arrays and the current Bun executable.
It runs these required gates in order: typecheck (`bun run --bun tsc --noEmit`),
tests (`bun test`), architecture, public-source scan, and content validation.
Each gate runs even when an earlier gate fails. No required gate can be disabled.
Content validation compiles all content Markdown, rejects empty or degraded
corpora, and checks every membership scenario through the schema API.

Output is newline-delimited JSON with `aos.verify/v1` start, output, gate, and
summary records. Child stdout and stderr are JSON strings, so child text cannot
forge verifier records. Both pipes are drained concurrently. The limit is 8 MiB
combined output per child; exceeding it is incomplete, never a passing truncated
transcript. Each child has a 120-second deadline; tests have 300 seconds. The
deadline covers exit and pipe draining. The runner kills its direct child on
incomplete output or timeout; it does not promise descendant process isolation.

A passing test exit also requires one valid Bun summary, matching counters,
nonzero collected tests, and at least one passing test. All-skipped/all-todo runs,
missing or ambiguous summaries, malformed UTF-8, nonzero exits, missing commands,
and expired deadlines fail. A new Bun summary format may require a parser update.

The public-source gate accepts private literals through
`AOS_CHECK_PUBLIC_PRIVATE_TOKENS` and tracker prefixes through
`AOS_CHECK_PUBLIC_TRACKER_PREFIXES`. Values are comma/newline-separated, with
optional `label=value` entries only for private tokens. Tracker prefixes are a
comma-separated list of bare prefixes such as `CURRENT,LEGACY`; they do not
include `-`, labels, or empty entries.
Supply private values through the environment;
never check them into a fixture or workflow. The runner inherits this configuration
and matches configured values case-insensitively across common path, filename,
camel-case, whitespace, underscore, dot, and dash component boundaries. Tracker
prefixes likewise match separator variants followed by a numeric identifier.
and replaces matched sensitive spans with fixed `<token>`, `<path>`, or `<email>`
placeholders while preserving surrounding diagnostics and stdout/stderr framing.
The matching rules are unchanged: configured literals, tracker references, home
prefixes, email addresses, and recognized credential patterns. Overlapping matches
merge before replacement. A detected private-key header covers the key through
its matching footer, or the remaining transcript if the footer is absent.
Redaction still fails the gate, including when the child exits zero. Gate records
include `redactions` (the number of disjoint spans in the combined transcript) and
reason `unsafe-output-redacted`, unless an incomplete-child reason takes priority.
Test counts and child exit codes are derived from the original execution, not
the redacted text. No raw-output bypass or secret-bearing match labels are emitted.
The public gate calls the existing scanner through a tree-only wrapper that reports
counts and rule IDs without printing its absolute checkout path. It deliberately
skips commit history because private pull-request jobs can run against a
provider-created merge commit whose identity is not part of the export. The
exporter scans the independent staged history, and public-repository CI runs
`bun scripts/check-public.ts --json` as a separate full tree-and-history gate.
Generic checks remain active without private configuration. This cannot establish
the absence of private data that has no configured or recognizable signature.

The helper tests use temporary fixtures and synthetic child commands. They never
launch the full verifier from inside `bun test`. Platform coverage remains unknown
until the CI matrix runs; local passing tests prove only that local environment.
CI installs the frozen lock on Linux, macOS, and Windows with Bun 1.4.2. In the
public repository it also scans commit history. It needs only read access to
repository contents and no configured secrets. Tests that assert POSIX signal
names, Unix permission bits, signal-driven crash recovery, or the verifier's
child-process control boundary are explicitly skipped on Windows; the remaining
portable lifecycle, recovery, summary parsing, content validation, and
verification tests still run. Windows process execution remains covered by the
live verifier and CI job boundary itself.
The native hook adapter emits a POSIX shim and its integration suites run on
Linux and macOS; Windows still exercises the platform-neutral protocols,
composition, policy, runtime, state, management, privacy, and export surfaces.
Windows preserves declared executable-mode intent in Git/export metadata, but
does not claim that NTFS enforces POSIX permission bits.

## Benchmarks

```text
bun run benchmark --samples 30
```

Runtime-only mode launches a new Bun process for every sample. Each process reads
and reports its stdin size. The input byte tiers are 0, 4096, 65536, and 262144.
The minimum is 20 samples per tier. Output records runtime, platform, architecture,
sample counts, input bytes, stdout/stderr bytes, and nearest-rank p50/p95 times.
Times include launch, input consumption, output drain, and process exit. OS caches
may be warm. These synthetic tiers do not measure content compilation or hooks.

Run actual local hook and orient commands separately, then measure an initialized
persistent MCP process to distinguish cold process cost from amortized RPC cost:

```text
bun run benchmark --samples 30 --label hook --command-json '["bun","src/cli.ts","hook"]' --stdin-file hook-event.json
bun run benchmark --samples 30 --label orient --command-json '["bun","src/cli.ts","orient"]'
bun run benchmark --samples 30 --label gate-rpc --mode rpc --command-json '["bun","src/edges/cli.ts","serve","--state","/tmp/aos-bench.sqlite","--content","./content","--source-revision","COMMIT"]' --stdin-file gate.json --interventions 0
```

Those argument arrays are examples; adapt them to the CLI's real contract and
use an isolated fixture configuration. Each command is spawned directly, with no
shell evaluation. A custom command runs once per sample; it is not replaced by
an in-process surrogate. Its supplied stdin is one byte tier, and its captured
output contributes byte measurements. Runtime responses also report composed
kernel/reference/framework byte tiers separately from source input bytes. Record
manual interventions explicitly (zero is meaningful). In RPC mode one server is
initialized and every sample is a complete `tools/call` round trip. Check behavior separately: exit zero alone
does not prove a correct hook or orientation result. No legacy speedup is claimed
without an equivalent legacy workload, inputs, environment, and sampling method.

## Optional local Linux image

```text
docker build -f Containerfile -t aos-test .
docker run --rm aos-test
```

Run these commands from this repository only. The image pins Bun 1.4.2, installs
Git, uses an explicit project copy list, and omits host credentials and Git
history. Its empty Git index supports scanning copied candidates but cannot test
the host repository's history. Dependency installation has its own cache layer;
package-manager lists are removed in the installation layer. Building and running
the image are separate checks; a Containerfile alone is no Linux evidence.
# Phase 3 focused and live checks

`bun test tests/phase3.test.ts` covers the immutable spine set, manifest failure
classes, byte-identical rendering, trust/collision outcomes for normal and slash
use, project-first recall, scanner positive controls, deterministic paginated
indexes, idempotent closeout, newer-writer refusal, and shared tracker grammar.
`bun run prove:skills` is an opt-in local compatibility proof described in
`docs/working-loop.md`; it is not part of `bun verify` because Codex and Hermes
are external installations.

# Phase 4 lifecycle checks

`bun test tests/drift.test.ts tests/install.test.ts tests/hooks.test.ts
tests/indexes.test.ts tests/restore.test.ts tests/doctor.test.ts` covers independent source freshness,
installed consistency, explicit output ownership, managed shared-settings
merge/update/uninstall, N to N+1 content behavior, crash recovery, retained-state
uninstall, stale index publication, and foreign-marker diagnosis. All roots are
disposable. The index race starts two create-only publishers for one name and
requires exactly one complete artifact plus one `output-exists` refusal.

The installer suite includes a POSIX stop/resume barrier: writer A pauses after
creating and journaling its run-owned backup, writer B places a newer target
inode, and A resumes. A reports partial recovery, preserves B's bytes, and keeps
the verified backup/journal instead of overwriting either. `tests/restore.test.ts`
copies only the declared source payload, performs a separate frozen offline
dependency install, renders and installs into a path containing spaces, verifies
every hash and mode, removes source/stage, exercises unavailable vault/tracker,
expired-authentication and network reasons, then uninstalls and checks the exact
operator and retained-state listing. This proves the disposable fixture on the
recorded platform; it does not prove real account authentication, remote service
availability, power-loss durability, or a live harness registration.
