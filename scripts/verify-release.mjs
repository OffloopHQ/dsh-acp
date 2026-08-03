import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { run } from "./lib/process.mjs";
import { assertBunStandaloneManifest, BUN_TARGETS } from "./lib/bun-manifest.mjs";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const releaseDir = join(root, "release");
const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const lockfile = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
const publicDocs = [
  "docs/architecture.md",
  "docs/bun-standalone-relinking.md",
  "docs/cli.md",
  "docs/compatibility.md",
  "docs/distribution.md",
  "docs/independent-implementation.md",
  "docs/licenses/BUN-1.3.13-LICENSE.md",
];
const NPM_ARCHIVE_MTIME = 499_162_500;

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256(path) {
  return sha256Bytes(await readFile(path));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function exactJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function licenseIds(component) {
  return (component?.licenses ?? [])
    .map((entry) => entry?.license?.id)
    .filter((id) => typeof id === "string")
    .sort();
}

async function tarMembers(archive) {
  const listing = await run("tar", ["-tzf", archive], { cwd: root, capture: true });
  return listing.trimEnd().split("\n").filter(Boolean).sort();
}

async function tarMember(archive, member) {
  return run("tar", ["-xOzf", archive, member], { cwd: root, capture: true });
}

function tarOctal(header, offset, length, label) {
  const encoded = header.subarray(offset, offset + length).toString("ascii")
    .replaceAll("\0", "").trim();
  assert(/^[0-7]+$/u.test(encoded), `invalid ${label} in deterministic tar header`);
  return Number.parseInt(encoded, 8);
}

async function deterministicTarEntries(archive) {
  const compressed = await readFile(archive);
  assert(compressed.subarray(4, 8).every((byte) => byte === 0), "gzip header mtime is not zero");
  const payload = gunzipSync(compressed);
  const entries = [];
  let offset = 0;
  while (offset + 512 <= payload.length) {
    const header = payload.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const shortName = header.subarray(0, 100).toString("utf8").split("\0", 1)[0];
    const prefix = header.subarray(345, 500).toString("utf8").split("\0", 1)[0];
    const name = prefix.length === 0 ? shortName : `${prefix}/${shortName}`;
    assert(name.length > 0, "deterministic tar contains an empty member name");
    const type = String.fromCharCode(header[156]);
    assert(type === "0", `deterministic tar member ${name} is not a regular file`);
    const size = tarOctal(header, 124, 12, `${name} size`);
    entries.push({
      name,
      mode: tarOctal(header, 100, 8, `${name} mode`),
      mtime: tarOctal(header, 136, 12, `${name} mtime`),
      size,
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert(payload.subarray(offset).every((byte) => byte === 0), "deterministic tar has non-zero trailing data");
  return entries;
}

async function filesBelow(directory, prefix = "") {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) output.push(...await filesBelow(join(directory, entry.name), relative));
    else if (entry.isFile()) output.push(relative);
    else throw new Error(`unexpected non-file build output: ${relative}`);
  }
  return output.sort();
}

function assertExactMembers(actual, expected, label) {
  assert(
    actual.join("\n") === [...expected].sort().join("\n"),
    `${label} member set does not match the reviewed release layout`,
  );
}

const checksumText = await readFile(join(releaseDir, "SHA256SUMS"), "utf8");
const expectedChecksums = new Map();
for (const line of checksumText.trimEnd().split("\n")) {
  const match = /^([a-f0-9]{64})  ([^/]+)$/.exec(line);
  if (match === null) throw new Error(`invalid checksum line: ${line}`);
  if (expectedChecksums.has(match[2])) throw new Error(`duplicate checksum entry: ${match[2]}`);
  expectedChecksums.set(match[2], match[1]);
}

const version = metadata.version;
const npmBaseName = metadata.name.replace(/^@/, "").replaceAll("/", "-");
const portableName = `dsh-acp-${version}-node.tar.gz`;
const npmName = `${npmBaseName}-${version}.tgz`;
const sbomName = `dsh-acp-${version}.cdx.json`;
const buildManifestName = `dsh-acp-${version}.build.json`;
const bunManifestName = "bun-standalone-manifest.json";
const assets = (await readdir(releaseDir)).filter((name) => name !== "SHA256SUMS").sort();

let bunManifest;
if (assets.includes(bunManifestName)) {
  bunManifest = assertBunStandaloneManifest(
    JSON.parse(await readFile(join(releaseDir, bunManifestName), "utf8")),
  );
}

const expectedAssets = [portableName, npmName, sbomName, buildManifestName];
if (bunManifest !== undefined) {
  expectedAssets.push(bunManifestName);
  for (const binary of bunManifest.binaries) {
    assert(typeof binary.target === "string" && binary.target.length > 0, "invalid Bun target");
    expectedAssets.push(`dsh-acp-${version}-${binary.target}.tar.gz`);
  }
}
assert(
  assets.join("\n") === expectedAssets.sort().join("\n"),
  "release directory does not contain the exact reviewed asset set",
);
assert(
  assets.join("\n") === [...expectedChecksums.keys()].sort().join("\n"),
  "SHA256SUMS does not cover the exact release asset set",
);
for (const name of assets) {
  const actual = await sha256(join(releaseDir, name));
  if (actual !== expectedChecksums.get(name)) throw new Error(`checksum mismatch for ${name}`);
}

assert(metadata.name === "@offloophq/dsh-acp", "unexpected package name");
assert(metadata.license === "MIT", "package license must be MIT");
assert(metadata.engines?.node === "^22.19.0 || >=24.0.0", "unexpected Node engine range");
assert(
  exactJson(metadata.dependencies, {
    "@agentclientprotocol/sdk": "1.3.0",
    zod: "4.1.12",
  }),
  "runtime dependencies must remain exact and reviewed",
);
assert(
  exactJson(lockfile.packages?.[""]?.dependencies, metadata.dependencies),
  "package-lock root runtime dependencies do not match package.json",
);
assert(lockfile.packages?.[""]?.license === "MIT", "package-lock root license must be MIT");

const buildManifest = JSON.parse(await readFile(join(releaseDir, buildManifestName), "utf8"));
assert(buildManifest.schemaVersion === 1, "unexpected build manifest schema");
assert(buildManifest.name === metadata.name, "build manifest package name mismatch");
assert(buildManifest.version === version, "build manifest version mismatch");
assert(Number.isSafeInteger(buildManifest.sourceDateEpoch), "invalid source date epoch");
assert(buildManifest.runtime?.kind === "portable-node-bundle", "unexpected build runtime kind");
assert(buildManifest.runtime?.nodeRange === metadata.engines.node, "build Node range mismatch");
assert(buildManifest.bundle?.path === "dist/index.js", "unexpected build bundle path");
assert(
  buildManifest.lockfileSha256 === await sha256(join(root, "package-lock.json")),
  "build manifest lockfile hash mismatch",
);
const bundlePath = join(root, "dist/index.js");
const bundleBytes = await readFile(bundlePath);
assert(buildManifest.bundle?.sha256 === sha256Bytes(bundleBytes), "build bundle hash mismatch");
assert(buildManifest.bundle?.size === (await stat(bundlePath)).size, "build bundle size mismatch");
assert(
  (bunManifest === undefined) === (buildManifest.experimentalBunStandalone === undefined),
  "build manifest and Bun standalone assets disagree",
);
if (bunManifest !== undefined) {
  assert(
    exactJson(buildManifest.experimentalBunStandalone, bunManifest),
    "build and standalone manifests disagree",
  );
  assert(bunManifest.bundle?.file === "dist/index.js", "unexpected Bun source bundle path");
  assert(
    bunManifest.bundle?.sha256 === buildManifest.bundle.sha256,
    "Bun source bundle hash mismatch",
  );
}

const portableArchive = join(releaseDir, portableName);
const portablePrefix = `dsh-acp-${version}-node`;
const portableMembers = [
  `${portablePrefix}/LICENSE`,
  `${portablePrefix}/README.md`,
  `${portablePrefix}/THIRD_PARTY_NOTICES.md`,
  `${portablePrefix}/dsh-acp`,
  `${portablePrefix}/licenses/agentclientprotocol-sdk-1.3.0-LICENSE.txt`,
  `${portablePrefix}/licenses/zod-4.1.12-LICENSE.txt`,
  ...publicDocs.map((name) => `${portablePrefix}/${name}`),
];
assertExactMembers(await tarMembers(portableArchive), portableMembers, "portable archive");
const portableMetadata = await deterministicTarEntries(portableArchive);
assertExactMembers(portableMetadata.map((entry) => entry.name), portableMembers, "portable archive metadata");
for (const entry of portableMetadata) {
  assert(
    entry.mode === (entry.name.endsWith("/dsh-acp") ? 0o755 : 0o644),
    `portable archive mode mismatch for ${entry.name}`,
  );
  assert(entry.mtime === buildManifest.sourceDateEpoch, `portable archive mtime mismatch for ${entry.name}`);
}
const portableBundle = await tarMember(portableArchive, `${portablePrefix}/dsh-acp`);
assert(sha256Bytes(portableBundle) === buildManifest.bundle.sha256, "portable bundle hash mismatch");
assert(Buffer.byteLength(portableBundle) === buildManifest.bundle.size, "portable bundle size mismatch");
for (const sourceName of ["LICENSE", "README.md", "THIRD_PARTY_NOTICES.md"]) {
  const archived = await tarMember(portableArchive, `${portablePrefix}/${sourceName}`);
  assert(
    sha256Bytes(archived) === await sha256(join(root, sourceName)),
    `portable ${sourceName} does not match the source tree`,
  );
}
for (const sourceName of publicDocs) {
  const archived = await tarMember(portableArchive, `${portablePrefix}/${sourceName}`);
  assert(
    sha256Bytes(archived) === await sha256(join(root, sourceName)),
    `portable ${sourceName} does not match the source tree`,
  );
}
for (const [archiveName, sourcePath] of [
  ["agentclientprotocol-sdk-1.3.0-LICENSE.txt", "dist/licenses/agentclientprotocol-sdk-1.3.0-LICENSE.txt"],
  ["zod-4.1.12-LICENSE.txt", "dist/licenses/zod-4.1.12-LICENSE.txt"],
]) {
  const archived = await tarMember(portableArchive, `${portablePrefix}/licenses/${archiveName}`);
  assert(
    sha256Bytes(archived) === await sha256(join(root, sourcePath)),
    `portable license ${archiveName} does not match the build output`,
  );
}
assert(
  await sha256(join(root, "dist/licenses/agentclientprotocol-sdk-1.3.0-LICENSE.txt"))
    === await sha256(join(root, "node_modules/@agentclientprotocol/sdk/LICENSE")),
  "ACP SDK license output does not match the installed dependency",
);
assert(
  await sha256(join(root, "dist/licenses/zod-4.1.12-LICENSE.txt"))
    === await sha256(join(root, "node_modules/zod/LICENSE")),
  "Zod license output does not match the installed dependency",
);

const npmArchive = join(releaseDir, npmName);
const npmMembers = await tarMembers(npmArchive);
const requiredNpmMembers = [
  "package/LICENSE",
  "package/README.md",
  "package/THIRD_PARTY_NOTICES.md",
  "package/package.json",
  "package/dist/index.js",
  "package/dist/index.d.ts",
  "package/dist/licenses/agentclientprotocol-sdk-1.3.0-LICENSE.txt",
  "package/dist/licenses/zod-4.1.12-LICENSE.txt",
  ...publicDocs.map((name) => `package/${name}`),
];
const declarationMembers = (await filesBelow(join(root, "dist")))
  .filter((name) => name.endsWith(".d.ts"))
  .map((name) => `package/dist/${name}`);
assertExactMembers(
  npmMembers,
  [...new Set([...requiredNpmMembers, ...declarationMembers])],
  "npm package",
);
const npmArchiveMetadata = await deterministicTarEntries(npmArchive);
assertExactMembers(npmArchiveMetadata.map((entry) => entry.name).sort(), npmMembers, "npm package metadata");
for (const entry of npmArchiveMetadata) {
  assert(
    entry.mode === (entry.name === "package/dist/index.js" ? 0o755 : 0o644),
    `npm package mode mismatch for ${entry.name}`,
  );
  assert(entry.mtime === NPM_ARCHIVE_MTIME, `npm package mtime mismatch for ${entry.name}`);
}
const publishedMetadata = JSON.parse(await tarMember(npmArchive, "package/package.json"));
for (const field of ["name", "version", "license", "type", "main", "types", "bin", "engines", "dependencies"]) {
  assert(
    exactJson(publishedMetadata[field], metadata[field]),
    `npm package metadata mismatch for ${field}`,
  );
}
assert(publishedMetadata.private !== true, "npm package unexpectedly marked private");
const npmBundle = await tarMember(npmArchive, "package/dist/index.js");
assert(sha256Bytes(npmBundle) === buildManifest.bundle.sha256, "npm bundle hash mismatch");
assert(Buffer.byteLength(npmBundle) === buildManifest.bundle.size, "npm bundle size mismatch");
for (const sourceName of ["LICENSE", "README.md", "THIRD_PARTY_NOTICES.md"]) {
  const archived = await tarMember(npmArchive, `package/${sourceName}`);
  assert(
    sha256Bytes(archived) === await sha256(join(root, sourceName)),
    `npm ${sourceName} does not match the source tree`,
  );
}
for (const sourceName of publicDocs) {
  const archived = await tarMember(npmArchive, `package/${sourceName}`);
  assert(
    sha256Bytes(archived) === await sha256(join(root, sourceName)),
    `npm ${sourceName} does not match the source tree`,
  );
}
for (const member of declarationMembers) {
  const relative = member.slice("package/".length);
  const archived = await tarMember(npmArchive, member);
  assert(
    sha256Bytes(archived) === await sha256(join(root, relative)),
    `npm declaration ${relative} does not match the build output`,
  );
}
for (const relative of [
  "dist/licenses/agentclientprotocol-sdk-1.3.0-LICENSE.txt",
  "dist/licenses/zod-4.1.12-LICENSE.txt",
]) {
  const archived = await tarMember(npmArchive, `package/${relative}`);
  assert(
    sha256Bytes(archived) === await sha256(join(root, relative)),
    `npm license ${relative} does not match the build output`,
  );
}

const sbom = JSON.parse(await readFile(join(releaseDir, sbomName), "utf8"));
assert(sbom.bomFormat === "CycloneDX", "unexpected SBOM format");
assert(sbom.metadata?.component?.name === metadata.name, "SBOM root component name mismatch");
assert(sbom.metadata?.component?.version === version, "SBOM root component version mismatch");
const rootSbomReference = `${metadata.name}@${version}`;
assert(sbom.metadata?.component?.["bom-ref"] === rootSbomReference, "SBOM root reference mismatch");
assert(sbom.metadata?.component?.type === "application", "SBOM root component type mismatch");
assert(sbom.metadata?.component?.scope === "required", "SBOM root component scope mismatch");
assert(
  sbom.metadata?.component?.purl === `pkg:npm/%40offloophq/dsh-acp@${version}`,
  "SBOM root purl mismatch",
);
assert(exactJson(licenseIds(sbom.metadata?.component), ["MIT"]), "SBOM root license mismatch");
const expectedSbomComponents = new Map([
  ["@agentclientprotocol/sdk", {
    version: "1.3.0",
    licenses: ["Apache-2.0"],
    ref: "@agentclientprotocol/sdk@1.3.0",
    type: "library",
    scope: "required",
    purl: "pkg:npm/%40agentclientprotocol/sdk@1.3.0",
  }],
  ["zod", {
    version: "4.1.12",
    licenses: ["MIT"],
    ref: "zod@4.1.12",
    type: "library",
    scope: "required",
    purl: "pkg:npm/zod@4.1.12",
  }],
]);
const bunReference = "pkg:github/oven-sh/bun@bun-v1.3.13";
if (bunManifest !== undefined) {
  expectedSbomComponents.set("bun", {
    version: "1.3.13",
    licenses: [],
    ref: bunReference,
    type: "application",
    scope: "required",
    purl: bunReference,
  });
}
assert(
  new Set((sbom.components ?? []).map((component) => component.name)).size === (sbom.components ?? []).length,
  "SBOM component names must be unique",
);
assert((sbom.components ?? []).length === expectedSbomComponents.size, "unexpected SBOM component set");
for (const component of sbom.components ?? []) {
  const expected = expectedSbomComponents.get(component.name);
  assert(expected !== undefined, `unexpected SBOM component ${component.name}`);
  assert(component.version === expected.version, `SBOM version mismatch for ${component.name}`);
  assert(component["bom-ref"] === expected.ref, `SBOM reference mismatch for ${component.name}`);
  assert(component.type === expected.type, `SBOM type mismatch for ${component.name}`);
  assert(component.scope === expected.scope, `SBOM scope mismatch for ${component.name}`);
  assert(component.purl === expected.purl, `SBOM purl mismatch for ${component.name}`);
  if (component.name !== "bun") {
    assert(
      exactJson(licenseIds(component), expected.licenses),
      `SBOM license mismatch for ${component.name}`,
    );
  }
}
const expectedDependencyGraph = [
  { ref: "@agentclientprotocol/sdk@1.3.0", dependsOn: ["zod@4.1.12"] },
  {
    ref: rootSbomReference,
    dependsOn: [
      "@agentclientprotocol/sdk@1.3.0",
      ...(bunManifest === undefined ? [] : [bunReference]),
      "zod@4.1.12",
    ].sort(),
  },
  { ref: "zod@4.1.12", dependsOn: [] },
  ...(bunManifest === undefined ? [] : [{ ref: bunReference, dependsOn: [] }]),
].sort((left, right) => left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0);
assert(exactJson(sbom.dependencies, expectedDependencyGraph), "SBOM dependency graph mismatch");

if (bunManifest !== undefined) {
  const standaloneMembers = [
    "BUN-1.3.13-LICENSE.md",
    "BUN-STANDALONE-RELINKING.md",
    "LICENSE",
    "README.md",
    "THIRD_PARTY_NOTICES.md",
    "dsh-acp.bundle.js",
    "licenses/agentclientprotocol-sdk-1.3.0-LICENSE.txt",
    "licenses/zod-4.1.12-LICENSE.txt",
    ...publicDocs.filter((name) => name !== "docs/licenses/BUN-1.3.13-LICENSE.md"),
  ];
  for (const [index, binary] of bunManifest.binaries.entries()) {
    const reviewed = BUN_TARGETS[index];
    assert(reviewed !== undefined, `missing reviewed Bun target ${index}`);
    const prefix = `dsh-acp-${version}-${binary.target}`;
    const binaryName = String(binary.file).endsWith(".exe") ? "dsh-acp.exe" : "dsh-acp";
    const archive = join(releaseDir, `${prefix}.tar.gz`);
    assert(binary.target === reviewed.id, `Bun target order changed at index ${index}`);
    assertExactMembers(
      await tarMembers(archive),
      [...standaloneMembers.map((member) => `${prefix}/${member}`), `${prefix}/${binaryName}`],
      `Bun archive ${binary.target}`,
    );
    const standaloneMetadata = await deterministicTarEntries(archive);
    for (const entry of standaloneMetadata) {
      assert(
        entry.mode === (entry.name === `${prefix}/${binaryName}` ? 0o755 : 0o644),
        `Bun archive mode mismatch for ${entry.name}`,
      );
      assert(entry.mtime === buildManifest.sourceDateEpoch, `Bun archive mtime mismatch for ${entry.name}`);
    }
    const standaloneBundle = await tarMember(archive, `${prefix}/dsh-acp.bundle.js`);
    assert(
      sha256Bytes(standaloneBundle) === buildManifest.bundle.sha256,
      `Bun archive ${binary.target} contains a different JavaScript bundle`,
    );
    for (const sourceName of publicDocs.filter((name) => name !== "docs/licenses/BUN-1.3.13-LICENSE.md")) {
      const archived = await tarMember(archive, `${prefix}/${sourceName}`);
      assert(
        sha256Bytes(archived) === await sha256(join(root, sourceName)),
        `Bun archive ${binary.target} ${sourceName} does not match the source tree`,
      );
    }
    const extractionRoot = await mkdtemp(join(tmpdir(), "dsh-acp-release-verify-"));
    try {
      await run("tar", ["-xzf", archive, "-C", extractionRoot, `${prefix}/${binaryName}`], {
        cwd: root,
      });
      const archivedBinary = join(extractionRoot, prefix, binaryName);
      assert(await sha256(archivedBinary) === binary.sha256, `Bun binary hash mismatch for ${binary.target}`);
      assert((await stat(archivedBinary)).size === binary.size, `Bun binary size mismatch for ${binary.target}`);
    } finally {
      await rm(extractionRoot, { recursive: true, force: true });
    }
  }
}
