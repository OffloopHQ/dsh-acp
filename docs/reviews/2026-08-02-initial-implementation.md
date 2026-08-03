# Initial implementation review

Date: 2026-08-02

Status: historical snapshot of the `0.1.0` preview review as of 2026-08-02.
The client-neutral source tree had been published to the private GitHub
repository with an exact `refs/heads/main` readback; the release and gate
statements below describe that date, not current deployment state. Current
authority lives in [`../distribution.md`](../distribution.md) and
[`../npm-publishing.md`](../npm-publishing.md).

## Scope and evidence

This review covers the independent TypeScript ACP server, the versioned DSH
`0.0.1` source driver, discovery/fingerprint checks, session persistence,
permission and cancellation behavior, scoped MCP installation, diagnostics,
and release packaging. The implementation was compared against ACP SDK 1.3.0,
the exact APIs in the locally installed DSH `0.0.1` compatibility seam, and the
observable lifecycle expectations recorded in
`docs/independent-implementation.md`.

The local DSH inspection resolved the official installation to DSH `0.0.1`,
Node `24.16.0`, tsx `4.22.4`, 221 reviewed files, and fingerprint
`sha256:1449102f04ad0752b8f5c46a2ecd6d60d0425de3357231d6aeb51ef9190304b1`.
The same `inspect` and `doctor` paths reject an unrelated same-name binary
discovered on `PATH`.

## Pass 1: ACP protocol

Reviewed method registration, ACP 1.3 types, capability advertisement, content
and update mapping, error classes, stdout ownership, and multi-connection
composition.

Findings resolved:

- The adapter now creates one runtime driver per ACP connection instead of
  sharing connection/session state.
- `session/load` declares and replays direct user and steering text as
  `user_message_chunk`; undeclared runtime updates fail closed.
- Initial commands are published before a prompt reaches the runtime and remain
  generation-fenced.
- Invalid/stale cursors, missing sessions, and already-active sessions map to
  actionable ACP error classes rather than a generic compatibility failure.
- Unsupported DSH surfaces are omitted from capabilities; delete,
  auth/providers, image/embedded content, elicitation, and SSE cannot be invoked
  by relying on a similarly named internal DSH service.

## Pass 2: lifecycle and concurrency

Reviewed initialize/open/activate/close ordering, one-turn ownership,
request-abort and `session/cancel`, permission races, fork ownership, and
connection teardown.

Findings resolved:

- Prompt ownership is claimed atomically before any awaited initial update, so
  concurrent prompts cannot both enter one session.
- The opening phase is cancellable. A synchronous prompt failure releases the
  claim, while a cancelled or hung turn is isolated behind a bounded drain.
- Cancellation publishes the prompt's single terminal settlement before the
  fallible DSH cancel seam. Repeated cancel paths for the same turn share its
  exact cleanup promise, and ACP does not return the cancelled prompt response
  until runtime cancellation plus runner drain completes or the bounded
  isolation backstop retires the session. A cancel failure retires the session
  for close; abandoned-generator cleanup fences replacement prompts until DSH
  is idle, and an unmappable event retires that runtime generation.
- Runtime opens are tracked before publication. A late open after abort is
  closed, and connection close waits for pending cleanup up to the configured
  backstop before closing the driver.
- Load and resume reject duplicate live ownership. Fork accepts an idle source
  owned by this driver, rejects a busy source, and rejects an unrelated live DSH
  owner.
- Close drains active turns, descendants, scoped MCP effects, agent handles,
  listeners, the root fiber, and the adapter-owned boot workspace in ownership
  order.
- Session, rejected-handle, host, and connection teardown retain exact cleanup
  ownership across transient failures and retry in stages. In particular, a
  descendant drain keeps its exact live DSH root registered, reuses a pending
  drain after timeout, and never disposes that root before the drain succeeds.
- A closed ACP connection leaves request and elicitation routing immediately,
  but its cleanup record remains strongly owned. Automatic bounded retries and
  explicit repeatable `app.retryCleanup()` share the exact core owner; CLI
  shutdown uses that path rather than bypassing session cleanup with a raw
  driver close.

## Pass 3: DSH compatibility

Reviewed only the explicit DSH `0.0.1` imports and the 221-file manifest. The
driver uses DSH's create/resume/session-query/title APIs, preserves exact
persisted identity and cwd, and revalidates the installation immediately before
driver construction and boot.

