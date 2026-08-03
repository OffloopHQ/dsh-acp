import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { writeTarGzip } from "./lib/archive.mjs";
import { assertBunStandaloneManifest } from "./lib/bun-manifest.mjs";
import { run } from "./lib/process.mjs";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const releaseDir = join(root, "release");
const distDir = join(root, "dist");
const includeBunStandalone = process.env["DSH_ACP_INCLUDE_BUN_STANDALONE"] === "1";
const npmPackageNames = ["dsh-acp", "@offloophq/dsh-acp"];
const publicDocs = [
  "docs/architecture.md",
  "docs/bun-standalone-relinking.md",
  "docs/cli.md",
  "docs/compatibility.md",
  "docs/distribution.md",
  "docs/independent-implementation.md",
  "docs/npm-publishing.md",
  "docs/licenses/BUN-1.3.13-LICENSE.md",
];

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function checkedFile(relativePath) {
  const candidate = resolve(root, relativePath);
  const fromRoot = relative(root, candidate);
  if (fromRoot === "" || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromRoot)) {
    throw new Error(`release input escapes the repository: ${relativePath}`);
  }
  const metadata = await lstat(candidate);
  if (!metadata.isFile()) throw new Error(`release input is not a regular file: ${relativePath}`);
  return { path: candidate, metadata };
}

