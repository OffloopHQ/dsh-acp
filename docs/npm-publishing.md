# npm publishing

Status: dual-package release automation implemented and verified. Both package
identities were bootstrapped at `0.1.0`; npm Trusted Publisher records bind
`OffloopHQ/dsh-acp` and `release.yml`; `0.1.1` was published through GitHub
Actions OIDC.

## Package identities

Each release publishes one version and one executable payload under two public
npm identities:

| Identity | Role | Archive |
| --- | --- | --- |
| `dsh-acp` | canonical package | `dsh-acp-<version>.tgz` |
| `@offloophq/dsh-acp` | organization-scoped mirror | `offloophq-dsh-acp-<version>.tgz` |

Both packages expose the `dsh-acp` executable. Users install one identity, not
both in the same npm prefix. Release verification requires all archive members
except package identity metadata to match exactly.

## Repository-side release contract

`.github/workflows/release.yml` runs only for an annotated `v*` tag pushed by
the fixed release actor ID `22412638` (`kaaanata`), whose peeled commit is an
ancestor of `origin/main` and whose version exactly matches `package.json`.

The workflow has three authority-separated jobs:

1. `release-candidate` has read-only contents permission and no OIDC. It runs
   audits, tests, builds once, produces both npm archives, verifies the complete
   release set, installs each archive into an isolated prefix, and uploads one
   immutable workflow artifact.
2. `github-release` has `contents: write`, reconciles a draft release, downloads
   every live asset, verifies the exact asset names and hashes, and only then
   publishes the draft.
3. `public-npm` has `id-token: write`, but it does not check out source, run
   dependency scripts, build, or repack. It verifies the handed-off candidate
   and publishes both exact archives through npm OIDC.

Before the first mutation, the publish coordinator reads both `name@version`
records. An exact SHA-512 integrity match is already complete; an integrity
conflict or non-404 lookup failure under either identity fails with zero
publishes; only npm `E404` permits `npm publish`. Each command has a fixed
timeout and a short termination grace before a forced kill. After a successful
publish command, an absent version is revalidated online every five seconds for
up to one minute per identity until the exact integrity is visible. Integrity
conflicts, authentication failures, invalid metadata, and command failures do
not retry. This makes a rerun safe when the first name was published and the
second failed, registry propagation lagged, or a timed-out publish had an
unknown result.

## GitHub controls and trust boundary

The repository is private, and its current GitHub plan does not expose
Environments or tag rulesets. The API returns an upgrade-or-public-repository
error for both controls. The workflow therefore uses controls available on the
current plan: a fixed stable actor ID, an annotated tag, exact tag/version
matching, and `main` ancestry. Keep the repository private; do not weaken or
remove these release checks.

The actor-ID check prevents an accidental release by a different current
administrator, but it is not an authority boundary against repository
administrators: an administrator can change the workflow on `main`, and npm's
environment-free trust record then trusts that reviewed filename. Under the
current plan, every repository administrator is therefore part of the release
trust boundary. If publication authority must be separated from repository
administration, upgrade the private repository to enable a protected tag plus
restricted Environment, or change npm automation to staged publishing with a
separate 2FA approval.

Keep Actions secrets free of `NPM_TOKEN` and `NODE_AUTH_TOKEN`. Trusted
publishing supplies a short-lived credential only to `npm publish`. If the
repository later gains rulesets and Environments, add a protected `v*` tag
ruleset and a restricted publish environment in a separately reviewed change,
then update both npm Trusted Publisher records to match.

## One-time npm bootstrap (completed at 0.1.0)

npm requires a package to exist before a Trusted Publisher can be configured.
The first version of both names therefore required one interactive,
owner-operated publish from the exact verified GitHub Release assets. Keep the
following runbook for disaster recovery or replacement package identities; do
not repeat it for ordinary releases.

Preflight:

```text
env -u NODE_AUTH_TOKEN -u NPM_TOKEN npm login --registry=https://registry.npmjs.org
env -u NODE_AUTH_TOKEN -u NPM_TOKEN npm whoami --registry=https://registry.npmjs.org
gh release download v<version> --repo OffloopHQ/dsh-acp --dir release-bootstrap
(cd release-bootstrap && sha256sum -c SHA256SUMS)
```

Publish each exact archive with an account that owns the `offloophq` scope,
can claim the unscoped name, and has interactive 2FA enabled:

```text
env -u NODE_AUTH_TOKEN -u NPM_TOKEN npm publish ./release-bootstrap/dsh-acp-<version>.tgz --access public --provenance=false
env -u NODE_AUTH_TOKEN -u NPM_TOKEN npm publish ./release-bootstrap/offloophq-dsh-acp-<version>.tgz --access public --provenance=false
```

Immediately read back both versions and `dist.integrity` values and compare
them with the local SHA-512 values before configuring trust.

## Trusted Publisher configuration

Configure each package separately on npmjs.com under Package Settings →
Trusted publishing:

- provider: GitHub Actions;
- organization/user: `OffloopHQ`;
- repository: `dsh-acp`;
- workflow filename: `release.yml`;
- environment: leave empty on the current private-repository plan;
- allowed action: `npm publish` only.

With npm CLI 11.15 or newer and an interactive 2FA-capable login, the
equivalent commands are:

```text
env -u NODE_AUTH_TOKEN -u NPM_TOKEN npm trust github dsh-acp \
  --repo OffloopHQ/dsh-acp \
  --file release.yml \
  --allow-publish

env -u NODE_AUTH_TOKEN -u NPM_TOKEN npm trust github @offloophq/dsh-acp \
  --repo OffloopHQ/dsh-acp \
  --file release.yml \
  --allow-publish
```

Each package currently accepts one Trusted Publisher. Now that OIDC publication
is verified, use npm package Settings to require 2FA and disallow traditional
tokens, revoke any temporary bootstrap token if one was used, and live-read
both package settings before treating token publishing as disabled. Preserve
the exact repository/workflow binding. If an environment is added later,
update both bindings atomically.

## Provenance boundary

Trusted Publishing authentication works for public packages sourced from a
private GitHub repository, but npm provenance does not. The release keeps
`provenance=false` until the repository is public and both registry entries
show verified provenance. Do not describe OIDC authentication itself as a
provenance attestation.
