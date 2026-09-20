---
id: closeout-discipline
version: 3
tier: kernel
target_harnesses: [default]
byte_budget: 3072
summary: Wrap a finished workstream by classifying every lesson and every artifact.
activation_conditions:
  - harnesses: [default]
    event: session-end
  - harnesses: [default]
    event: task-complete
---

# Closeout Discipline

A workstream is not finished until its lessons are routed and its artifacts are
classified. Closeout is a pass, not a summary.

## The questions that must be answered

1. What was built that should have been eliminated instead? If nothing breaks without
   it, say so and stop.
2. What was learned that should change future behaviour?
3. Is the lesson already represented somewhere, or does it need a new home?
4. Can the lesson become a check or a script instead of prose?
5. What durable knowledge does this change, and where does it live?
6. Was relevant guidance inaccessible, not found, not loaded, misunderstood, loaded
   but ignored, stale or incorrect, disproportionate, applied, or correctly left with
   no action? Record the observed category without assuming every miss is a rule defect.
7. What did the work reveal about missing data, unclear handoffs, or unbounded goals?

8. What active state or durable artifact changed? Record the destination and update
   the corresponding state during closeout; do not defer an unrecorded handoff.

## Route lessons to their source

Deduplicate before writing. Route general operating rules to their maintained source,
project facts to project knowledge, tool usage to the tool guide, decisions and durable
findings to the knowledge store, and unfinished actions to the work tracker. Report a
recall failure where the retrieval path can be repaired. A lesson is not retained until
its destination is recorded and the next session can find it. Do not copy private
history into public rules. If recalled guidance was evaluated and nothing merits
retention or a changed action, note-linked `no action` is a valid result; use
`not found` when no note was in play.
Do not require a telemetry system or dashboard merely to record a useful observation.

## Artifact classification

Every file created in the session receives exactly one classification, and a bare
default-keep is not one of them:

- `keep-because-<reason>` — durable evidence; the reason is stated.
- `clean-now` — consumed scaffolding; removed before the closeout is reported.
- `clean-by-<date-or-owner>` — bounded lifetime; the retention rule is named.

## Report shape

State what changed, what was verified, what state changed, what was created, what is
still running, the residual risk, and the next concrete action. A closeout that says
done without the artifact that proves it is not a closeout.

Use the [verification standard](verification-posture.md) for completion claims.
