---
id: routing-notes
version: 3
tier: kernel
target_harnesses: [default]
byte_budget: 3072
summary: Use an execution route only when it materially improves the task.
activation_conditions:
  - harnesses: [default]
    event: session-start
  - harnesses: [default]
    event: task-pivot
    state: pivot
  - harnesses: [default]
    event: capability-query
---

# Routing Notes

Routing is optional coordination, not a ceremony. Keep ordinary questions and
routine changes inline. Choose the smallest capable path only when a split, specialist,
or independent review would materially improve the result.

## Roles

- **Primary** — drives the task, integrates findings, verifies the result.
- **Secondary** — reviews, critiques, or handles one bounded independent task.
- **Local tools and scripts** — deterministic proof wherever possible.

## Pick the path

- Questions and review-only work stay inline unless a specialist is essential.
- File count alone does not require delegation. Split work only when delegation is
  authorized, the lanes are genuinely independent, and coordination costs less than
  it saves. The primary owns integration and inspects accepted artifacts.
- High-risk or shared-framework changes receive independent review when feasible.
  Use a reviewer from a different model family from the primary; the active harness
  chooses the model and transport. Do not encode a fixed provider or model roster.
- An unavailable optional reviewer does not mean no useful work can proceed. Continue
  within authority and report the unreviewed claim. Stop only when that review is an
  essential acceptance condition or the risk cannot otherwise be bounded.

## Never route to look thorough

- Do not add a reviewer because the task is visible; add one when its judgement
  would change the outcome.
- Do not hand an external agent broad access when a compact packet carries the task.
- Do not treat another model's answer as completion evidence.
- Do not rewrite a global rule on one weak signal.

Do not require a routing declaration for ordinary work. When lanes are used, record
their ownership, acceptance signal, and the artifact the primary accepted; do not
generate a task wave merely to demonstrate process.

Use the [verification standard](verification-posture.md) to choose the completion check.
