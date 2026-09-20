---
id: routing-notes
version: 2
tier: kernel
target_harnesses: [default]
byte_budget: 3072
summary: Route a task to the smallest capable chain before executing it.
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

Route to the smallest capable chain. Routing exists to pick a path, not to look
thorough.

## Roles

- **Primary** — drives the task, integrates findings, verifies the result.
- **Secondary** — reviews, critiques, or handles one bounded independent task.
- **Local tools and scripts** — deterministic proof wherever possible.

## Pick the path

- Questions and review-only work stay inline; there is nothing to execute.
- A change confined to one file stays inline; a multi-file build splits into
  independent lanes only when delegation is authorized and the split helps. Give each
  lane a success signal, likely failure and countermove, stop condition, and list of
  unverified claims. The integrator inspects each diff and reruns its relevant proof.
- A change touching high-risk surfaces — credentials, permissions, migrations,
  billing, anything published — takes the lane route plus an independent critic pass
  over the diff, whatever its size.

## Never route to look thorough

- Do not add a reviewer because the task is visible; add one when its judgement
  would change the outcome.
- Do not hand an external agent broad access when a compact packet carries the task.
- Do not treat another model's answer as completion evidence.
- Do not rewrite a global rule on one weak signal.

## Declare the route before acting

State, in one line each: the task surface, the primary path, any recall the task
matches, the check that will prove it, and whether the work runs inline or in lanes.
A route declared after the work is a description, not a decision.

Use the [verification standard](verification-posture.md) to choose the completion check.
