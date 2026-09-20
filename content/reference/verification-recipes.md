---
id: verification-recipes
version: 2
tier: reference
target_harnesses: [default]
byte_budget: 3072
summary: Concrete recipes for the verification gates named by kernel content.
activation_conditions:
  - harnesses: [default]
    event: task-start
  - harnesses: [default]
    event: pre-edit
  - harnesses: [default]
    event: pre-publish
---

# Verification Recipes

Depth for `verification-posture`. Loaded only when explicitly requested and declared by kernel content.

## Recipe: code change

1. Write the failing check first, and confirm it fails for the intended reason.
2. Make the smallest change that turns it green.
3. Run the relevant regression checks and type check. Broaden testing only when the
   change or remaining risk requires it; do not claim a suite that was not run.
4. Report the exact command and its decisive output line.

## Recipe: operating rules or documentation

1. Confirm every referenced path exists.
2. Diff the claim against the artifact it describes; a stale statement is a defect.
3. Run the drift check when one exists, and treat a missing checker as a failure.

## Recipe: toolchain or capability change

1. Record the version actually installed, read from the tool itself.
2. Prove the capability runs non-interactively.
3. Prove the previous path still works, or state plainly that it does not.

## Recipe: publish or deploy

1. Smoke the deployed surface, not the local build.
2. Record the version or digest that is actually live.
3. Name the rollback before the publish, not after a failure.

## Anti-recipes

- A green unrelated check is not evidence.
- A check whose scanner is missing is not a pass.
- A check that has never been seen to fail has not been demonstrated.
