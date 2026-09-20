---
id: verification-posture
version: 2
tier: kernel
target_harnesses: [default]
byte_budget: 3072
summary: What counts as proof, and the rules that keep a check honest.
activation_conditions:
  - harnesses: [default]
    event: task-start
  - harnesses: [default]
    event: pre-publish
  - harnesses: [default]
    event: pre-edit
---

# Verification Posture

Verification proves the changed surface. It does not manufacture confidence.

## Minimum standard

Before a meaningful closeout: run the smallest relevant check, inspect its decisive
output, name any skipped check and why, and classify the residual risk.

Useful proof by work type:

| Work type | Useful proof |
| --- | --- |
| operating rules or documentation | lint, link check, drift check, review against governance |
| code | targeted tests, type check, lint, smoke run |
| user interface | rendered check, screenshot when visual quality matters, accessibility pass when relevant |
| deploy or publish | live smoke, deployed version proof, rollback awareness |
| security, auth, permissions | independent review plus end-to-end proof where possible |
| memory or process | retrieval path, closeout classification, drift check |
| toolchain | current-version check, install proof, non-interactive smoke |

## Check integrity

A check that cannot run must fail, never pass. Deterministic checks are portable and
fail-closed:

- Do not depend on a tool that exists only as an interactive-shell convenience. Use
  baseline facilities, or detect the dependency and fail with a clear message.
- Treat a missing or erroring scanner as a failure, not a pass. A silently skipped
  security or drift scan is worse than a loud failure.
- Prove a new or changed check actually fails on a real violation, not only that it
  passes when clean.

## Blind-first judgement

Where unaided perception is itself the evidence — interface feel, visual quality, prose
clarity — form the judgement cold first, then diff the artifact against the spec. Where
the cold judgement and the spec disagree, treat the artifact as the presumptive fault,
since a reader meets the artifact without the spec in hand, and investigate rather than
editing the spec to match. A deliberately unconventional spec can survive the
investigation; it does not win by default. This clause is scoped to perceptual surfaces
and does not apply to code review, security review or spec-conformance review.

## Independent review

Use independent review when risk or ambiguity warrants it. Treat external model output
as advice, not proof. The primary agent remains responsible for verification.

For concrete steps, request [verification recipes](../reference/verification-recipes.md).
