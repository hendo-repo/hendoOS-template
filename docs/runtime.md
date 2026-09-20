# Shared shadow runtime

Status: **PROVISIONAL**. This runtime can compose context and evaluate explicit synthetic observations. It cannot enforce a live harness gate or verify a live subject. Every outcome reports `provisional: true` and `enforcement: false`. An `allow` is only a shadow policy result.

Run from the source checkout with Bun. Dependencies must already be installed.

```sh
bun src/edges/cli.ts --help
bun src/edges/cli.ts orient --state /tmp/aos.sqlite --content ./content --source-revision "$REV" --request ./orient.json
bun src/edges/cli.ts gate --state /tmp/aos.sqlite --content ./content --source-revision "$REV" --request ./gate.json
bun src/edges/cli.ts closeout --state /tmp/aos.sqlite --content ./content --source-revision "$REV" --request ./closeout.json
bun src/edges/cli.ts reference --state /tmp/aos.sqlite --content ./content --source-revision "$REV" --request ./reference.json
bun src/edges/cli.ts receipts --state /tmp/aos.sqlite --content ./content --source-revision "$REV" --owner demo --session demo --limit 20
bun src/edges/cli.ts serve --state /tmp/aos.sqlite --content ./content --source-revision "$REV"
```

Create the state file's parent directory first. Each operation accepts one JSON document on stdin instead of `--request`. No paths, owner IDs, sessions, live homes, or harness settings are inferred. No tracker calls, legacy markers, subprocesses, daemon, or remote service are used.

A complete `gate.json` example for the shipped generation:

```json
{
  "version": 1,
  "schemaVersion": 1,
  "composeVersion": 1,
  "contentGeneration": 3,
  "requestId": "demo-gate-1",
  "sessionId": "demo",
  "ownerId": "demo",
  "nonce": "demo-nonce-1",
  "command": "gate",
  "scenarioId": "pre-edit-kernel-plus-declared-reference",
  "subjectDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "configRevision": "aos-runtime-default/1",
  "checkerRevision": "aos-policy/1",
  "sourceRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "timeoutMs": 5000,
  "observations": [{
    "key": "verification",
    "availability": "available",
    "freshness": "fresh",
    "completeness": "complete",
    "result": "present",
    "reasons": [],
    "value": true,
    "provenance": {
      "kind": "synthetic",
      "source": "explicit-demo",
      "subjectDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "configRevision": "aos-runtime-default/1",
      "checkerRevision": "aos-policy/1",
      "sourceRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  }]
}
```

This digest is a synthetic example, not proof of a real artifact. For orient, change `command` to `orient`, use `scenarioId: session-start-default`, and use a new request ID and nonce. For reference, change `command` to `reference`, retain the pre-edit scenario, add `referenceId: verification-recipes`, and use a new request ID and nonce. Unknown fields and unknown reference IDs fail validation. A reference must be declared by the chosen scenario's activated kernel content.

`RuntimeService.execute` calls the existing `compose(event, state, index)` and `evaluatePolicy(event, facts, rules, context)` functions. It returns their outcomes under `core.composition` and `core.policy` without rewriting them. The runtime status and receipt gate verdict determine whether the complete operation succeeded. A partial core result must never be treated as an authorization. Process exit status reports execution failure, not the policy decision: a complete deny and a complete allow both exit 0; invalid, refused, unavailable, cancelled, and incomplete operations exit 1.

## Content and configuration

`--content` selects a starter root containing `membership.manifest.json`, `kernel/*.md`, and `reference/*.md`. The loader does not search outside these directories. It refuses symlinks, subdirectories, unexpected files, invalid content, and missing expected members. Generation comes from the membership manifest. The manifest supplies both expected activated IDs and expected kernel IDs. Expectations are never derived from the loaded content. Its negative scenarios must remain empty; invoking such a scenario is still incomplete, never a successful empty result.

The loader validates reference sources when opening its snapshot. Reference prose enters a composed payload only when explicitly requested. MCP resources expose the same reference bodies on demand by exact registered URI. A server holds one immutable content snapshot until restart. `--source-revision` and every operation/provenance record name one exact 40-hex Git commit; the handshake and persisted session pin bind it. On restart, a changed source revision or content snapshot is rejected even when the generation number was not bumped.

The built-in owner policy allows only an explicit fresh `verification: true` observation. Use `--config owner.json` to supply a strict plaintext owner configuration:

```json
{
  "version": 1,
  "revision": "owner-policy/1",
  "checkerRevision": "aos-policy/1",
  "totalByteBudget": 65536,
  "gateFailure": "closed",
  "rules": [{
    "id": "explicit-verification",
    "decision": "allow",
    "requires": ["verification"],
    "when": { "observation": "verification", "equals": true }
  }]
}
```

Update operation and provenance revisions to match. Project configuration is optional operation data: `projectConfig: {"totalByteBudget": 32768}`. It can only lower the owner's byte ceiling. Project policy rules, checker revisions, or gate failure behavior are rejected, including otherwise type-valid owner values. Configuration remains plaintext; SQLite holds only operational pins, outcomes, and receipts.

An owner configuration may only use rule conditions this shared runtime can actually supply. `RuntimeService` supplies one event — the chosen scenario's event id with the literal `default` harness — and the operation's explicit synthetic observations. It supplies no content-id scope, no `intent`, and no fact paths. Owner rules that depend on `contentIds`, `when.intent`, or `when.pathPrefix` are therefore refused at the owner configuration boundary with a fixed diagnostic, because such a rule can never match and would silently drop a deny rather than fail closed. The pure policy API keeps the full condition set for callers that do supply those facts. Supported owner conditions are `event`, `harness`, `observation`, `equals`, `truthy`, and `requires`.

