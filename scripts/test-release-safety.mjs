import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertBunStandaloneManifest,
  BUN_REVISION,
  BUN_TARGETS,
  BUN_VERSION,
} from "./lib/bun-manifest.mjs";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const releaseWorkflow = await readFile(join(root, ".github/workflows/release.yml"), "utf8");
assert(
  releaseWorkflow.includes('"$GITHUB_WORKSPACE/release/dsh-acp-${package_version}.tgz"'),
  "release workflow must install the canonical npm archive by absolute path",
);
assert(
  releaseWorkflow.includes('"$GITHUB_WORKSPACE/release/offloophq-dsh-acp-${package_version}.tgz"'),
  "release workflow must install the scoped npm archive by absolute path",
);

function validManifest() {
  return {
    schemaVersion: 1,
    experimental: true,
    bundle: { file: "dist/index.js", sha256: "a".repeat(64) },
    binaries: BUN_TARGETS.map((target) => ({
      target: target.id,
      bunTarget: target.bunTarget,
      bunVersion: BUN_VERSION,
      bunRevision: BUN_REVISION,
      signature: target.signatures[0],
      file: `dist/bin/dsh-acp-${target.id}${target.extension}`,
      size: 1,
      sha256: "b".repeat(64),
    })),
  };
}

assert.equal(assertBunStandaloneManifest(validManifest()).binaries.length, 6);

for (const mutate of [
  (manifest) => { manifest.binaries[0].target = "../../../../../dsh-acp-escape-proof"; },
  (manifest) => { manifest.binaries[0].bunTarget = "not-a-reviewed-target"; },
  (manifest) => { manifest.binaries[0].signature = "not-signed"; },
  (manifest) => { manifest.binaries[0].file = "/private/tmp/dsh-acp-escape-proof"; },
  (manifest) => { manifest.binaries.pop(); },
  (manifest) => { manifest.binaries[0].unreviewed = true; },
]) {
  const manifest = validManifest();
  mutate(manifest);
  assert.throws(() => assertBunStandaloneManifest(manifest));
}

process.stdout.write("release manifest safety checks passed\n");
