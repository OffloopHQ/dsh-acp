# Distribution

Status: the portable Node archive on public GitHub Releases is the only
distribution channel. The source repository and GitHub Releases are public.

npm is not a distribution channel. Through `0.1.1` this project published as
`dsh-acp` and the scoped mirror `@offloophq/dsh-acp`. A 2026-11-12 registry
readback found `dsh-acp` re-registered by an unrelated party and
`@offloophq/dsh-acp` absent. `v0.1.2` shipped only as a GitHub Release. Do not install either name from npm. The package is marked
`private`, and the release workflow has no npm job or OIDC token.

## Artifact matrix

| Artifact | Source access | Runtime requirement | Default release |
| --- | --- | --- | --- |
| Portable Node archive | public GitHub Release; `0.1.2` checksum and `--version` readback verified | Node `^22.19.0` or `>=24.0.0` and compatible installed DSH | yes |
| Bun standalone binaries | CI retains only the compile manifest, not binaries | DSH in-process host compatibility is not implemented or validated | no; compatibility and license-review gates |
| Host-bundled adapter | delivered inside a downstream host package | compatible installed DSH | host-controlled integration, not downloaded at runtime |

Published GitHub Release assets are anonymous public downloads. A downstream
distributor may fetch a pinned release, verify `SHA256SUMS`, and embed the
portable adapter. The end user's ACP host then starts the local JavaScript
adapter; it does not download TypeScript, npm packages, or DSH at runtime. The
adapter still requires the compatible DSH installation's own source tree and
tsx loader.

SHA-256 checksums establish byte integrity against the trusted manifest. They are not signatures. Artifact signing must be documented only after a real signing and verification path exists.

## Release contents

`node scripts/package-release.mjs` produces:

- `dsh-acp-<version>-node.tar.gz`, a portable Node archive with the executable
  bundle, complete runtime dependency licenses, and the public documents linked
  from its README;
- `dsh-acp-<version>.cdx.json`, a normalized CycloneDX SBOM for the runtime
  dependencies;
- `dsh-acp-<version>.build.json`, a build manifest containing bundle and
  lockfile hashes;
- `SHA256SUMS` covering the exact asset set.

`node scripts/verify-release.mjs` verifies the exact asset and checksum set, then
cross-binds the package name, version, MIT license, exact runtime dependencies,
the lockfile and bundle hashes, deterministic portable archive contents, the
build manifest, and CycloneDX component versions and licenses. Optional Bun
archives are bound to a strict, exact six-target schema, contained source
paths, source binary hashes, and the exact JavaScript bundle before any archive
path is used.

## Release workflow

Every annotated release tag from the fixed release actor builds and verifies
one candidate with read-only repository access, after proving the exact
version and `main` ancestry. This actor check is an operational accident
guard. The public repository does not yet configure a publish Environment or
tag ruleset, so repository administrators remain inside the release trust
boundary because they can change the workflow on `main`.

A separate job with `contents: write` downloads that single verified
candidate, rechecks `SHA256SUMS`, creates or reconciles a draft GitHub Release
with exactly that asset set, downloads the live assets to compare names and
hashes, and only then publishes the release. A rerun against an already
published release performs the same readback without uploading.

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
