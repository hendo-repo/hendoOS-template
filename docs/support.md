# Support

What this repository supports, what it does not, and the evidence behind each
line. Read `docs/baseline.md` for the pinned-upstream inventory this matrix
refers to, and `README.md` for how to install and run what exists.

**Read this first:** AOS is an **experimental, provisional implementation**. It
has a pure TypeScript core, a shadow runtime CLI, an MCP stdio surface, a
source-checkout management CLI, a staged installer, a read-only drift check, a
durable working-loop edge, three canonical spine skills, a shadow-only Claude
adapter, and a separately opt-in Codex 0.155.1 path-policy adapter. The Codex
adapter has bounded live exec/child proof; it is not a security sandbox and does
not establish other surfaces. Several
matrix rows below are still "not implemented" or "not ported"; those describe
work not done, not defects.

## 1. Support levels

| Level | Meaning |
| --- | --- |
| **Verified** | Reproduced by a gate whose command, artifact state, and outcome are named. |
| **Provisional** | Exercised once, evidence exists, not yet reproduced by a standing gate. |
| **UNVERIFIED** | Claimed or expected, never exercised. Must not be presented as working. |
| **Not supported** | Out of scope, or known broken. |
| **Not implemented** | Planned; no artifact exists in this repository. |

## 2. Platform matrix

The runtime is TypeScript under **Bun 1.4.2** using only Bun built-ins and
Bun's Node-compatible filesystem APIs. There is no FFI, and no Node or Python
core, so platform behavior is Bun's plus the operating system's.

| Platform | Status | Basis | Notes |
| --- | --- | --- | --- |
| macOS ARM64 (Apple Silicon) | **Provisional** | Locally reproduced with the commands named in §5 on this checkout | This is the only platform with real execution evidence. See §5 for the exact scope; it does not extend to live harness behavior or power-loss durability. |
| Linux ARM64 | **Provisional** | A prior candidate revision reached a passing suite before the hook adapter existed | That evidence predates the hook and management lanes, so it does not cover the current tree. Re-run the §5 commands on Linux ARM64 before treating any row as covered there. |
| Linux x86_64 | **Provisional** | Phase 4 lifecycle tests and `bun verify` run locally on the exact candidate named in its receipt | Includes disposable restore and POSIX stop/resume race proof; live harness behavior and power loss remain outside scope. |
| Windows (native, no bash) | **UNVERIFIED** | No gate has been run | The renderer refuses `win32` outright because the generated shim needs POSIX `sh`. Native Windows execution is a *target*, not a claim. |
| WSL / Git Bash on Windows | **UNVERIFIED** | No gate has been run | Not a target platform; not assessed. |

### Why no platform row is "Verified"

A row reaches **Verified** when §5 names a literal command, names the artifact
state it ran on, and the outcome has been reproduced by a standing gate rather
than a single local run. macOS ARM64 is closest, but its evidence is one local
reproduction on one machine, which is **Provisional** by definition above.

Fixed test counts are deliberately absent from this document. Bun tests are
added continuously, so a pinned number is stale almost immediately. §5 names the
commands and the proof scope instead, and any count quoted elsewhere must be
read as scoped to the run that produced it. As a recent local data point only,
`bun test tests` on this checkout collected and passed every maintained test across the suite,
including the hook and management subprocess tests.

## 3. Capability matrix (pinned upstream contracts vs AOS)

