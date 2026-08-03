import { chmod, copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { build } from "esbuild";

import { run } from "./lib/process.mjs";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const packageMetadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const dist = join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, "licenses"), { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: false,
  sourcemap: false,
  legalComments: "eof",
  define: { __DSH_ACP_VERSION__: JSON.stringify(packageMetadata.version) },
  logLevel: "info",
});
await chmod(join(dist, "index.js"), 0o755);

await run(
  process.execPath,
  [join(root, "node_modules/typescript/bin/tsc"), "--project", join(root, "scripts/tsconfig.build.json")],
  { cwd: root },
);

await copyFile(
  join(root, "node_modules/@agentclientprotocol/sdk/LICENSE"),
  join(dist, "licenses/agentclientprotocol-sdk-1.3.0-LICENSE.txt"),
);
await copyFile(
  join(root, "node_modules/zod/LICENSE"),
  join(dist, "licenses/zod-4.1.12-LICENSE.txt"),
);
