# Architecture

Status: implemented for the DSH `0.0.1` source driver.

```text
ACP client (editor, automation host, or another compatible client)
        |
        | stdio NDJSON / ACP
        v
ACP transport and session core
        |
        | runtime-neutral typed events and operations
        v
versioned DSH runtime driver
        |
        | validated internal seam
        v
user-installed DSH source runtime
```

## Authority boundaries

The ACP layer owns protocol negotiation, session bookkeeping, request settlement, cancellation fences, permission requests, and event mapping. It has no DSH imports.

The runtime interface is the only contract between ACP and DSH-specific behavior. Capabilities are data supplied by the selected driver. The ACP layer rejects operations that the driver does not advertise.

Discovery owns installation identity. It resolves the logical candidate, rejects basename collisions and path escapes, validates exact package identities, checks Node and tsx versions, and hashes a reviewed compatibility seam covering direct imports and critical boot, Loader/Include, permission/tool admission, concrete sandbox/bash/filesystem/subprocess enforcement, persistence/query, repository loading, credentials, configured LLM/web providers, and MCP SDK transport boundaries. Installation paths and mtimes are deliberately excluded from the seam fingerprint.

That fingerprint detects drift only inside `installation.validatedFiles`. It deliberately does not claim to hash every dynamic Cordis plugin or transitive dependency and is not supply-chain provenance. Artifact verification and trusted DSH distribution remain separate gates.

The factory performs a second physical-path and content check before selecting a driver. The driver performs another check before boot. An expected fingerprint supplied by a caller is an additional fence, not a discovery bypass.

The DSH `0.0.1` driver installs the validated DSH-owned tsx loader into the adapter's Node process, imports only the versioned internal seam, and boots a non-UI Cordis composition. The runtime fingerprint also covers tsx's exact esbuild JavaScript seam, platform package, and native child executable. If `--node` is supplied, its physical path must equal the current process host; the CLI cannot fingerprint one Node and execute DSH in another. Each boot starts from an adapter-owned private copy of DSH's base config, links only the installed dependency tree, filters unsupported UI overlays, disables repository plugin loading, built-in web search/fetch, and telemetry, and forces the reviewed `workspace-write` sandbox plus `ask` approval baseline. A host with an independently enforced process-wide sandbox may explicitly select `--external-process-confinement host-enforced`; this replaces only the nested DSH command sandbox while retaining the `workspace-write` preset and `ask` policy, and is not itself protected-admission evidence. After boot it verifies the settled global service and tool catalog rather than trusting patch intent alone. The installed source config is never patched. DSH's own session query APIs remain the durable history authority, while the adapter owns every live handle and root fiber it creates and disposes them on close.

`workspace-write` is a file-write boundary, not an egress sandbox. The selected model transport and ACP-explicit MCP servers are intentional network boundaries, and a DSH bash/execute command may still use host networking without first producing `approval/request`. The adapter therefore makes no process-wide network-isolation claim.

## Lifecycle invariants

- One active prompt is allowed per ACP session; different sessions may progress independently.
- Every turn has a unique generation and settles once.
- Cancellation, request abort, session close, and connection close converge on the same cleanup path.
- Repeated cancel signals for one turn reuse its exact runtime cleanup promise.
  ACP returns the cancelled prompt response only after cancellation plus the
  generator runner drain reaches idle, or after the bounded isolation backstop
  retires that session.
- Teardown is retryable and preserves ownership by stage. A pending descendant
  drain keeps the exact DSH registry root live and is reused after a timeout;
  its handle cannot be disposed until that drain succeeds. Root fiber and boot
  workspace cleanup follow the same do-not-forget-ownership rule.
- Closed connections stop receiving request or elicitation routing at once,
  while their core cleanup records stay strongly owned. The app exposes a
  repeatable cleanup retry used by the CLI after its automatic bounded retries.
- Opening operations are connection-generation fenced. A cancelled or late
  open is closed instead of being published, and connection teardown performs
  a bounded drain before closing the driver.
- Permission requests are associated with the exact turn and tool call. Late responses cannot authorize stale work.
- Before activating a persisted session, the driver validates its exact policy
  events; it repeats the check on the actual returned handle. Forks validate
  the complete-turn seed before creation and the child handle afterwards. Only
  absent or exact `read-only`/`workspace-write` plus `ask` facts are adoptable;
  dangerous, unknown, and merge-extended shapes fail closed.
- A driver event that was not declared in its capability set fails the turn instead of being silently dropped.
- stdout is protocol-only in `serve` mode.

## Host integration

An ACP host should treat the adapter and DSH as separate identities:

1. Verify the adapter artifact checksum from its trusted distribution.
2. Run `inspect --json` against each logical DSH candidate.
3. Cache the logical install anchor but bind the returned physical checkout and runtime fingerprint for one launch.
4. Start `serve` with the logical path and expected fingerprint.
5. Complete a bounded ACP `initialize` handshake.
6. For a protected endpoint, independently pass the host's outer network/provider
   interception conformance. Fail closed until this gate succeeds because the
   adapter does not confine bash egress and ordinary tools need not ask ACP.
7. Include adapter digest, DSH fingerprint, driver version, negotiated ACP
   capabilities, and the protected-admission result in the host's runtime
   identity or cache key.

Detection alone is not readiness. The live ACP handshake proves protocol
connectivity; it does not by itself prove the host's protected admission.