async function sourceEpoch() {
  const configured = process.env["SOURCE_DATE_EPOCH"];
  if (configured !== undefined) {
    const parsed = Number.parseInt(configured, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("invalid SOURCE_DATE_EPOCH");
    return parsed;
  }
  try {
    const value = (await run("git", ["show", "-s", "--format=%ct", "HEAD"], {
      cwd: root,
      capture: true,
      quiet: true,
    })).trim();
    const parsed = Number.parseInt(value, 10);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  } catch {
    // A fixed development fallback keeps local packages reproducible before
    // the private repository has its first commit.
  }
  return 1_704_067_200;
}

function sortByReference(values) {
  return values.sort((left, right) => {
    const leftKey = left["bom-ref"] ?? left.name ?? left.ref ?? "";
    const rightKey = right["bom-ref"] ?? right.name ?? right.ref ?? "";
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function normalizeSbom(sbom, epoch, packageMetadata) {
  delete sbom.serialNumber;
  if (sbom.metadata !== undefined) {
    sbom.metadata.timestamp = new Date(epoch * 1_000).toISOString();
    if (sbom.metadata.component !== undefined) {
      // npm derives the root display name from the checkout directory. Bind it
      // to package identity so identical source produces identical SBOM output
      // in a worktree, CI checkout, or extracted source archive.
      sbom.metadata.component.name = packageMetadata.name;
      sbom.metadata.component.version = packageMetadata.version;
    }
  }
  if (Array.isArray(sbom.components)) sortByReference(sbom.components);
  if (Array.isArray(sbom.dependencies)) {
    for (const dependency of sbom.dependencies) {
      if (Array.isArray(dependency.dependsOn)) dependency.dependsOn.sort();
    }
    sortByReference(sbom.dependencies);
  }
  return sbom;
}

function includeBunInSbom(sbom) {
  const bunReference = "pkg:github/oven-sh/bun@bun-v1.3.13";
  sbom.components ??= [];
  sbom.components.push({
    type: "application",
    name: "bun",
    version: "1.3.13",
    scope: "required",
    "bom-ref": bunReference,
    purl: bunReference,
    externalReferences: [
      { type: "vcs", url: "https://github.com/oven-sh/bun/tree/bun-v1.3.13" },
      { type: "license", url: "https://github.com/oven-sh/bun/blob/bun-v1.3.13/LICENSE.md" },
    ],
    properties: [
      { name: "dsh-acp:distribution", value: "experimental-standalone-runtime" },
      { name: "dsh-acp:license-review", value: "required-before-public-distribution" },
    ],
  });
  const rootReference = sbom.metadata?.component?.["bom-ref"];
  const rootDependency = Array.isArray(sbom.dependencies)
    ? sbom.dependencies.find((dependency) => dependency.ref === rootReference)
    : undefined;
  if (rootDependency !== undefined) {
    rootDependency.dependsOn ??= [];
    rootDependency.dependsOn.push(bunReference);
  }
  sbom.dependencies ??= [];
  sbom.dependencies.push({ ref: bunReference, dependsOn: [] });
  sortByReference(sbom.components);
  sortByReference(sbom.dependencies);
  if (Array.isArray(rootDependency?.dependsOn)) rootDependency.dependsOn.sort();
}

let binaryManifest;
if (includeBunStandalone) {
  if (process.env["DSH_ACP_BUN_LICENSE_REVIEW_ACK"] !== "reviewed") {
    throw new Error("Bun standalone packaging requires DSH_ACP_BUN_LICENSE_REVIEW_ACK=reviewed");
  }
  binaryManifest = assertBunStandaloneManifest(
    JSON.parse(await readFile(join(distDir, "bin/manifest.json"), "utf8")),
  );
  const bundleHash = await sha256(join(distDir, "index.js"));
  if (binaryManifest.bundle?.sha256 !== bundleHash) {
    throw new Error("Bun standalone manifest does not match the current portable bundle");
  }
  for (const binary of binaryManifest.binaries) {
    const source = await checkedFile(binary.file);
    if (source.metadata.size !== binary.size || await sha256(source.path) !== binary.sha256) {
      throw new Error(`Bun standalone binary does not match its manifest: ${binary.target}`);
    }
  }
} else {
  await run(process.execPath, [join(root, "scripts/build.mjs")], { cwd: root });
}
await rm(releaseDir, { recursive: true, force: true });
await mkdir(releaseDir, { recursive: true });

const epoch = await sourceEpoch();
const prefix = `dsh-acp-${metadata.version}-node`;
const portableArchive = join(releaseDir, `${prefix}.tar.gz`);
await writeTarGzip(
  portableArchive,
  [
    { name: `${prefix}/dsh-acp`, path: join(distDir, "index.js"), mode: 0o755 },
    { name: `${prefix}/README.md`, path: join(root, "README.md") },
    { name: `${prefix}/LICENSE`, path: join(root, "LICENSE") },
    { name: `${prefix}/THIRD_PARTY_NOTICES.md`, path: join(root, "THIRD_PARTY_NOTICES.md") },
    {
      name: `${prefix}/licenses/agentclientprotocol-sdk-1.3.0-LICENSE.txt`,
      path: join(distDir, "licenses/agentclientprotocol-sdk-1.3.0-LICENSE.txt"),
    },
    {
      name: `${prefix}/licenses/zod-4.1.12-LICENSE.txt`,
      path: join(distDir, "licenses/zod-4.1.12-LICENSE.txt"),
    },
    ...publicDocs.map((name) => ({ name: `${prefix}/${name}`, path: join(root, name) })),
  ],
  epoch,
);

let npmPack;
const stagedBin = join(root, ".dsh-acp-bun-bin-staging");
if (includeBunStandalone) await rename(join(distDir, "bin"), stagedBin);
try {
  npmPack = JSON.parse(
    await run("npm", ["pack", "--json", "--pack-destination", releaseDir], {
      cwd: root,
      capture: true,
    }),
  );
} finally {
  if (includeBunStandalone) await rename(stagedBin, join(distDir, "bin"));
}
if (!Array.isArray(npmPack) || typeof npmPack[0]?.filename !== "string") {
  throw new Error("npm pack did not report an output filename");
}
if (metadata.name !== npmPackageNames[0] || npmPack[0].filename !== `dsh-acp-${metadata.version}.tgz`) {
  throw new Error("canonical npm package identity does not match dsh-acp");
}

const aliasRoot = await mkdtemp(join(tmpdir(), "dsh-acp-npm-alias-"));
try {
  await run("tar", ["-xzf", join(releaseDir, npmPack[0].filename), "-C", aliasRoot], { cwd: root });
  const aliasPackageRoot = join(aliasRoot, "package");
  const aliasPackagePath = join(aliasPackageRoot, "package.json");
  const aliasMetadata = JSON.parse(await readFile(aliasPackagePath, "utf8"));
  aliasMetadata.name = npmPackageNames[1];
  await writeFile(aliasPackagePath, `${JSON.stringify(aliasMetadata, null, 2)}\n`);
  const aliasPack = JSON.parse(
    await run("npm", ["pack", "--json", "--pack-destination", releaseDir], {
      cwd: aliasPackageRoot,
      capture: true,
    }),
  );
  if (!Array.isArray(aliasPack) || aliasPack[0]?.filename !== `offloophq-dsh-acp-${metadata.version}.tgz`) {
    throw new Error("scoped npm mirror did not report the expected output filename");
  }
} finally {
  await rm(aliasRoot, { recursive: true, force: true });
}

const rawSbom = JSON.parse(
  await run(
    "npm",
    [
      "sbom",
      "--package-lock-only",
      "--omit=dev",
      "--sbom-format=cyclonedx",
      "--sbom-type=application",
    ],
    { cwd: root, capture: true },
  ),
);
const sbom = normalizeSbom(rawSbom, epoch, metadata);
if (includeBunStandalone) includeBunInSbom(sbom);
await writeFile(join(releaseDir, `dsh-acp-${metadata.version}.cdx.json`), `${JSON.stringify(sbom, null, 2)}\n`);

const buildManifest = {
  schemaVersion: 1,
  name: metadata.name,
  version: metadata.version,
  npmPackages: npmPackageNames,
  sourceDateEpoch: epoch,
  runtime: { kind: "portable-node-bundle", nodeRange: "^22.19.0 || >=24.0.0" },
  bundle: {
    path: "dist/index.js",
    size: (await stat(join(distDir, "index.js"))).size,
    sha256: await sha256(join(distDir, "index.js")),
  },
  lockfileSha256: await sha256(join(root, "package-lock.json")),
  ...(includeBunStandalone ? { experimentalBunStandalone: binaryManifest } : {}),
};
await writeFile(
  join(releaseDir, `dsh-acp-${metadata.version}.build.json`),
  `${JSON.stringify(buildManifest, null, 2)}\n`,
);

if (includeBunStandalone) {
  for (const binary of binaryManifest.binaries) {
    const binaryPath = (await checkedFile(binary.file)).path;
    const binaryName = binary.file.endsWith(".exe") ? "dsh-acp.exe" : "dsh-acp";
    const binaryPrefix = `dsh-acp-${metadata.version}-${binary.target}`;
    await writeTarGzip(
      join(releaseDir, `${binaryPrefix}.tar.gz`),
      [
        { name: `${binaryPrefix}/${binaryName}`, path: binaryPath, mode: 0o755 },
        { name: `${binaryPrefix}/dsh-acp.bundle.js`, path: join(distDir, "index.js"), mode: 0o644 },
        { name: `${binaryPrefix}/README.md`, path: join(root, "README.md") },
        { name: `${binaryPrefix}/LICENSE`, path: join(root, "LICENSE") },
        { name: `${binaryPrefix}/THIRD_PARTY_NOTICES.md`, path: join(root, "THIRD_PARTY_NOTICES.md") },
        {
          name: `${binaryPrefix}/BUN-1.3.13-LICENSE.md`,
          path: join(root, "docs/licenses/BUN-1.3.13-LICENSE.md"),
        },
        {
          name: `${binaryPrefix}/BUN-STANDALONE-RELINKING.md`,
          path: join(root, "docs/bun-standalone-relinking.md"),
        },
        {
          name: `${binaryPrefix}/licenses/agentclientprotocol-sdk-1.3.0-LICENSE.txt`,
          path: join(distDir, "licenses/agentclientprotocol-sdk-1.3.0-LICENSE.txt"),
        },
        {
          name: `${binaryPrefix}/licenses/zod-4.1.12-LICENSE.txt`,
          path: join(distDir, "licenses/zod-4.1.12-LICENSE.txt"),
        },
        ...publicDocs
          .filter((name) => name !== "docs/licenses/BUN-1.3.13-LICENSE.md")
          .map((name) => ({ name: `${binaryPrefix}/${name}`, path: join(root, name) })),
      ],
      epoch,
    );
  }
  await copyFile(join(distDir, "bin/manifest.json"), join(releaseDir, "bun-standalone-manifest.json"));
}

const assets = (await readdir(releaseDir)).filter((name) => name !== "SHA256SUMS").sort();
const checksumLines = [];
for (const name of assets) checksumLines.push(`${await sha256(join(releaseDir, name))}  ${name}`);
await writeFile(join(releaseDir, "SHA256SUMS"), `${checksumLines.join("\n")}\n`);