| Surface | Upstream at pin | AOS today |
| --- | --- | --- |
| Content compiler (`install`) | Real, bash + PowerShell twins, deterministic manifests | **Implemented, differently scoped.** AOS renders a self-contained delivery and installs it through a journaled staged installer. It does not reproduce upstream's shell/pwsh twin layout. |
| Drift gate (`check-drift`) | Real, manifest + auto modes, soft-drift cure envelope | **Implemented, read-only.** `src/effects/drift.ts` separately reports source freshness (including source revision) and output consistency against an independent nonempty manifest. Named missing/unreadable roots stay indeterminate. There are no auto-cure modes. |
| Validator (`validate`) | Real, bash + PowerShell twins | **Partially implemented.** Content and membership validation run inside `bun verify`'s content gate; there is no standalone `validate` surface. |
| Cleanliness gate (`check-clean`) | Real, PII/tracker/commit-message coverage | **Implemented, narrower.** `scripts/check-public.ts` scans publish candidates, configured private literals, tracker prefixes, home paths, emails and credential patterns, and covers Git history state. Commit-message coverage and upstream's exact rule set are not reproduced. |
| Advisory audits (`self-audit`, memory/state/linear checks) | Real | **Partially implemented.** The canonical `self-audit` skill and read-only knowledge/skill audits exist; broad machine and account audits do not. |
| Orientation producer (`orient`, `orient/v1`) | Real | **Implemented as a shadow operation.** `bun src/edges/cli.ts orient` composes deterministic context from explicit input; it does not produce upstream's directive format. |
| Closeout pre-write gate (`closeout-gate`) | Real, fail-closed wrapper | **Implemented differently.** An idempotent explicit closeout transaction checks tracker readback evidence and a project-note digest, writes a session note, and republishes audited indexes. It is not a live harness stop hook. |
| Capability specs + realizations (3 native × 4 harnesses) | Real, compiler input | **Three accepted spine packages only.** Codex and Hermes receive byte-identical generated project packages; no general skill inventory is imported. |
| `core/` rules, playbooks, verification recipes | Real, normative prose | **Partially ported.** A starter corpus ships in `content/` (generation 2). It is a small seed set, not upstream's corpus, and it is described as such. |
| Vault scaffolding (109 files, including 3 Node tools) | Real | **Not bulk-ported.** A strict durable-note schema, explicit recall, deterministic paginated indexes, and closeout effects are implemented without importing the old scaffold. |
| Tracker / vault layer contracts | Documented as contracts, never auto-installed | **Partially implemented.** Shared tracker-prefix parsing, note authority/audience fields, recall states, and closeout receipts exist. Linear transport remains an external adapter responsibility. |
| Acceptance suite (75 stems, 145 files, bash↔pwsh parity-aware) | Real | **Not implemented** |
| Harness adapters (claude / codex / hermes / cursor) | Real, version-pinned "verified against" lines | **Two bounded adapters.** Claude `Edit`/`Write` remains shadow-only. Codex 0.155.1 `apply_patch` has receipt-producing shadow mode and explicit opt-in deny-only path policy. Hermes/Cursor have no hook adapter. See `docs/phase6.md`. |
| Bun + TypeScript runtime for any of the above | **Absent upstream** — 0 `.ts` files, no `package.json` | **Implemented for the scope above.** |

The last row remains the reason AOS exists: upstream is a shell/PowerShell/Markdown
system, and AOS implements its contracts in TypeScript under Bun. That is a new
implementation against upstream contracts, not a port of upstream code, and it is
not a parity claim.

## 4. Harness support

AOS ships one partial shadow-only Claude adapter and one bounded opt-in Codex
adapter. The exact per-version/per-surface claims live in
`config/harness-surfaces.json`.

| Harness | Upstream status at pin | AOS status | Enforcement caveats that will carry over |
| --- | --- | --- | --- |
| Claude Code | Supported (v2.1.207 baseline) | **Test adapter only** — `Claude Code PreToolUse`, matching `Edit\|Write`, POSIX. It reports `would-allow` / `would-deny` / `indeterminate` in `additionalContext`; it emits **no `permissionDecision`** and never uses the blocking exit `2`. No code path emits native `allow` either. | Native edit tools only; desktop/SDK variants do not persist assistant text, so the gate marker file is the primary declaration channel there. Live registration, trust prompts and vendor version compatibility are **UNVERIFIED**. |
| Codex CLI | Supported only for the recorded 0.155.1 exec/child slice | Project skills plus an owned `PreToolUse` adapter. A disposable live corpus verifies actual artifacts and fired receipts; opt-in enforcement denies only proven `apply_patch` path violations and never emits allow. | TUI/desktop/cloud, shell policy parsing, normal `/hooks` consent, and non-Linux live behavior remain unproven. |
| Hermes Agent | Supported (v0.18.2 baseline; v0.21.3 inspected; v0.16.0 desktop measured) | **Project-skill adapter provisional.** Hermes 0.21.3 excluded the disposable untrusted repo, then normal discovery and slash expansion selected the exact generated files after temporary trust. No model turn or permanent install occurred. | Hook wiring, GUI bridge behavior, and live enforcement remain unproven. |
| Cursor | Supported (v3.16.17) | **Not implemented** | Parity is per surface: headless CLI and desktop IDE proven; interactive CLI unproven; **Cloud Agents never fire lifecycle hooks**, so the gate degrades to soft enforcement there. |

