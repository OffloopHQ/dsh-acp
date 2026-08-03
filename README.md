# dsh-acp

`dsh-acp` is an independent, client-neutral [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) adapter for a user-installed DeepSeek Harness (DSH).

Any ACP client that supports the negotiated protocol version and advertised capabilities can connect over stdio.

## What it does

- Discovers an existing DSH source installation without installing, updating, or modifying it.
- Rejects unknown DSH versions, unknown layouts, basename collisions, and runtime drift.
- Loads the selected, versioned DSH driver only after discovery and fingerprint validation.
- Translates DSH sessions, streaming events, cancellation, steering, and permissions to ACP.
- Advertises only capabilities implemented by the selected driver.

The current driver supports the DSH `0.0.1` source layout. See [compatibility](docs/compatibility.md) for the exact surface and limitations.

Its current session surface is `new`, `load`, `resume`, `fork`, workspace-scoped
`list`, and `close`. It also supports text/resource-link prompts, steering,
one-shot permission requests, and stdio/Streamable HTTP MCP servers. Features
without a safe DSH `0.0.1` seam—including delete, auth/provider management,
images, embedded context, elicitation, and SSE MCP—remain unadvertised.
DSH's credential-backed built-in web search/fetch surface and repository plugin
loader are disabled; an ACP-explicit MCP server remains a separate,
client-configured tool boundary.

## Commands

```text
dsh-acp [serve] [--dsh-path <path>] [--dsh-home <path>]
dsh-acp inspect --json [--dsh-path <path>] [--dsh-home <path>]
dsh-acp doctor --json [--dsh-path <path>] [--dsh-home <path>]
dsh-acp --version
```

`serve` is the default. Its stdout is reserved exclusively for newline-delimited ACP JSON-RPC frames. Diagnostics go to stderr and are bounded and credential-redacted.

`inspect --json` performs read-only discovery and prints one JSON result. `doctor --json` additionally checks that the discovered installation remains unchanged. Neither command proves a live ACP connection; the ACP client's bounded `initialize` handshake is the final readiness check.

For a runtime fingerprint fence:

```text
dsh-acp serve \
  --dsh-path /absolute/path/to/dsh \
  --node /absolute/path/to/node \
  --expected-runtime-fingerprint sha256:...
```

Legacy `--candidate` and `--dsh-root` spellings are accepted as aliases for `--dsh-path`. They still go through full discovery and cannot bind an unchecked checkout.

See the complete [CLI contract](docs/cli.md).

## npm installation

Published releases use `dsh-acp` as the canonical npm name and publish the
same version and executable payload as the `@offloophq/dsh-acp` scoped mirror.
Install either identity, not both in the same npm prefix, because both own the
same `dsh-acp` executable:

```text
npm install --global dsh-acp
# or
npm install --global @offloophq/dsh-acp
```

## Distribution and runtime boundary

The source repository is private. That does not make every possible artifact public:

- GitHub Release assets in a private repository require repository read access.
- The public `dsh-acp` package and its `@offloophq/dsh-acp` mirror make their
  npm tarballs public even while source remains private.
- A downstream distributor with repository access can fetch a fixed private
  artifact during its authenticated build and ship the checksum-verified
  adapter in its own package.

The default release artifact is an esbuild-produced, portable JavaScript bundle for Node.js `^22.19.0` or `>=24.0.0`. This adapter is not shipped or executed as TypeScript, and it does not invoke npm, pnpm, npx, the `tsx` CLI, or network downloads at runtime. The versioned driver does import DSH's already-installed TypeScript sources through DSH's own validated tsx loader; that loader and source tree remain DSH-owned prerequisites.

Experimental Bun standalone compilation exists for six desktop targets, but
the CI job retains only its manifest and not the binaries. The current
in-process DSH driver is not Bun-compatible, and Bun embeds LGPL-licensed
JavaScriptCore/WebKit, so every binary distribution remains gated on runtime
compatibility plus separate relinking and license reviews. See
[distribution](docs/distribution.md).

## Development

Requirements are Node.js `^22.19.0` or `>=24.0.0` and npm 11.

```text
npm ci
npm run check
node scripts/package-release.mjs
node scripts/verify-release.mjs
```

Build outputs are written to `dist/`; release assets are written to `release/`.
See [npm publishing](docs/npm-publishing.md) for the dual-package identity,
one-time registry bootstrap, Trusted Publisher, release-tag, trust-boundary,
and recovery contracts.

## Security properties

- Discovery never downloads or mutates DSH.
- PATH basename matches are treated as candidates, not identity proof.
- The logical install anchor, physical checkout, critical file contents, Node version, and tsx version are fenced before construction and again before DSH boot.
- `serve` keeps non-protocol output off stdout.
- Diagnostic serialization is bounded and redacts credential-shaped keys, headers, URLs, and values.
- The DSH composition used by the driver disables DSH telemetry and owns cleanup of sessions and the root fiber.
- Every boot uses an adapter-owned private temporary configuration, forces the
  reviewed `workspace-write`/`ask` baseline, and leaves the installed DSH source
  configuration unchanged.
- Persisted, fork-seeded, and newly returned DSH event logs are rejected if
  their permission preset, sandbox mode, or approval policy is dangerous,
  unknown, or outside the exact reviewed event shape. Only absent facts or
  `read-only`/`workspace-write` plus `ask` can be adopted.
- The final boot layer disables DSH's built-in repository, web search/fetch,
  and telemetry rows, then verifies that no global web service or
  `web_search`/`web_fetch` tool survived composition.

This is not process-wide network isolation. DSH `workspace-write` constrains
file writes; a `bash`/execute command may still use host networking, and an
ordinary tool call does not necessarily raise an ACP permission request. The
selected model transport and ACP-explicit MCP servers are intentional separate
network paths. Standalone clients must apply policy appropriate to their trust
model. A client that requires protected admission must fail closed until its
outer network/provider interception conformance has passed; a successful ACP
`initialize` alone is not protected-readiness proof. The vendor capability
metadata reports this explicitly as `offloop.dsh-acp.security`.

Report vulnerabilities privately to the repository owners. Do not include API keys, credentials, prompts, or customer data in an issue.

## License

Original project code is licensed under the [MIT License](LICENSE). Bundled dependencies and optional runtimes retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). DSH is an external prerequisite and is not included or redistributed by this project.
