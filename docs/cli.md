# CLI contract

## Commands and streams

| Command | stdout | stderr | Success |
| --- | --- | --- | --- |
| `dsh-acp` or `serve` | ACP NDJSON frames only | redacted diagnostics | connection closes normally |
| `inspect --json` | exactly one JSON value plus newline | redacted diagnostics | inspection completed, including an `ok: false` result |
| `doctor --json` | exactly one JSON value plus newline | redacted diagnostics | doctor completed, including an `ok: false` result |
| `--version` | one version line | empty | version printed |
| `--help` | empty | usage | usage printed |

Exit codes are `0` for a completed command, `1` for a runtime failure, and `2` for invalid CLI usage. An incompatible or missing DSH reported as structured `inspect`/`doctor` JSON is a completed diagnostic command; consumers must inspect its `ok` field.

## Options

- `--dsh-path <path>` selects one logical launcher or source root. Without it, discovery checks `DSH_PATH`, the official `$DSH_HOME/source/current`, `~/.dsh/source/current`, `~/.local/bin/dsh`, and then PATH candidates.
- `--dsh-home <path>` supplies the DSH state/configuration home for this invocation.
- `--node <path>` fences the exact Node executable validated and used by `serve`. Because the current driver loads DSH in-process, its real path must equal `process.execPath`; callers must launch the adapter with that Node rather than naming a different executable.
- `--expected-runtime-fingerprint <sha256:...>` rejects a launch if the discovered DSH identity differs.

`--candidate` and `--dsh-root` are compatibility aliases for `--dsh-path`; they do not bind a runtime directly. Duplicate canonical/alias options are rejected.

## Inspection schema

Results are JSON-safe and begin with an `ok` boolean.

On success, `installation` includes the driver ID, logical and resolved entry paths, physical root, exact package/runtime versions, selected Node, DSH-owned tsx loader, validated file list, and runtime fingerprint. `attempts` records every candidate considered without exposing credentials.

On failure, `error.code` and `error.message` describe the fail-closed outcome and `attempts` contains per-candidate status. Codes and fields may be extended; consumers should key on `ok`, `error.code`, `installation.driverId`, and `installation.fingerprint` rather than parsing prose.

`doctor` wraps the inspection and adds named `pass`, `fail`, or `skip` checks for discovery, layout, Node, tsx, driver selection, and final fingerprint revalidation.

## Diagnostic safety

Serve-mode diagnostics never go to stdout. Diagnostic strings redact bearer values, sensitive assignments, JSON-shaped sensitive fields, URL query secrets, and URL passwords. Nested structured fields, item counts, recursion depth, strings, and total line length are bounded. This is defense in depth; callers must still avoid passing secrets in paths or CLI arguments.
