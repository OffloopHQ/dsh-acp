# dsh-acp contributor rules

`dsh-acp` is an independent, client-neutral ACP adapter for DeepSeek Harness.

- Keep every tracked source, test, workflow, and document client-neutral. Do
  not name or encode a downstream ACP host; host-specific discovery,
  packaging, policy, and protected-admission contracts belong downstream.
  Keep the canonical branch history client-neutral as well.
- New project code is MIT-licensed. Do not copy source, fixtures, comments, or
  release scripts from Apache-2.0 reference adapters; use the ACP specification
  and observable behavior as clean-room inputs.
- In `serve` mode, keep stdout reserved for ACP JSON-RPC frames. Explicit
  `inspect --json`, `doctor --json`, and `--version` modes may emit only their
  documented machine/version output. Diagnostics belong on stderr and must
  never contain credentials.
- The ACP layer owns protocol, session, cancellation, permission, and event
  semantics. Versioned runtime drivers are the only layer allowed to depend on
  DSH internals.
- Discover and validate a user-installed DSH runtime without downloading or
  modifying it. Unknown versions or layouts fail closed.
- Compose each DSH boot in an adapter-owned temporary configuration directory.
  Never boot, patch, or persist through the user's DSH source configuration;
  force the reviewed `workspace-write` sandbox and `ask` approval defaults so
  personal configuration cannot widen adapter authority.
- Treat DSH session policy events as adoption authority. Before load/resume,
  before using a fork seed, and before publishing any new or resumed handle,
  accept only exact `read-only`/`workspace-write` plus `ask` facts from the
  reviewed event shapes; reject dangerous, unknown, or merge-extended facts.
- Keep DSH `0.0.1`'s shipped `repository-plugins`, `web`,
  `web-search-deepseek`, `tool-web`, and `telemetry-otel` rows disabled in the
  adapter-final boot layer. Reject a settled global web service or a
  `web_search`/`web_fetch` catalog entry.
- Do not describe `workspace-write` as process-wide egress isolation. It is a
  file-write boundary; DSH bash/execute calls may still reach the network and
  ordinary tools do not necessarily emit `approval/request`. Model transport,
  ACP-explicit MCP, and client-side protected admission are separate gates.
- Treat `installation.validatedFiles` as the explicit reviewed compatibility
  seam. Its fingerprint is a drift fence, not a complete dynamic-plugin or
  supply-chain attestation; update the list and focused tests when a driver
  starts importing a new DSH, MCP SDK, loader, permission, subprocess,
  sandbox/filesystem/command enforcement, or network-provider seam.
- Projected DSH tool/event data is untrusted diagnostic output. Redact
  provider-prefixed credentials, nested secret fields, Bearer/provider tokens,
  private keys, and secret-shaped object keys before emitting ACP updates.
  Apply a per-event serialized-byte limit before both direct waiter delivery
  and queueing; approval reasons must use the same bounded redacted projection.
- Settle an in-flight prompt before invoking DSH's fallible synchronous cancel
  seam. A cancel failure retires that session until close retries cleanup, and
  cancellation drain must fence new prompts. Repeated cancel calls for one
  turn share the exact cleanup promise, and ACP must not return the cancelled
  prompt response before that cleanup plus runner drain settles or its bounded
  isolation backstop fires. Abort listeners around `steer` must be armed and
  rechecked across the synchronous DSH call.
- Advertise only capabilities implemented by the selected runtime driver.
- Keep durable session discovery scoped to the driver's effective workspace;
  foreign-cwd list requests return no metadata. Validate and bound every DSH
  history/title snapshot before replay, fork, or list projection.
- ACP-configured stdio and HTTP MCP servers are installed in the exact DSH
  agent scope and disposed with that scope. Keep SSE disabled until its DSH
  transport is implemented and tested. Stdio child stderr must stay piped and
  continuously drained through bounded, secret-redacted diagnostics; never
  restore the MCP SDK's ambient `inherit` default.
- The portable Node archive is the authoritative release artifact. Bun
  standalone output is a compile-only experiment until in-process DSH hosting,
  licensing, signing, and platform validation all pass.
- `dsh-acp` is the canonical public npm identity and
  `@offloophq/dsh-acp` is its scoped mirror. Every release must publish the
  same version and exact non-metadata payload under both names, reconcile an
  already-published version by exact registry integrity, and fail closed on a
  mismatch. Build and verify once without OIDC; only the minimal downstream
  publish job may receive `id-token: write`.
- Pass local npm release archives by absolute path (or an explicit `./` path).
  A bare `release/...tgz` argument is parsed by npm as GitHub shorthand rather
  than as a repository-local tarball.
- While the private repository plan lacks GitHub Environments and tag rulesets,
  releases require actor ID `22412638`, an annotated exact-version tag, and a
  peeled commit already contained by `main`. The npm Trusted Publisher
  environment claim stays empty until both package bindings and the workflow
  are deliberately migrated together. The actor check is an operational
  accident guard, not authority separation from repository administrators;
  under this plan every administrator who can change `main` remains part of
  the release trust boundary.
- Every behavior change needs focused tests, including cancellation and stale
  event fencing where applicable.
- A client abandoning an async prompt generator must keep the session fenced
  until the DSH turn reaches idle. An unmappable live event retires that
  session generation even when defensive cancellation succeeds.
- A closed ACP connection leaves elicitation routing immediately, but failed
  core teardown remains strongly owned and reachable through app-level cleanup
  retries. CLI shutdown must use that owner instead of bypassing it with a raw
  driver close.
- Teardown must retain exact ownership across retries. Do not dispose a DSH
  registry root before its descendant drain succeeds; reuse an in-flight drain
  after timeout and retry a rejected drain while that exact root remains live.
- Use English commit messages.