Two things this table is deliberately not claiming: that AOS will reach parity,
and that any harness's behavior is uniform across its surfaces. Both upstream
adapters and the pin's own CI comments are explicit that a claim is limited to
its named version, surface, and trust configuration.

**The Claude adapter is not enforcement.** It emits no permission decision at all. A
hook is a safety net at best, never a security boundary: upstream says so in its
own hook headers. A missing shim, an unusable Bun binary, an OS kill or a host
cancellation can suppress the shadow report entirely, and the host's own timeout
contract can discard a command hook's output. Do not register this adapter in a
live configuration directory.

## 5. Verification gates

| Gate | What it proves | Can it be run? |
| --- | --- | --- |
| `bun run typecheck` | Strict TypeScript acceptance over `src`, `tests`, `scripts` | **Yes** |
| `bun test tests` | The maintained suite in temporary directories: core boundaries, composition, policy, runtime, MCP, hooks and management CLI subprocess tests; raw vault evidence is excluded from discovery | **Yes** |
| `bun verify` | The five required gates in order: typecheck, tests, architecture, public-source scan, content validation | **Yes** |
| `bun run verify --content` / `--public` | Content and membership validity alone; public-source scan alone | **Yes** |
| `bun test tests/manage.test.ts` | Management CLI contract: help, render, install, drift, uninstall, recover, doctor, and invalid-input refusal, all through real subprocesses in temporary roots | **Yes** |
| `bun test tests/install.test.ts tests/hooks.test.ts tests/restore.test.ts tests/doctor.test.ts` | Ownership classes, shared-settings merge/update/uninstall, crash recovery, explicit stop/resume stale-writer barrier, foreign-marker diagnosis, and clean disposable restore/degraded operation | **Yes** |
| `bun test tests/hooks.test.ts` | Hook adapter mapping, shadow `would-allow`/`would-deny`/`indeterminate` reports, the generated wrapper's startup-failure path, and direct execution of the exact rendered shim command | **Yes** |
| `bun test tests/hooks.shadow.test.ts` | The `aos.shadow/v1` response contract: no `permissionDecision` in any reply, exit 0 complete / 1 incomplete, never exit 2 | **Yes** |
| `bun test tests/phase3.test.ts` | Exact spine set, discovery failures, cross-harness lesson recall, durable-note scanning, deterministic indexes, closeout replay, and tracker grammar | **Yes** |
| `bun run prove:skills` with four explicit harness paths | Disposable Codex discovery/resume and Hermes trust/slash source selection, without a model turn | **Optional local proof** |
| LICENSE provenance check | `LICENSE` byte-identical to the pinned upstream `LICENSE` (sha256 `b7023978…f78466`, 1080 bytes) | **Yes** — a `git show` + hash comparison |
| Upstream's suite (`make verify`, `tests/run.sh`) | Upstream's own tree | **No** — it is not this repository's suite, and running it here would prove nothing about AOS |
| `bun test tests/repairs.test.ts tests/phase6.test.ts` | Migrated recall, trust propagation, recoverable closeout, stale-writer/index refusal, skill ownership, Codex adapter, and handoff boundaries | **Yes** |
| `bun scripts/prove-phase6.ts ...` | One exact-revision disposable Codex 0.155.1 exec/child model corpus and fired-hook receipts | **Optional private live proof; explicit paths/auth required** |
| Platform gate | Native Windows / macOS / Linux execution parity | **No gate exists.** Evidence is a single local macOS ARM64 reproduction. |

