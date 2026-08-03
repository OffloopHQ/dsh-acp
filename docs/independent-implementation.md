# Independent implementation and provenance

This is an engineering provenance record, not a legal certification or a claim of strict personnel-isolated clean-room development.

## Implementation rule

Project code is written independently under MIT from protocol contracts, public APIs, local DSH layout validation, and observable interoperability behavior. No source, fixtures, comments, tests, or release scripts are copied or mechanically translated from reference adapters or DSH.

DSH itself remains outside this repository and is loaded only from a user installation after validation.

## Research inputs

The following snapshots were reviewed for protocol behavior, lifecycle failure modes, and distribution constraints:

| Source | Snapshot | Information used |
| --- | --- | --- |
| Agent Client Protocol specification repository | `e9003341d76315f1788ce021268e40ed7c4bb403` | public schemas and method semantics |
| ACP TypeScript SDK 1.3.0 | npm release | public SDK API and NDJSON transport |
| Zed `codex-acp` | `efa3789c3909838590f2f7cf24682ec4a0e987e4` | packaging shape and lifecycle checklist |
| Zed Rust `codex-acp` | `296069e841634cd4bb9bc4515602d836e49231ec` | cancellation, stale permission, and session-actor failure cases |
| `claude-agent-acp` | `faa04bd0cac40fcbf56742b8767721005efc30e5` | observable cancel and permission behavior |
| ACP registry | `27d86f56204f032ccf623c072fc5459ce522a332` | supported distribution/discovery schema |
| User-installed DSH `0.0.1` | local validated installation | package identity, layout, public boot surface, and black-box event behavior |

Reference adapter source is Apache-2.0 and remains outside this MIT repository. Ideas such as “late permission responses must not authorize a cancelled turn” are protocol safety requirements re-expressed in original types, state machines, and tests.

## Release review

Before each release:

1. Review the diff for copied or mechanically translated reference material.
2. Inspect the esbuild metafile or bundle contents for unexpected packages.
3. Regenerate and verify the SBOM and complete runtime license files.
4. Confirm no DSH or reference-adapter file appears in the npm tarball or release archive.
5. Run cancellation, stale-event, permission, transport, discovery, and driver tests.
6. Record any newly inspected source and exact snapshot in this document.
