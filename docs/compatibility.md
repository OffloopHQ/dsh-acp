# Compatibility

Unlisted DSH versions and layouts are unsupported and fail closed.

## DSH source driver

| Driver | DSH packages | Node | tsx | Status |
| --- | --- | --- | --- | --- |
| `dsh-source-0.0.1` | `@deepseek-ai/dsh-root@0.0.1`, `@deepseek-ai/dsh@0.0.1` | `^22.19.0` or `>=24.0.0` | `4.x` from the DSH installation | implemented |

The driver records a `sha256:` fingerprint of a reviewed compatibility seam: its direct DSH imports plus critical app-boot, vendored Loader/Include, tool admission, concrete sandbox/bash/filesystem/subprocess enforcement, persistence/query, repository loading, credentials, configured LLM and web providers, and MCP client/SDK transport files. On Linux it also includes the installed architecture-specific Landlock launcher package and binary; a missing or unknown package layout fails discovery. Equivalent seam content produces the same fingerprint across install paths on the same runtime target. Any symlink repoint, selected seam content change, Node identity change, or tsx identity change after inspection is rejected before boot.

The seam fingerprint is a drift and compatibility fence, not a complete source-tree hash or supply-chain attestation. Cordis can load dynamic plugins and transitive dependencies outside the reviewed list; those files are not implicitly covered. `installation.validatedFiles` is the machine-readable authority for the exact list used by a release. Callers must separately verify the adapter artifact and use an approved DSH distribution when provenance matters.

The version check is package-and-layout based. A modified checkout that still declares the supported package versions is accepted only as a distinct fingerprint; callers that require an immutable approved build must compare `--expected-runtime-fingerprint` with an allowlisted value.

## ACP capability surface

| Area | Current support |
| --- | --- |
| Prompt content | text and resource links; resource links are normalized into the DSH text prompt |
| Agent updates | committed message, thought, tool lifecycle, plan, session info, usage |
| Sessions | new, load with replay, resume without replay, complete-turn fork, workspace-scoped cursor list, and close |
| Cancellation | exact in-flight turn, request abort, and connection cleanup |
| Steering | supported when the live DSH agent admits it |
| Permissions | one-shot approve/reject/cancel when DSH emits `approval/request`; not a universal pre-execution gate |
| Built-in web tools | DSH repository plugins, credential-backed web search/fetch, and telemetry are disabled and verified absent after boot |
| Shell network | not isolated by `workspace-write`; bash/execute may use host networking without an ACP permission request |
| Session delete | not advertised |
| Images and embedded context | not advertised |
| MCP injection | stdio and Streamable HTTP implemented; SSE is unsupported and fails closed |
| Authentication and provider management | not advertised; DSH owns its installed credential/configuration path |
| Elicitation | not advertised |

DSH features absent from this table are not implied by the existence of a similarly named internal service. Capabilities change only with a driver and test update.

The initialize capability metadata publishes the same limitation under
`offloop.dsh-acp.security`: built-in network tools are absent, process network
isolation is false, permission admission is `dsh-emitted-only`, and protected
admission cannot be derived from initialize. Clients must fail closed rather
than infer a stronger boundary from `permissions: true`.

Stdio MCP uses the reviewed DSH environment scrub with the pinned MCP SDK
transport configured as `stderr: pipe`. The adapter attaches its drain before
the child starts, redacts credential-shaped text, limits one forwarded line to
4 KiB, and limits one server generation to 64 lines and 64 KiB total while
continuing to consume discarded output so a noisy child cannot block on its
stderr pipe. Raw child stderr is never inherited by the adapter process.

`session/list` exposes only sessions whose persisted cwd equals the adapter's
effective DSH workspace root. An explicit foreign cwd returns an empty page so
one workspace cannot enumerate another workspace's metadata. Pages contain at
most 50 rows and use a versioned cursor bound to the filtered snapshot; callers
must restart without a cursor after a stale-corpus error.

`session/load` replays supported committed history in persisted order, including
direct user and steering text. `session/resume` restores the durable DSH session
without replay. `session/fork` copies only the prefix through the final complete
`turn/end`, creates a new session ID, and records parent/seed lineage. A source
owned by this connection may be forked only while its DSH agent is idle; a live
foreign owner and a busy source fail closed.

Session policy is part of adoption validation, not trusted historical metadata.
Before load/resume activates DSH, before a complete-turn fork seed is passed to
DSH, and again on every actual handle returned by new/resume/fork, the driver
accepts only absent facts or exact `permission/preset`, `sandbox/mode`, and
`approval/policy` events whose values are no broader than `read-only` or
`workspace-write` with `ask`. `danger-full-access`, `never`, unknown values,
extra event/data fields, and invalid initial pinning order fail closed.

Untrusted DSH history is bounded before replay, fork, or list projection: at
most 20,000 events, 1 MiB per serialized event, 16 MiB per snapshot, 4 KiB per
title, 20,000 list records, and 16 MiB across the raw serialized session list.
Headers must use DSH session schema version `0`, event sequence
numbers must be contiguous, and snapshots must be losslessly JSON-serializable.
An oversized or merge-incompatible record fails closed instead of being partly
projected.

Every live ACP runtime event is serialized and limited to 1 MiB before either
direct waiter delivery or queueing; the 8 MiB queue cap remains a separate
aggregate backpressure fence. DSH approval reasons are secret-redacted and
limited to 1 KiB before they can enter ACP `_meta`.

The disabled built-in web surface prevents DSH from silently consuming the
user's local search credential through `web_search` or exposing `web_fetch`.
It is not a process egress sandbox: the selected model transport and
ACP-explicit MCP are separate intended network paths, and shell networking
depends on the host. A client that requires protected network admission must
enforce and test that boundary outside this `0.0.1` driver; successful ACP
initialization is insufficient evidence.

## Platform status

The authoritative default artifact is a portable Node.js bundle. Platform compatibility therefore requires a supported Node executable and a DSH source installation matching the table above.

Six Bun standalone targets can be built experimentally (Linux/macOS/Windows on x86_64 and arm64), but they are not default distributed artifacts pending license review. A successful cross-compile is not a claim that the DSH runtime itself has been validated on every target.
