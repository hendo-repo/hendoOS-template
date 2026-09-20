# Disposable native hook delivery

Status: **PROVISIONAL; candidate for independent review.** The adapter runs the shared `RuntimeService` and records real local receipts from synthetic observations. It never grants live authorization. No agent session, account action, or live installation was used to test it.

## Official contract and scope

Research date: **2026-09-19**. Official rolling documentation, not a pinned vendor release:

- [Hook reference](https://code.claude.com/docs/en/hooks): registration, command input/output, and process status.
- [Command fields](https://code.claude.com/docs/en/hooks#command-hook-fields): `command` with `args` uses direct execution. The generated registration uses an absolute shim path, `args: []`, and a 35-second timeout.
- [Common input](https://code.claude.com/docs/en/hooks#common-input-fields) and [PreToolUse](https://code.claude.com/docs/en/hooks#pretooluse): JSON on stdin includes session, event, working directory, transcript path, tool name/input, and tool-use ID.
- [Decision control](https://code.claude.com/docs/en/hooks#pretooluse-decision-control): decisions belong in `hookSpecificOutput`, with `hookEventName`, `permissionDecision`, and `permissionDecisionReason`. `additionalContext` carries context.
- [Exit status](https://code.claude.com/docs/en/hooks#exit-code-output): successful structured output uses exit 0; exit 2 blocks this event. Other exit codes alone do not block.
- [Settings location](https://code.claude.com/docs/en/settings): `settings.json` belongs in the configuration directory; `CLAUDE_CONFIG_DIR` can select a disposable directory.

Only **Claude Code `PreToolUse`, matching `Edit|Write`, on POSIX** is implemented. No universal adapter or minimum vendor version is asserted. Exec-form registration must match the documented contract above. Native input has no AOS version field; the explicit adapter config supplies AOS version/schema/composer 1 and expected content generation. Adapter identifier `claude-code-pre-tool-use/1` is our schema identifier, not a vendor version.

## Boundary and behavior

`src/protocols/harness.ts` owns native field names, registration, and response encoding. `src/edges/hook.ts` loads explicit configuration and calls the same service/state/content APIs as CLI and MCP. `src/effects/render.ts` stages generic files and returns installer input. Core, runtime, and installer semantics are unchanged.

The event maps to the generic `pre-edit-kernel-plus-declared-reference` gate scenario. A subject digest binds the parsed event context. Session and tool-use IDs become runtime session and request IDs; the subject digest also supplies the nonce. Repeated input replays the receipt; changed context under the same request ID refuses. The transcript path and working directory are data only: the hook never reads them, runs tool input, or scans marker files.

Unknown native metadata is ignored. It cannot supply observations, owner policy, state paths, or operation fields. `syntheticObservations` comes only from the explicit config, defaults to empty, and is always labeled `kind: synthetic`. Optional `ownerPolicy` uses the existing strict owner schema; its revisions must match the operation configuration. A false verification value under the default allow-only policy is indeterminate, not an explicit deny.

| Shared runtime result | Native response | Process exit |
| --- | --- | --- |
| Complete synthetic allow | No decision; PROVISIONAL `would-allow` in `additionalContext` | 0 |
| Complete synthetic deny | No decision; PROVISIONAL `would-deny` in `additionalContext` | 0 |
| Incomplete/refused, malformed input, unavailable assets | No decision; `indeterminate` in `additionalContext` plus an stderr diagnostic | 1 |

The adapter is **shadow-only**: `hookReply()` encodes `hookSpecificOutput` with
`hookEventName` and `additionalContext` and nothing else. No `permissionDecision`
or `permissionDecisionReason` is emitted by any path — not for a shadow allow, not
for a shadow deny, and not for a failure — so the host applies its own permission
flow exactly as if no hook had run. Exit `0` means the shadow evaluation
completed; exit `1` means it did not, matching the generic runtime CLI's failure
convention. The vendor's blocking exit `2` is never produced. `additionalContext`
contains the `aos.shadow/v1` JSON report: composed text, receipt hashes, request
ID, byte tiers, shadow verdict, and the constant
`provisional: true` / `enforcement: false` / `nonDisruptive: true` labels. This is
traceable diagnostic context, not a credential and not a decision.

Input is one UTF-8 JSON document ending at EOF, at most 256 KiB. A final newline is optional. Multiple documents, invalid UTF-8, truncated JSON, and unsupported events/tools are refused as `indeterminate` diagnostics, never as a permit. Output is one JSON object plus newline, limited to 16 KiB; oversized context raises instead of truncating the report, and the caller degrades that to the same non-blocking incomplete exit `1`. Diagnostics use stderr. Configuration and content use existing bounded readers. The explicit 1–30,000 ms deadline covers input and operation preparation after config load. Core execution remains synchronous and cooperatively checked; this is not hard real-time preemption.

## Stage and install

Call `renderHarness(options)` under Bun 1.4.2 with these explicit options:

```ts
import { renderHarness } from './src/effects/render';
import { install, uninstall } from './src/effects/install';
import { HARNESS_PROTOCOL } from './src/protocols/harness';

// Supply absolute paths yourself. Create these disjoint directories first.
// statePath names a database in a separate existing state directory.
const rendered = await renderHarness({
  sourceRoot, stageRoot, targetRoot, statePath, bunPath,
  owner: 'demo-owner', generation: 1,
  config: {
    version: 1, protocol: HARNESS_PROTOCOL, schemaVersion: 1, composeVersion: 1,
    contentGeneration: 3, configRevision: 'aos-runtime-default/1',
    checkerRevision: 'aos-policy/1', sourceRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', timeoutMs: 5000,
    syntheticObservations: [{ key: 'verification', availability: 'available', freshness: 'fresh',
      completeness: 'complete', result: 'present', reasons: [], value: true }],
  },
});
const report = await install({
  sourceRoot: rendered.sourceRoot, stageRoot: rendered.stageRoot,
  targetRoot: rendered.targetRoot, owner: rendered.owner,
  manifest: rendered.manifest, modes: rendered.modes,
});
// Inspect report.status before invoking rendered.shimPath with synthetic JSON.
// Later: await uninstall({ targetRoot, owner: 'demo-owner' });
```

No ambient home or configuration is selected. The source must contain `src`, `content`, `package.json`, `bun.lock`, `LICENSE`, `NOTICE`, and installed `node_modules/zod`. Bun bundles the hook and dependency code; content and licenses are copied into staged assets. Source digests include source, content, the installed schema dependency, and legal files. Inputs are rechecked after building. Installer output digests cover every staged byte. The manifest uses schema version 1; modes explicitly request `0755` for the shim and `0600` for other files. The stage must start empty.

Source, stage, target, and the state directory must be disjoint real directories without symlink components. State files/sidecars reject links. The caller's absolute Bun path is resolved, checked executable, and probed under empty `PATH`; its reported version must equal the rendering process's Bun version. The shim quotes every path and uses only shell builtins before `exec` of resolved Bun. The installed module-load boundary catches a missing or invalid bundle. It does not require the source checkout, stage, dependency tree, shell startup files, or PATH after installation.

The renderer treats `settings.json` as a shared operator document. It reads one
bounded, unaliased JSON object, preserves unknown keys and unrelated hook groups,
and stages a document containing exactly one AOS `PreToolUse` array item. The
manifest binds the complete pre-merge byte digest, the JSON array path, and the
canonical digest of that item. Rendering does not mutate the target.

The installer adopts that shared document only when its bytes still match the
rendered base. Later generations may fold in unrelated operator edits only while
the previously owned AOS item remains exact and unambiguous. An edited, missing,
or duplicated AOS item is a visible conflict. Uninstall removes that exact item
while retaining unrelated hooks and settings, including later edits. If AOS
created an otherwise empty document, uninstall removes it; otherwise it leaves a
normalized operator JSON document. Every other newly rendered output declares
`framework-file` ownership. Legacy manifests without an explicit class remain
readable as whole-file ownership.

The review loop is repeatable: render into an empty disposable stage (plan), run
read-only drift against the manifest (diff), inspect the manifest/classes/modes,
install (apply), then run drift again (verify). Source freshness and installed
hash consistency are separate drift axes. Uninstall leaves operational runtime
state in the separate state directory and the stable installer coordination
inode described in [the installer contract](install.md).

## Verification and candidate limitations

```sh
bun test tests/hooks.test.ts
bun run --bun tsc --noEmit
```

Tests use real subprocesses and disposable homes. They check native mapping, synthetic allow/deny, direct-service receipt replay equality, exact composition byte counts, invalid versions/generation, malformed framing, input deadlines, missing runtime assets, registration ownership, path separation, empty PATH with metacharacters, bundled-source independence, edited-settings preservation, and install/uninstall.

Remaining limits:

- Live host registration/loading, trust prompts, permission handling, and vendor version compatibility are unverified. Tests directly execute the exact command/args from generated settings; they do not launch the vendor application.
- The [host timeout contract](https://code.claude.com/docs/en/hooks#timeouts) can discard a command hook's output. Because the adapter emits no permission decision, a missing shim, unusable Bun binary, corrupted startup boundary, OS kill, or host cancellation can only suppress a diagnostic report — it cannot turn the adapter into a gate, and it cannot change the host's decision. No command hook can promise a live fail-closed gate under those conditions. This adapter is deliberately not certified for live enforcement.
- If the shim itself runs but its copied bundle, launcher, config, or Bun binary is unavailable, its startup boundary prints a no-decision `indeterminate` report, writes a diagnostic to stderr, and exits `1`. The launcher also catches bundle-load failure. A missing or unlaunchable shim cannot emit this fallback. These tests exercise subprocess output; live host handling remains unverified.
- Only edit/write events are registered. There is no shell-tool coverage, session-start adapter, reference tool, Windows shim, retention policy, or signed evidence collector.
- Bundling and filesystem checks assume a quiescent caller-controlled source/stage. They are not a build sandbox or protection against hostile concurrent directory replacement. The selected executable remains an external runtime dependency.
- Runtime output above the adapter ceiling is refused even if a receipt already records a complete shadow computation. That receipt still cannot authorize a live action.

Live evidence collection remains separate work, not hidden adapter behavior.
Parent verification and independent adapter review are still required.
