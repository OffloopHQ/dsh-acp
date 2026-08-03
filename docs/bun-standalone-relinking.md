# Bun standalone relinking note

Status: experimental documentation; not an approval for public distribution.

The optional standalone executable embeds Bun 1.3.13. Bun's official `LICENSE.md` states that Bun statically links LGPL-2 JavaScriptCore/WebKit and describes rebuilding Bun with a modified WebKit checkout. It also inventories other linked libraries.

Every experimental `dsh-acp` binary archive therefore includes:

- the exact portable `dsh-acp.bundle.js` used as Bun compiler input;
- the original project MIT license;
- complete ACP SDK and Zod license texts;
- Bun 1.3.13's exact `LICENSE.md`;
- this note and target/build hashes.

The adapter bundle can be modified without access to the private TypeScript source. A reviewer can obtain Bun `bun-v1.3.13`, follow Bun's documented WebKit/JSC rebuild procedure, and compile the modified adapter bundle with the rebuilt Bun toolchain.

That practical material is included to support review; the project does not assert that it is sufficient for every applicable LGPL obligation. Before distributing standalone binaries outside the approved private audience, owners must determine and record:

1. the exact corresponding Bun/WebKit source offer and retention period;
2. whether additional application object or relinking material is required;
3. the complete native third-party license set for every target;
4. the exact reproducible rebuild/relink procedure and verification evidence;
5. who owns ongoing source requests and license updates.

Until that record is approved, the portable Node bundle is the release authority.
