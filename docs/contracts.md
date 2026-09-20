# Pure core contracts

The public entry points are `compose(event, state, index)` and
`evaluatePolicy(event, facts, rules, context)`. Both accept unknown runtime input
and return `Outcome<T>`: `{ ok, degraded, errors, value }`. Errors are sorted;
invalid input produces a well-formed degraded value, not an exception. Never use
a degraded composition as proof of readiness. For policy, require both `ok` and
`value.safe`; `indeterminate` is a stop.

## Schema and corpus

`src/schema/index.ts` exports the content compiler, activation and manifest
functions, their types, and strict Zod schemas. Every object boundary rejects
unknown keys. IDs, revisions, digests, normalized relative paths, nested conditions,
and duplicate observation keys are validated before evaluation. Digests use exactly
`sha256:` plus 64 lowercase hex digits; trailing newlines are invalid.

`buildContentCorpus(files)` takes `{ path, text }[]` and returns
`Outcome<ContentCorpus>`. Always inspect this outcome before passing its documents
to compose. A rejected source cannot be reconstructed from a partial corpus.
`compileContentDocument(path, text)` returns `Outcome<ContentDocument | null>`.
Content frontmatter requires `id`, positive `version`, `tier`, `target_harnesses`,
positive `byte_budget`, and nonempty `activation_conditions`; `summary` is optional.
`kernel` and `reference` are the only tiers. `'*'` is the wildcard harness.

`CoreConfigSchema` covers only core settings. Installation configuration belongs
to the effect layer. This example performs no I/O:

```ts
import { CoreConfigSchema } from '../src/schema';
const config = CoreConfigSchema.parse({
  version: 1,
  revision: 'cfg-1',
  totalByteBudget: 20000,
  checkerRevision: 'aos-policy/1',
});
```

Use `safeParse` or exported `parseOrErrors` for unknown configuration input. Direct
Zod `.parse()` throws by design. A caller cannot replace the implemented checker
revision or supply an `authority` override.

## Compose and membership

`ComposeIndex` contains `documents`, optional `staticBlocks`, optional
`totalByteBudget`, and three independently authored scenario expectations:

- `mustFireIds`: exact set of all activated IDs, including references.
- `mustFireKernelIds`: exact set of activated kernel IDs.
- `mustFireStaticIds`: exact set of kernel IDs present in the invariant static prefix, including dormant kernels targeted to the harness.

Both expectations are required for successful composition. Do not derive them
from the same mutable documents being checked. Removing a kernel, changing its
activation, or demoting it to reference must fail the fixed expectation.
`MembershipScenario` uses `expectedIds`, `expectedKernelIds`, and `expectedStaticIds` for these same
checks. `MembershipManifest` includes `version: 1`, `owner`, `generation`, and
`scenarios`. `evaluateMembership(manifest, documents)` propagates activation errors.
An empty or unknown scenario is degraded even if its expected set is empty. The
shipped manifest intentionally includes three such negative scenarios; evaluating
all scenarios therefore returns `ok: false`, with eleven valid scenarios and three
explicit failures.

```ts
import { buildContentCorpus } from '../src/schema';
import { compose } from '../src/compose';

const source = (id: string, tier: string, body: string) => ({
  path: `content/${id}.md`,
  text: `---\nid: ${id}\nversion: 1\ntier: ${tier}\ntarget_harnesses: [default]\nbyte_budget: 4096\nactivation_conditions:\n  - harnesses: [default]\n    event: task-start\n---\n${body}\n`,
});
const corpus = buildContentCorpus([
  source('rules', 'kernel', '# Rules\nRead [recipes](recipes.md) when needed.'),
  source('recipes', 'reference', '# Recipes\nRun the relevant checks.'),
]);
if (!corpus.ok) throw new Error('Invalid corpus');
const index = {
  documents: corpus.value.documents,
  mustFireIds: ['rules', 'recipes'],
  mustFireKernelIds: ['rules'],
  mustFireStaticIds: ['rules'],
  totalByteBudget: 20000,
};
const event = { id: 'task-start', harness: 'default' };
const kickoff = compose(event, {}, index);
const requested = compose(event, { referenceIds: ['recipes'] }, index);
if (!kickoff.ok || !requested.ok) throw new Error('Invalid composition');
// Identical kernel bytes; reference prose appears only in requested's suffix.
console.assert(kickoff.value.payload.staticHash === requested.value.payload.staticHash);
```

