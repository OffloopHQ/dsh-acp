export const BUN_VERSION = "1.3.13";
export const BUN_REVISION = "1.3.13+bf2e2cecf";

export const BUN_TARGETS = Object.freeze([
  Object.freeze({
    id: "x86_64-unknown-linux-gnu",
    bunTarget: "bun-linux-x64-baseline",
    asset: "bun-linux-x64-baseline",
    archiveSha256: "9d8a24292a7068090205daac0a5a223f5f69736f5287e37bf88d3b4031edc750",
    extension: "",
    signatures: Object.freeze(["not-applicable"]),
  }),
  Object.freeze({
    id: "aarch64-unknown-linux-gnu",
    bunTarget: "bun-linux-arm64",
    asset: "bun-linux-aarch64",
    archiveSha256: "70bae41b3908b0a120e1e58c5c8af30e74afae3b8d11b0d3fdd8e787ddfb4b22",
    extension: "",
    signatures: Object.freeze(["not-applicable"]),
  }),
  Object.freeze({
    id: "x86_64-apple-darwin",
    bunTarget: "bun-darwin-x64-baseline",
    asset: "bun-darwin-x64-baseline",
    archiveSha256: "a98ba6a480f22fda9b343626b906a4e26aa53618bf85d2bc5928ecf2ba45f0ed",
    extension: "",
    signatures: Object.freeze(["ad-hoc", "required-before-execution"]),
  }),
  Object.freeze({
    id: "aarch64-apple-darwin",
    bunTarget: "bun-darwin-arm64",
    asset: "bun-darwin-aarch64",
    archiveSha256: "5467e3f65dba526b9fea98f0cce04efafc0c63e169733ec27b876a3ad32da190",
    extension: "",
    signatures: Object.freeze(["ad-hoc", "required-before-execution"]),
  }),
  Object.freeze({
    id: "x86_64-pc-windows-msvc",
    bunTarget: "bun-windows-x64-baseline",
    asset: "bun-windows-x64-baseline",
    archiveSha256: "c68c7903c1190101590cc1b2129835f47211b3b37ae87759f2b97d6534aa3ad1",
    extension: ".exe",
    signatures: Object.freeze(["not-applicable"]),
  }),
  Object.freeze({
    id: "aarch64-pc-windows-msvc",
    bunTarget: "bun-windows-arm64",
    asset: "bun-windows-aarch64",
    archiveSha256: "feaf3f2951c50104dc9a33cf1a2e1ae3422f0c7e5d8890601c87b97b5d90b376",
    extension: ".exe",
    signatures: Object.freeze(["not-applicable"]),
  }),
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value, expected, label) {
  assert(isRecord(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const reviewed = [...expected].sort();
  assert(actual.join("\n") === reviewed.join("\n"), `${label} has an unreviewed shape`);
}

function assertSha256(value, label) {
  assert(typeof value === "string" && /^[a-f0-9]{64}$/u.test(value), `${label} must be a SHA-256 digest`);
}

/**
 * Validate the complete experimental standalone manifest before any path from
 * it is used. The returned value is the same object with a reviewed shape.
 */
export function assertBunStandaloneManifest(value) {
  assertExactKeys(value, ["schemaVersion", "experimental", "bundle", "binaries"], "Bun manifest");
  assert(value.schemaVersion === 1, "unexpected Bun standalone manifest schema");
  assert(value.experimental === true, "Bun standalone manifest must remain experimental");
  assertExactKeys(value.bundle, ["file", "sha256"], "Bun bundle descriptor");
  assert(value.bundle.file === "dist/index.js", "unexpected Bun source bundle path");
  assertSha256(value.bundle.sha256, "Bun source bundle hash");
  assert(Array.isArray(value.binaries), "Bun standalone manifest must contain binaries");
  assert(value.binaries.length === BUN_TARGETS.length, "Bun standalone manifest must describe six binaries");

  for (let index = 0; index < BUN_TARGETS.length; index += 1) {
    const reviewed = BUN_TARGETS[index];
    const binary = value.binaries[index];
    assert(reviewed !== undefined, `missing reviewed Bun target ${index}`);
    assertExactKeys(
      binary,
      ["target", "bunTarget", "bunVersion", "bunRevision", "signature", "file", "size", "sha256"],
      `Bun binary descriptor ${reviewed.id}`,
    );
    assert(binary.target === reviewed.id, `unexpected Bun target at index ${index}`);
    assert(binary.bunTarget === reviewed.bunTarget, `unexpected Bun compiler target for ${reviewed.id}`);
    assert(binary.bunVersion === BUN_VERSION, `unexpected Bun version for ${reviewed.id}`);
    assert(binary.bunRevision === BUN_REVISION, `unexpected Bun revision for ${reviewed.id}`);
    assert(reviewed.signatures.includes(binary.signature), `unexpected signature state for ${reviewed.id}`);
    assert(
      binary.file === `dist/bin/dsh-acp-${reviewed.id}${reviewed.extension}`,
      `unexpected Bun binary path for ${reviewed.id}`,
    );
    assert(Number.isSafeInteger(binary.size) && binary.size > 0, `invalid Bun binary size for ${reviewed.id}`);
    assertSha256(binary.sha256, `Bun binary hash for ${reviewed.id}`);
  }

  return value;
}
