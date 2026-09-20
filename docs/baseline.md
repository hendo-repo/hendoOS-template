# Upstream baseline

AOS is a new Bun/TypeScript implementation of the Agentic OS operating framework. It is a context compiler and policy engine, not a mechanical translation of shell scripts. This document records the source baseline, not a claim of feature parity.

## Provenance and content updates

- Upstream: https://github.com/QuestionPilot/agentic-os-template
- Pinned revision: `d0fb34feb4ddb2baaa7c0435a77649e7fdccd311`
- License: MIT; the upstream license is preserved verbatim in `LICENSE`.
- Read upstream content through committed Git objects. Never copy an operator's working directory, configuration, vault, memory, or Git history into this repository.
- AOS freezes its reference at this revision. The existing OS remains independent and operational; it is not frozen or migrated.
- Updating the pin requires a reviewed source comparison, scenario tests, and an explicit content-version change. No automatic upstream synchronization occurs.

## Source map

| Upstream source | Contract carried into AOS |
| --- | --- |
| `core/operating-system.md`, `core/discipline-kernel.md` | Authority, source-of-truth boundaries, delegation and verified delivery |
| `core/memory-model.md`, `core/self-improvement.md` | Operational cache versus durable knowledge; bounded indexes and lesson routing |
| `capabilities/session-agent.md` | Kickoff orientation, per-task routing, lesson recall and tracked work |
| `capabilities/closeout.md`, `capabilities/self-audit.md` | Explicit closeout and evidence-backed diagnostics |
| `verification/`, `playbooks/` | On-demand verification and workflow reference material |
| `harnesses/` | Version-scoped protocol facts, hook event names and instruction placement |
| `scripts/install.sh`, `scripts/install.ps1` | Target preflight, staged output, user-content preservation and conservative removal |
| `scripts/check-drift.sh`, `scripts/check-drift.ps1` | Nonempty manifest coverage and byte comparisons; source freshness is distinct from installed-file integrity |
| `scripts/orient.sh`, `scripts/orient.ps1` | Missing integrations are named uncertainty, never evidence of no work |
| `scripts/check-clean.sh`, `scripts/check-clean.ps1` | Public-tree privacy, including filenames, content and Git metadata |
| `tests/` | Behavioral fixtures and failure controls, not a test-count target |

## Deliberate improvements

All edges call a shared pure compiler and policy engine. Context carries version, byte budget, rule membership, digest and source mapping. Stable kernel content precedes dynamic session context. Policy evidence identifies its subject and revisions rather than granting a session-wide verification flag. Runtime schemas reject malformed input. Operational state is owner-namespaced; it does not replace plain-text rules or the knowledge layer.

Installation is a staged multi-file transaction with recovery, not a claim of filesystem-wide atomicity. Detection stays separate from repair. Unknown, stale and incomplete observations remain distinct. Platform tests and live harness enforcement remain separate evidence categories.

## Frame content versus operator data

A stranger receives the engine, generic starter rules, reference content, fixtures and documentation. Operator identity, tracker state, credentials, private tools and knowledge remain externally configured user data. Engine upgrades must not overwrite those user-owned surfaces. No private corpus is migrated as part of the starter build.

## Compatibility limits

The starter rules are an adaptation, not the full upstream corpus. Passing AOS tests does not establish every upstream behavior. AOS must record unsupported or unverified utilities explicitly rather than silently treating their absence as success. No live harness registration or default adoption follows from a successful render. See `support.md` for current evidence.
