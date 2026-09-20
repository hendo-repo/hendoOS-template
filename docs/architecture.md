# Architecture

AOS is a Bun and TypeScript context compiler. It is not a shell-framework port.
The core turns explicit source text, events, state and observed facts into
reproducible payloads and policy decisions.

`schema` parses the supported frontmatter subset, validates strict contracts,
selects activation and checks manifests. `compose` builds a stable per-harness
kernel prefix, resolves requested reference prose, checks independent scenario
membership and assembles a versioned payload. `policy` evaluates validated rules
against supplied observations. `protocols` supplies outcome/error types, safe paths,
finite JSON validation, hashing, byte budgets and source maps.

These modules have no filesystem, network, environment, clock or random input.
Hashing uses Bun's deterministic SHA-256 implementation. Equal inputs yield equal
outputs. Importing the core does not read configuration or render files. Adapters
own source loading, current-state observation, private-value handling, persistence,
locks, installation paths, harness instruction placement and outward actions.
They must propagate failed outcomes rather than extracting a partial value and
reporting success. An allow verdict describes supplied evidence; it does not grant
an adapter new authority.

Membership expectations are a separate authored contract. The full activation set
and kernel-only set are checked independently of mutable document tiers. The kernel
prefix remains fixed across event/state changes for one harness and corpus
version. Reference activation remains visible in diagnostics, while prose requires
an explicit request. Source maps retain file provenance across both regions.

The core supports a deliberately small YAML subset and the Markdown link forms
used by the shipped starter. It is not a complete YAML or CommonMark engine.
External URLs, HTML anchors and arbitrary asset catalogs are not verified. The
received-payload schema checks internal consistency, not signatures or origin.
Source digests attest compiled source bytes only when the adapter preserves and
checks the source manifest. The core cannot reconstruct source frontmatter from a
hand-built document, verify caller-declared freshness, or detect filesystem symlinks.
Relative path validation is lexical; adapters must enforce physical containment.

This lane verifies `tests/core*.test.ts` and project typechecking. Installation,
drift, privacy scanners, live harness behavior and production readiness need their
own evidence. See [contracts](contracts.md) for public types and working examples.
