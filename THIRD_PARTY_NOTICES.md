# Third-party notices

The original `dsh-acp` project code is licensed under MIT; see `LICENSE`.

The portable JavaScript and npm artifacts bundle the following runtime dependencies:

| Component | Version | License | Full text in artifact |
| --- | --- | --- | --- |
| `@agentclientprotocol/sdk` | 1.3.0 | Apache-2.0 | `dist/licenses/agentclientprotocol-sdk-1.3.0-LICENSE.txt` |
| `zod` | 4.1.12 | MIT | `dist/licenses/zod-4.1.12-LICENSE.txt` |

The build fails if either required license file is missing. The npm package includes them beneath `dist/licenses/`, and release archives include the same complete texts.

esbuild, TypeScript, tsx, and Vitest are build or test tools and are not included as runtime code in the portable adapter artifact.

## Experimental Bun standalone artifacts

An opt-in standalone build embeds Bun 1.3.13 and its linked runtime components. Bun itself is MIT-licensed, but its official license notice documents statically linked LGPL-2 JavaScriptCore/WebKit, LGPL-2.1 TinyCC, and other components under their respective licenses. Each experimental archive includes the exact Bun 1.3.13 `LICENSE.md`, the portable JavaScript bundle used as compiler input, and the project's relinking note.

Those files do not by themselves establish that a public binary distribution satisfies every LGPL object, source-offer, and relinking obligation. Standalone artifacts are excluded from the default release until the distribution plan has been reviewed and explicitly approved.

## Not distributed

DeepSeek Harness is discovered on the user's device. This project does not copy, modify, package, or redistribute DSH code or binaries. DSH remains governed by its own terms.

Reference ACP adapters were inspected only for interoperability research. Their Apache-2.0 source, tests, comments, fixtures, and release scripts are not included in this project. See `docs/independent-implementation.md`.