The static prefix contains ordered framework blocks and all kernel documents
that target the harness, ordered by ID. Its bytes depend only on the harness and
corpus generation, not the event, state, or reference request. Activation indicates
which rules apply now; content must state its own scope. The suffix holds requested
reference prose plus deterministic event/state metadata. An activated reference is
not an automatic prose request. Requests must resolve to references declared by a
kernel for the same harness.

Reference checks cover `References: id, id` declarations and starter Markdown's
inline links, images, reference definitions, and local heading fragments. Relative
links resolve from the declaring source file and cannot escape the corpus root.
External URLs are not fetched or checked. Every targeted document is checked, even
when its prose is not requested. Structural, reference, budget and membership
failures have distinct error codes; content is never silently truncated.

`ContentManifest` records `version: 1`, `owner`, `generation`, and source
`{ path, digest, id }` entries. `compareContentManifest` reports missing, changed,
unlisted and mismatched sources, and optional observed-generation regression.
Any error makes `exact` false.

## Policy

`PolicyEvent`, `PolicyFacts`, `PolicyRule`, and `PolicyContext` are exported from
`src/policy`. Corresponding runtime schemas are exported from `src/schema`.
Facts bind a subject digest to unique observations with status `fresh`, `missing`,
`stale`, or `unavailable`. Fresh observations require a finite JSON value. Cycles,
class instances, functions, undefined nested values, and non-finite numbers fail.
Rules contain an ID, `allow` or `deny`, optional `when`, `requires`, `contentIds`,
and `reason`. An explicit empty `when` is invalid; an omitted condition is
unconditional. Conditions support event, harness, intent, path prefix, observation
equality and observation truthiness. Equality without an observation is invalid.

```ts
import { evaluatePolicy, POLICY_CHECKER_REVISION } from '../src/policy';
import { digestOfString } from '../src/schema';
const result = evaluatePolicy(
  { id: 'pre-edit', harness: 'default', intent: 'edit' },
  {
    subjectDigest: digestOfString('candidate artifact'),
    observations: [{ key: 'scan', status: 'fresh', value: true }],
    paths: ['src/example.ts'],
  },
  [{ id: 'checked-edit', decision: 'allow', when: { truthy: 'scan' }, requires: ['scan'] }],
  { configRevision: 'cfg-1', checkerRevision: POLICY_CHECKER_REVISION },
);
console.assert(result.ok && result.value.safe);
```

All inputs are parsed before rule evaluation. Any malformed input blocks evaluation
and returns indeterminate. For valid inputs, scope is checked before required
observations; a matching deny wins. Allow requires a matching allow rule, a nonempty
fully fresh observation set, and no applicable rule with missing evidence. Empty
rules or observations never allow. Evidence carries subject/config/checker identity,
observations, contributing rules and a canonical digest. Freshness is supplied by the
adapter; the pure core has no clock and cannot attest that an observation is honest.

## Payload and provenance

`VersionedPayload` has wire/schema/compose versions (currently 1), `text`, UTF-8
`bytes`, `budget`, `mustFireIds`, three hashes, two text regions and `sourceMap`.
Each source-map entry retains its relative source file, IDs, region, byte range and
zero-based line/column. Columns count JavaScript UTF-16 code units; ranges count
UTF-8 bytes. `text === staticPrefix + dynamicSuffix`.

`composeVersionedPayload` strictly validates segments and enforces the total byte
budget. `VersionedPayloadSchema` validates received payload shape, hashes, byte
count and source-map coverage. `recomposeWithStaticBlocks` preserves content source
paths and the dynamic suffix. `canonicalize` and digest helpers are low-level typed
utilities; `canonicalize` deliberately throws for non-JSON input. They are not
unknown-input outcome boundaries.
