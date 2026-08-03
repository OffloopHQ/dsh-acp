import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  assertBunStandaloneManifest,
  BUN_REVISION,
  BUN_TARGETS,
  BUN_VERSION,
} from "./lib/bun-manifest.mjs";
import { run } from "./lib/process.mjs";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const bun = process.env["DSH_ACP_BUN"] ?? "bun";
const bunEnvironment = { ...process.env };
delete bunEnvironment["BUN_BE_BUN"];
delete bunEnvironment["BUN_OPTIONS"];

if (process.env["DSH_ACP_ENABLE_BUN_STANDALONE"] !== "1") {
  throw new Error(
    "Bun standalone builds are an opt-in experiment pending LGPL/JSC distribution review; set DSH_ACP_ENABLE_BUN_STANDALONE=1 to build locally",
  );
}

await run(process.execPath, [join(root, "scripts/build.mjs")], { cwd: root });
if ((await run(bun, ["--version"], { cwd: root, capture: true, env: bunEnvironment })).trim() !== BUN_VERSION) {
  throw new Error(`expected Bun ${BUN_VERSION}`);
}
if ((await run(bun, ["--revision"], { cwd: root, capture: true, env: bunEnvironment })).trim() !== BUN_REVISION) {
  throw new Error(`expected Bun revision ${BUN_REVISION}`);
}

const outputDir = join(root, "dist/bin");
const runtimeDir = join(root, "dist/.bun-runtimes");
await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
await mkdir(runtimeDir, { recursive: true });

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function exactRuntime(target) {
  const zipPath = join(runtimeDir, `${target.asset}.zip`);
  const response = await fetch(
    `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${target.asset}.zip`,
  );
  if (!response.ok) throw new Error(`failed to download ${target.asset}: HTTP ${response.status}`);
  await writeFile(zipPath, Buffer.from(await response.arrayBuffer()));
  const actual = await sha256(zipPath);
  if (actual !== target.archiveSha256) {
    throw new Error(`Bun runtime checksum mismatch for ${target.asset}: ${actual}`);
  }
  const extracted = join(runtimeDir, target.asset);
  await run("unzip", ["-q", "-o", zipPath, "-d", runtimeDir], { cwd: root });
  return join(extracted, target.extension === ".exe" ? "bun.exe" : "bun");
}

const manifest = [];
for (const target of BUN_TARGETS) {
  const runtime = await exactRuntime(target);
  const output = join(outputDir, `dsh-acp-${target.id}${target.extension ?? ""}`);
  await run(
    bun,
    [
      "build",
      join(root, "dist/index.js"),
      "--compile",
      `--target=${target.bunTarget}`,
      `--compile-executable-path=${runtime}`,
      `--outfile=${output}`,
      "--packages=bundle",
      // DSH modules are intentionally selected from a validated installation
      // at runtime, so these three opaque import() specifiers must remain.
      "--allow-unresolved=",
      "--minify",
      "--sourcemap=none",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--no-compile-autoload-tsconfig",
      "--no-compile-autoload-package-json",
    ],
    { cwd: root, env: bunEnvironment },
  );
  if (target.extension !== ".exe") await chmod(output, 0o755);
  let signature = "not-applicable";
  if (target.id.endsWith("-apple-darwin")) {
    if (process.platform === "darwin") {
      // Bun appends the compiled payload after its runtime's original code
      // signature. Re-seal the resulting Mach-O so macOS will execute it.
      await run("codesign", ["--force", "--sign", "-", output], { cwd: root });
      signature = "ad-hoc";
    } else {
      signature = "required-before-execution";
    }
  }
  const metadata = await stat(output);
  manifest.push({
    target: target.id,
    bunTarget: target.bunTarget,
    bunVersion: BUN_VERSION,
    bunRevision: BUN_REVISION,
    signature,
    file: output.slice(root.length + 1),
    size: metadata.size,
    sha256: await sha256(output),
  });
}
await rm(runtimeDir, { recursive: true, force: true });
const outputManifest = {
  schemaVersion: 1,
  experimental: true,
  bundle: {
    file: "dist/index.js",
    sha256: await sha256(join(root, "dist/index.js")),
  },
  binaries: manifest,
};
assertBunStandaloneManifest(outputManifest);
await writeFile(join(outputDir, "manifest.json"), `${JSON.stringify(outputManifest, null, 2)}\n`);