**Rule for advancing any row above:** a gate is named by its literal command, the
artifact state it ran on is named (commit or digest) with the verdict, and the
outcome is reproduced. A claim without those three parts stays UNVERIFIED,
regardless of how it was produced.

**What the passing portable gates do not prove:** live behavior beyond the named
Codex evidence packet, power-loss survival, another harness/version/surface, a
second platform, or authorization for an action outside the configured test.

## 6. Known limitations and non-guarantees

Stated plainly so they do not have to be rediscovered:

- **No post-verify enforcement and no closeout enforcement exist upstream.**
  Upstream removed the closeout `Stop` hook deliberately and has no hook that
  checks a verification gate ran. AOS implements neither.
- **The Claude hook adapter emits no native permission decision.** A completed
  synthetic allow is reported as `would-allow` and a completed synthetic deny as
  `would-deny`, both inside a `provisional` / `enforcement: false` /
  `nonDisruptive: true` `aos.shadow/v1` report; an incomplete run reports
  `indeterminate` with a non-empty stderr diagnostic. Exit is `0` when the shadow
  run completed and `1` when it did not — never the vendor's blocking exit `2`.
  This is diagnostic traceability, not authorization, and it makes the adapter
  unable to allow or deny a live tool call by design.
- **Hook enforcement is a safety net, not a security boundary.** Upstream says
  so in its own hook headers: a pasted capability heading can open the ran-check,
  and the discipline net has a documented kill switch.
- **Enforcement is absent or unsupported on most surfaces.** Only the named
  Codex 0.155.1 exec/child `apply_patch` slice has opt-in deny proof. Cursor cloud
  history was not relabeled as a current claim.
- **The orient directive is fire-and-forget text.** Nothing locks a run into
  orienting.
- **Uninstall does not remove operational state, and this is a visible residual
  gap.** Operational state lives in a separate caller-supplied state directory
  (`state.sqlite` and sidecars) and is **not** removed by `uninstall`. The
  installer additionally retains a stable coordination file inside the target
  so that cooperating processes cannot lock different inodes. Do **not** claim
  zero global residue: a completed uninstall leaves that coordination file, and
  separately supplied state remains wherever the caller put it.
- **A clean git tree is a claim about tracked content only.** It does not cover
  gitignored harness homes, user-owned config, or operator state.
- **Two upstream snapshot-builder scripts are referenced by upstream's own parity
  test but do not exist at the pin.** Upstream's test presence-guards the block
  and reports a named skip; do not read the reference as evidence they ship.
- **Upstream harness baselines are version-scoped and dated.** A newer harness
  version is unverified until a human re-runs and re-pins the baseline.
- **Operator tools are advisory and operator-local by design.** Upstream neither
  vendors nor endorses them, and AOS inherits that posture.
- **Nothing here is an upgrade promise.** The pin is frozen (see `baseline.md`
  §8); a moving pin requires a reviewed rebase, and no upgrade path exists yet.
- **The multi-file install is not atomic.** It is a journaled sequence of
  exclusive single-file links. A crash leaves a journal, not a silent
  half-install, and recovery must run before the target is usable again.

## 7. Reporting and provenance

- Upstream project: https://github.com/QuestionPilot/agentic-os-template
- Pinned commit: `d0fb34feb4ddb2baaa7c0435a77649e7fdccd311`
- License and third-party attribution: see `LICENSE` and `NOTICE`.
- Authored for AOS: `README.md`, this document, the baseline inventory,
  `CLAUDE.md`/`AGENTS.md`, the `docs/` set, the `src/`, `tests/`, `scripts/` and
  `content/` trees shown in `README.md`, `LICENSE` and `NOTICE`.

**How to read a status claim in this repository:** if a line says Verified, it
names a command and an artifact state. If it does not, treat the line as
UNVERIFIED no matter what wording surrounds it.
