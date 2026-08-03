import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { DSH_001_FINGERPRINT_FILES, computeRuntimeFingerprint } from "./fingerprint.js";

interface PackageJson {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly private?: unknown;
  readonly bin?: unknown;
}

export interface ValidatedLayout {
  readonly rootPath: string;
  readonly launcherPath: string;
  readonly rootPackagePath: string;
  readonly cliPackagePath: string;
  readonly version: "0.0.1";
  readonly nodePath: string;
  readonly nodeVersion: string;
  readonly tsxLoaderPath: string;
  readonly tsxVersion: string;
  readonly tsconfigPath: string;
  readonly fingerprint: string;
  readonly validatedFiles: readonly string[];
}

export class LayoutValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LayoutValidationError";
    this.code = code;
  }
}

async function readPackage(path: string, label: string): Promise<PackageJson> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new LayoutValidationError("DSH_LAYOUT_MISSING", `${label} is missing: ${path} (${String(error)})`);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("expected an object");
    }
    return parsed as PackageJson;
  } catch (error) {
    throw new LayoutValidationError("DSH_LAYOUT_INVALID", `${label} is not valid JSON: ${path} (${String(error)})`);
  }
}

function requirePackage(
  manifest: PackageJson,
  expectedName: string,
  expectedVersion: string,
  label: string,
): void {
  if (manifest.name !== expectedName || manifest.version !== expectedVersion) {
    throw new LayoutValidationError(
      "DSH_UNSUPPORTED_VERSION",
      `${label} must be ${expectedName}@${expectedVersion}; found ${String(manifest.name)}@${String(manifest.version)}`,
    );
  }
}

function parseNodeVersion(stdout: string): string {
  const value = stdout.trim();
  const match = /^v(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
  if (match === null) {
    throw new LayoutValidationError("DSH_NODE_INVALID", `Node returned an unrecognised version: ${JSON.stringify(value)}`);
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!((major === 22 && minor >= 19) || major >= 24)) {
    throw new LayoutValidationError(
      "DSH_NODE_UNSUPPORTED",
      `DSH 0.0.1 requires Node ^22.19.0 or >=24.0.0; found ${value}`,
    );
  }
  return value;
}

async function validateNode(requestedPath: string): Promise<{ path: string; version: string }> {
  const absolute = isAbsolute(requestedPath) ? requestedPath : resolve(requestedPath);
  let physical: string;
  try {
    physical = await realpath(absolute);
    await access(physical, constants.X_OK);
  } catch (error) {
    throw new LayoutValidationError("DSH_NODE_MISSING", `Node is not executable: ${absolute} (${String(error)})`);
  }
  const result = spawnSync(physical, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new LayoutValidationError(
      "DSH_NODE_INVALID",
      `failed to execute Node at ${physical}: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
  return { path: physical, version: parseNodeVersion(result.stdout) };
}

function isWithin(rootPath: string, candidate: string): boolean {
  const rel = relative(rootPath, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

async function requireContainedFile(rootPath: string, relativePath: string): Promise<void> {
  const requested = join(rootPath, relativePath);
  let physical: string;
  try {
    physical = await realpath(requested);
    const info = await stat(physical);
    if (!info.isFile()) throw new TypeError("not a regular file");
  } catch (error) {
    throw new LayoutValidationError(
      "DSH_LAYOUT_MISSING",
      `required DSH 0.0.1 file is missing or invalid: ${relativePath} (${String(error)})`,
    );
  }
  if (!isWithin(rootPath, physical)) {
    throw new LayoutValidationError(
      "DSH_LAYOUT_ESCAPE",
      `required DSH file resolves outside its checkout: ${relativePath} -> ${physical}`,
    );
  }
}

export async function validateDsh001Layout(rootCandidate: string, nodeCandidate: string): Promise<ValidatedLayout> {
  const rootPath = await realpath(rootCandidate).catch((error: unknown) => {
    throw new LayoutValidationError("DSH_ROOT_MISSING", `DSH root does not exist: ${rootCandidate} (${String(error)})`);
  });
  const rootInfo = await stat(rootPath);
  if (!rootInfo.isDirectory()) {
    throw new LayoutValidationError("DSH_ROOT_INVALID", `DSH root is not a directory: ${rootPath}`);
  }

  for (const relativePath of DSH_001_FINGERPRINT_FILES) {
    await requireContainedFile(rootPath, relativePath);
  }

  const rootPackagePath = join(rootPath, "package.json");
  const cliPackagePath = join(rootPath, "apps/cli/package.json");
  const rootPackage = await readPackage(rootPackagePath, "DSH root package");
  const cliPackage = await readPackage(cliPackagePath, "DSH CLI package");
  requirePackage(rootPackage, "@deepseek-ai/dsh-root", "0.0.1", "DSH root package");
  requirePackage(cliPackage, "@deepseek-ai/dsh", "0.0.1", "DSH CLI package");
  if (rootPackage.private !== true) {
    throw new LayoutValidationError("DSH_LAYOUT_INVALID", "DSH 0.0.1 source root must be a private workspace package");
  }
  const bin = cliPackage.bin;
  if (bin === null || typeof bin !== "object" || Array.isArray(bin)
    || (bin as Record<string, unknown>)["dsh"] !== "lib/bin.js") {
    throw new LayoutValidationError("DSH_LAYOUT_INVALID", "DSH CLI package does not expose the expected dsh bin layout");
  }

  const tsxPackage = await readPackage(join(rootPath, "node_modules/tsx/package.json"), "tsx package");
  if (tsxPackage.name !== "tsx" || typeof tsxPackage.version !== "string") {
    throw new LayoutValidationError("DSH_TSX_INVALID", "installed DSH does not contain a valid tsx runtime package");
  }
  const tsxVersion = tsxPackage.version;
  if (!/^4\./.test(tsxVersion)) {
    throw new LayoutValidationError("DSH_TSX_UNSUPPORTED", `DSH 0.0.1 source driver requires tsx 4.x; found ${tsxVersion}`);
  }

  const node = await validateNode(nodeCandidate);
  const launcherPath = join(rootPath, "bin/dsh");
  await access(launcherPath, constants.X_OK).catch((error: unknown) => {
    throw new LayoutValidationError("DSH_LAUNCHER_INVALID", `DSH launcher is not executable: ${launcherPath} (${String(error)})`);
  });
  const tsxLoaderPath = await realpath(join(rootPath, "node_modules/tsx/dist/esm/index.mjs"));
  const tsconfigPath = join(rootPath, "tsconfig.json");
  const fingerprint = await computeRuntimeFingerprint({
    rootPath,
    nodeVersion: node.version,
    tsxVersion,
  });

  return {
    rootPath,
    launcherPath,
    rootPackagePath,
    cliPackagePath,
    version: "0.0.1",
    nodePath: node.path,
    nodeVersion: node.version,
    tsxLoaderPath,
    tsxVersion,
    tsconfigPath,
    fingerprint,
    validatedFiles: [...DSH_001_FINGERPRINT_FILES],
  };
}
