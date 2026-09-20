# Private source and public template

The private `hendoOS` repository is the maintained source. The independent
`hendoOS-template` repository is generated from one reviewed private commit;
it is not a fork, mirror, or second maintained implementation.

## Export contract

`public-export.manifest.json` is an exact, sorted file allowlist. A path that is
not listed is denied, even when it sits under an otherwise public-looking
directory. The exporter reads blobs from the named Git commit rather than the
working tree, rejects symlinks and case-colliding paths, writes a fresh staging
repository with an independent root commit, and runs the public-source scanner
against both its tree and commit metadata.

Private literal and tracker-prefix values must be supplied locally:

```sh
export AOS_CHECK_PUBLIC_PRIVATE_TOKENS='operator=example-private-literal'
export AOS_CHECK_PUBLIC_TRACKER_PREFIXES='tracker=PRIVATE-'
```

Never store real values in the repository, manifest, fixtures, workflow, or
export report. The scanner also applies generic credential, email, and machine
path rules. Synthetic negative controls cover case and separator variants.

Run an export from a clean, reviewed commit into new paths outside the source:

```sh
bun scripts/export-public.ts \
  --source-root "$(pwd)" \
  --revision HEAD \
  --destination /tmp/hendoos-public-stage \
  --report /tmp/hendoos-public-export.json
```

The report is private evidence: it maps the selected private revision and source
blob identities to staged paths and SHA-256 values. Do not add it to the public
tree. Review the staged diff against the public repository, then publish through
an ordinary branch and pull request. Never push a private branch or private Git
history to the public repository.

## Clean-clone acceptance

From a fresh clone containing only the exported files, run every command declared
by the manifest:

```sh
bun install --frozen-lockfile
bun verify
bun scripts/check-public.ts --json
```

The public workflow runs the same frozen install and verifier on Linux, macOS,
and Windows, plus the full commit-history scan. The verifier's embedded public
gate is tree-only so private pull-request merge metadata cannot masquerade as an
export failure; the exporter and standalone command both scan public history.
A private-repository test result is not public-template evidence.

## Contribution return path

Public contributions are reviewed in the public repository, then applied as a
new private commit with provenance. Record the public commit identifier in the
private review so the return path stays auditable. Resolve conflicts in the private source;
never make the public tree a second authority. Re-export the resulting private
commit, compare the exact staged tree with the public branch, rerun the clean
clone acceptance commands, and publish the result through another reviewed
change. The private source-to-export mapping remains private.
