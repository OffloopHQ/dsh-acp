# Distribution

Status: portable Node artifact and dual npm publication implemented and
verified. Both identities were bootstrapped at `0.1.0`; `v0.1.1` published the
private GitHub Release plus public `dsh-acp` and `@offloophq/dsh-acp` packages
through the configured npm Trusted Publishers.

## Artifact matrix

| Artifact | Source access | Runtime requirement | Default release |
| --- | --- | --- | --- |
| Portable Node archive | private GitHub Release unless mirrored | Node `^22.19.0` or `>=24.0.0` and compatible installed DSH | yes |
| `dsh-acp` npm package | public; `0.1.1` registry readback verified | Node `^22.19.0` or `>=24.0.0` and compatible installed DSH | canonical npm identity |
| `@offloophq/dsh-acp` npm package | public; `0.1.1` registry readback verified | same as `dsh-acp` | exact-version scoped mirror |
| Bun standalone binaries | CI retains only the compile manifest, not binaries | DSH in-process host compatibility is not implemented or validated | no; compatibility and license-review gates |
| Host-bundled adapter | delivered inside a downstream host package | compatible installed DSH | host-controlled integration, not downloaded at runtime |

A private GitHub repository's release assets are not anonymous public downloads.
A downstream distributor may fetch a pinned release during its authenticated
build, verify `SHA256SUMS`, and embed the portable adapter. The end user's ACP
host then starts the local JavaScript adapter; it does not download TypeScript,
npm packages, or DSH at runtime. The adapter still requires the compatible DSH
installation's own source tree and tsx loader.

SHA-256 checksums establish byte integrity against the trusted manifest. They are not signatures. Artifact signing must be documented only after a real signing and verification path exists.

## Release contents

`node scripts/package-release.mjs` produces:

- a portable Node `.tar.gz` with the executable bundle and complete runtime dependency licenses;
- canonical `dsh-acp` and scoped `@offloophq/dsh-acp` npm `.tgz` files
  produced by `npm pack` from one verified payload;
- a normalized CycloneDX SBOM for runtime npm dependencies;
- a build manifest containing bundle and lockfile hashes;
- `SHA256SUMS` covering the exact asset set.

`node scripts/verify-release.mjs` verifies the exact asset and checksum set, then
cross-binds both package names, their shared version/MIT license, exact runtime
dependencies, the lockfile and bundle hashes, portable and npm archive
contents, build manifest, and CycloneDX component versions and licenses. The
two npm archives must be byte-identical for every member except their
`package.json` identity metadata. The portable and npm artifacts also carry the
public documents linked from their README. Optional Bun archives are bound to
a strict, exact six-target schema, contained source paths, source binary hashes,
and the exact JavaScript bundle before any archive path is used.

## npm and provenance

Every annotated release tag from the fixed release actor builds and verifies
one candidate without OIDC, after proving exact version and `main` ancestry.
This actor check is an operational accident guard; while the private-repository
plan lacks rulesets and Environments, repository administrators remain inside
the release trust boundary because they can change the workflow on `main`.
The same immutable workflow artifact feeds both the private GitHub Release and
a separate minimal npm job. Only that job receives `id-token: write`; it does
not check out source, install dependencies, rebuild, or repack. It publishes
the two exact verified `.tgz` files and reads both SHA-512 registry integrities
back. A rerun skips an existing exact version and fails closed before any
publish if either registry entry differs. After a successful publish, only an
absent version is revalidated online for up to one minute per identity;
integrity, authentication, timeout, signal, metadata, and other command errors
fail immediately. Recovery after a partial or timed-out dual-package publish
therefore reconciles both exact registry states instead of blindly replaying an
ambiguous mutation.

Both names required a one-time traditional-authentication bootstrap because npm
cannot attach a Trusted Publisher to a package that does not yet exist. That
bootstrap completed at `0.1.0`. Each package now independently trusts
`OffloopHQ/dsh-acp` workflow `release.yml`; the environment claim stays empty
while the current private-repo plan does not provide GitHub Environments. No
long-lived publish token belongs in GitHub Actions. The complete operational
contract is in
[`npm-publishing.md`](npm-publishing.md).

npm provenance cannot currently be generated from a private GitHub source
repository. The workflow explicitly disables provenance while the repository
is private. If source visibility and npm support later make provenance
available, enable it as a separately reviewed gate and verify both published
registry records.

## Experimental Bun standalone build

The six-target build is intentionally opt-in and compile-only:

```text
DSH_ACP_ENABLE_BUN_STANDALONE=1 npm run bundle:all
```

It pins Bun 1.3.13 and its exact revision, downloads each target runtime from the Bun 1.3.13 GitHub release, verifies a committed SHA-256 value, disables Bun's automatic dotenv/bunfig/tsconfig/package loading, and records a binary manifest.

The current DSH driver imports the user's validated DSH source tree in-process
through Node and `tsx`. The Bun experiment does not yet provide a compatible
host for that runtime path, so these binaries are not runnable DSH ACP release
artifacts and must not be distributed or advertised as such.

The opt-in CI job discards its compiled binaries and retains only their hash
manifest. Binary packaging is a separate, owner-triggered path behind the
explicit compatibility and license-review gates below.

When built on macOS, the script ad-hoc re-signs the final Mach-O after Bun appends its payload; otherwise the manifest marks macOS outputs as requiring signing before execution. A real external release would still require the owner's Developer ID signing, notarization, and live verification path.

A standalone launcher must also remove `BUN_BE_BUN` and `BUN_OPTIONS` from its
child environment. Bun documents behavior-changing semantics for both
variables; `BUN_BE_BUN=1` can expose the embedded Bun CLI instead of the
adapter entrypoint.

Packaging those binaries additionally requires:

```text
DSH_ACP_INCLUDE_BUN_STANDALONE=1 \
DSH_ACP_BUN_LICENSE_REVIEW_ACK=reviewed \
node scripts/package-release.mjs
```

This mechanical gate is not legal approval. Public or downstream distribution remains blocked until owners have reviewed the LGPL/JSC object, source-offer, relinking, and complete-license obligations described in `docs/bun-standalone-relinking.md`.