`projectConfig` is per-operation data, but it participates in the session pin. A session therefore keeps one stable owner and project configuration for its lifetime: a later request that varies `projectConfig` refuses with a session config skew instead of re-deciding. Supply the intended project budget with the session's first request.

Observations keep four independent axes: `availability` (`available` or `unavailable`), `freshness` (`fresh`, `stale`, or `unknown`), `completeness` (`complete`, `partial`, or `unknown`), and `result` (`present`, `empty`, `no-work`, or `unknown`). Only an available, fresh, complete, present observation can supply fresh policy evidence. Empty, no-work, partial, stale and unavailable remain distinguishable in results and receipt traces. An empty observation list is incomplete. Provenance binds the exact subject digest, configuration/checker revisions, and source revision. Mismatched evidence becomes partial and can never authorize. Synthetic observations remain shadow-only because every outcome is provisional with enforcement disabled.

## State and receipts

SQLite uses WAL and immediate transactions. Sessions are namespaced by owner and session ID. Request IDs are unique within that namespace. The stored digest covers the exact JSON value, canonicalized for object key order, before defaults are applied. Duplicate requests replay the previous outcome and receipt exactly. A cancelled or expired replay returns incomplete without delivering a stored allow; it writes no new receipt and leaves the original record intact. Reusing the ID with a changed subject, nonce, or any other payload refuses. A session pins generation, content digest, configuration revision and digest, checker revision, and source revision. Pin checks precede replay. Changing owner rules without changing their revision still causes a pin conflict.

An outcome and its receipt commit together. Failed receipt creation rolls back both, including any new session pin. Receipts bind request digest, nonce, subject, source/config/checker revisions, generation, content digest, payload hash, schema/composer versions, byte totals by tier, gate verdict, and adapter timestamp. Their bounded explain trace contains only IDs, status axes, error codes and rule decisions—never transcript text, raw observation values or composed prose. `ClockAdapter` supplies an explicit timestamp and monotonic clock; the default adapter uses ISO UTC time and `performance.now()`. Tests can inject a fixed timestamp. Receipts are audit records, not signed credentials or authority for a later subject.

`receipts` lists up to 100 records for one explicit owner/session namespace, newest first. Receipt JSON is capped at 16 KiB. Storage retains at most 100 outcomes per namespace and evicts the oldest completed record before unresolved evidence; unresolved records are still subject to the hard cap. The state file is local operational data, not a knowledge store or authorization service.

## MCP stdio

`serve` implements newline-delimited JSON-RPC 2.0 using MCP protocol `2025-06-18`. It reserves stdout for JSON. Send one complete JSON object per line, including a final newline. Send `initialize`, then the `notifications/initialized` notification before tools or resources:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"demo","version":"1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"resources/list"}
{"jsonrpc":"2.0","id":4,"method":"resources/read","params":{"uri":"aos://reference/verification-recipes"}}
```

The server advertises its AOS schema, composer version, content generation/digest, and source revision under `capabilities.experimental.aos`. A client may send `capabilities.experimental.aos` containing `version`, `schemaVersion`, `composeVersion`, `contentGeneration`, and `sourceRevision` to require an exact handshake. Each tool operation independently requires these exact values. Unsupported or stale values refuse.

`tools/call` takes `params: {"name":"gate","arguments": <the full operation above>}`. The command in the envelope must match the tool name. Tool results contain both the complete JSON outcome as text and the same value in `structuredContent`. CLI and RPC use the same service and state format. Notifications produce no replies. Unknown methods, malformed JSON, invalid requests, invalid parameters, and internal errors use JSON-RPC error codes. RPC execution errors set the process's final exit status to 1; policy denies do not.

To cancel an in-flight tool call, send `notifications/cancelled` with `params.requestId` equal to its JSON-RPC ID. The service yields before core execution and checks cancellation/deadline before and after the synchronous core calls. New cancelled/timed-out operations produce incomplete receipts with an indeterminate gate verdict. The pure core is synchronous: it cannot be preempted mid-call. There are no spawned children to kill. This is cooperative cancellation with bounded inputs, not a hard real-time guarantee. CLI stdin has a separate bounded wait (`--input-timeout-ms`, default 5000); a timeout before an envelope arrives is an input error without a receipt.

Limits: 256 KiB operation/frame/file, 1 MiB source corpus, 128 files per tier, 128 scenarios, 256 observations/rules, 128-character runtime IDs, 16 KiB receipts, 100 retained outcomes per owner/session, 1 MiB runtime output, 16 in-flight tool operations, and 10,000 newline frames per MCP connection. Runtime deadlines are 1–30,000 ms. Oversized or unterminated frames fail; they do not fall back to allow.

## Verification and remaining scope

```sh
bun test tests/runtime.test.ts tests/edges.test.ts
bun run --bun tsc --noEmit
```

The tests exercise real source-checkout subprocesses, standard framing, malformed JSON, handshake failures, notifications, cancellation, stdin deadlines, deny exit behavior, replay after reopen, atomic rollback, owner isolation, changed-subject request conflicts, session skew, evidence binding, missing sources, bounds, and core/CLI/RPC equality. No live-harness behavior, external MCP client certification, vendor observations, or production authorization is claimed. The parent integration lane owns those checks and independent review.