Findings resolved:

- Load replays persisted history; resume adopts it without replay; fork copies
  only a prefix ending at the last complete `turn/end` and verifies parent/seed
  lineage.
- Cursors bind the filtered workspace snapshot and stable page boundary. A
  changed corpus returns a restartable stale-cursor error.
- Session listing is restricted to the adapter's effective workspace so a
  foreign cwd cannot enumerate metadata.
- Untrusted history is limited to 20,000 events, 1 MiB per event, 16 MiB per
  snapshot, and 4 KiB per title. Version, sequence, time, identity, cwd, JSON
  serializability, and aggregate size are checked before adoption.
- The adapter boots from a private temporary config and forces
  `workspace-write` plus `ask`; it does not patch the installed DSH config.
  Failed cleanup remains retryable.

The real DSH boot reached the installed composition but could not complete in
this development runner because its outer macOS policy blocks DSH's own
`sandbox-exec` invocation. Source config hash, status, and mtime remained
unchanged, and no adapter boot directory remained. This is a real-environment
acceptance blocker, not evidence of a successful keyless E2E.

## Pass 4: security and release

Reviewed path validation, MCP configuration, secret projection/logging,
temporary files, dependency pins, notices, SBOM/checksums, npm packing, and
release workflows.

Findings resolved:

- Recursive redaction covers nested secret-shaped fields, authorization and
  cookie headers, provider tokens, private keys, URL secrets, and bounded raw
  tool output.
- MCP stdio requires an absolute command; arguments/environment are passed
  structurally, HTTP uses only `http`/`https`, and SSE fails closed. Connection,
  discovery, refresh, late completion, and cleanup are bounded and scoped to
  the DSH agent effect. Refresh errors log one fixed secret-free diagnostic.
- The release verifier cross-binds package metadata, exact dependencies and
  lockfile, bundle, portable/npm members, complete licenses, CycloneDX
  components, and checksums.
- Optional npm publication publishes the exact verified `.tgz` and reads back
  its version and SHA-512 registry integrity.
- Bun standalone output is compile-only: CI retains only the manifest. The
  current in-process DSH host is not Bun-compatible, and binary distribution
  remains behind runtime, license, signing, and platform gates.

## Validation record

Both the source tree and a temporary copy without `node_modules`, `dist`, or
`release` passed a clean offline `npm ci` followed by the full checks. The
clean install resolved 65 packages and reported zero vulnerabilities from the
available lock/cache metadata. Final local results were:

- typecheck and build pass;
- 12 test files and 159 tests pass;
- release-manifest safety and `actionlint` pass;
- portable Node archive, npm tarball, CycloneDX SBOM, build manifest, licenses,
  notices, and `SHA256SUMS` pass cross-bound artifact verification;
- bundled CLI reports `dsh-acp 0.1.0`;
- real `inspect` and `doctor` pass for the installed DSH `0.0.1`, Node
  `24.16.0`, tsx `4.22.4`, 221-file seam, and recorded fingerprint.

The authoritative commands are:

```text
npm ci
npm audit --omit=dev --audit-level=high
npm audit --audit-level=high
npm run check
node scripts/package-release.mjs
node scripts/verify-release.mjs
node dist/index.js --version
node dist/index.js inspect --json --dsh-path "$HOME/.local/bin/dsh"
node dist/index.js doctor --json --dsh-path "$HOME/.local/bin/dsh"
```

The two online `npm audit` variants could not reach the npm advisory endpoint
because the outer runner denied its local network proxy with `EPERM`. This is
an external evidence gap, not a successful online audit and not a discovered
vulnerability.

## Remaining gates as of 2026-08-02

- Validate a pinned source revision from at least one downstream ACP client
  with an exact revision readback.
- Run keyless boot/new/cancel/cleanup outside the outer `sandbox-exec` block,
  then run credentialed prompt/tool/permission/usage tests.
- Complete acceptance runs with at least two independent ACP hosts.
- Implement only DSH-backed delete, auth/provider, mode/config, richer content,
  elicitation, SSE, terminal, and subagent surfaces before advertising them.
- Publish and read back a portable release plus both npm identities. The
  one-time npm bootstrap and Trusted Publisher setup remain owner deployment
  gates; Bun/native distribution remains blocked as described above.
