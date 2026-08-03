import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { lstat, realpath, stat } from "node:fs/promises";
import { LayoutValidationError, validateDsh001Layout } from "./layout.js";
import type {
  DoctorCheck,
  DoctorResult,
  DshCandidateAttempt,
  DshCandidateSource,
  DshInstallation,
  InspectDshOptions,
  InspectionResult,
} from "./types.js";

export type {
  DoctorCheck,
  DoctorResult,
  DshCandidateAttempt,
  DshCandidateSource,
  DshInstallation,
  InspectDshOptions,
  InspectionResult,
} from "./types.js";
export { DSH_001_FINGERPRINT_FILES, computeRuntimeFingerprint } from "./fingerprint.js";

interface Candidate {
  readonly source: DshCandidateSource;
  readonly path: string;
}

interface ResolvedCandidate {
  readonly entryPath: string;
  readonly entryKind: "root" | "launcher";
  readonly resolvedEntryPath: string;
  readonly rootPath: string;
}

function expandUserPath(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith(`~${sep}`)) return join(home, path.slice(2));
  return path;
}

function absolutePath(path: string, cwd: string, home: string): string {
  const expanded = expandUserPath(path, home);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function uniqueCandidates(candidates: readonly Candidate[]): Candidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.path)) return false;
    seen.add(candidate.path);
    return true;
  });
}

function buildCandidates(options: InspectDshOptions, home: string, cwd: string): Candidate[] {
  const env = options.env ?? process.env;
  if (options.dshPath !== undefined) {
    return [{ source: "option", path: absolutePath(options.dshPath, cwd, home) }];
  }
  const environmentPath = env["DSH_PATH"];
  if (environmentPath !== undefined && environmentPath.trim() !== "") {
    return [{ source: "environment", path: absolutePath(environmentPath, cwd, home) }];
  }

  const configuredHome = env["DSH_HOME"];
  const dshHome = configuredHome === undefined || configuredHome.trim() === ""
    ? join(home, ".dsh")
    : absolutePath(configuredHome, cwd, home);
  const candidates: Candidate[] = [
    { source: "official-current", path: join(dshHome, "source/current") },
  ];
  const defaultCurrent = join(home, ".dsh/source/current");
  if (defaultCurrent !== candidates[0]?.path) {
    candidates.push({ source: "official-current", path: defaultCurrent });
  }
  candidates.push({ source: "official-bin", path: join(home, ".local/bin/dsh") });

  const pathValue = options.path ?? env["PATH"] ?? "";
  for (const component of pathValue.split(delimiter)) {
    // Empty PATH components mean cwd to a shell. Discovery deliberately does
    // not execute a cwd-local basename as an installed DSH authority.
    if (component.trim() === "") continue;
    candidates.push({ source: "path", path: join(absolutePath(component, cwd, home), "dsh") });
  }
  return uniqueCandidates(candidates);
}

function isWithin(rootPath: string, candidate: string): boolean {
  const rel = relative(rootPath, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

async function resolveCandidate(candidatePath: string): Promise<ResolvedCandidate> {
  let entryInfo;
  try {
    entryInfo = await stat(candidatePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new LayoutValidationError("DSH_CANDIDATE_MISSING", `candidate does not exist: ${candidatePath}`);
    }
    throw new LayoutValidationError("DSH_CANDIDATE_INVALID", `cannot inspect candidate ${candidatePath}: ${String(error)}`);
  }

  const entryPath = resolve(candidatePath);
  if (entryInfo.isDirectory()) {
    const rootPath = await realpath(entryPath);
    return { entryPath, entryKind: "root", resolvedEntryPath: rootPath, rootPath };
  }
  if (!entryInfo.isFile()) {
    throw new LayoutValidationError("DSH_CANDIDATE_INVALID", `candidate is neither a directory nor a regular file: ${entryPath}`);
  }
  if (entryPath.split(sep).at(-1) !== "dsh") {
    throw new LayoutValidationError("DSH_CANDIDATE_INVALID", `DSH launcher path must be named dsh: ${entryPath}`);
  }

  const resolvedEntryPath = await realpath(entryPath);
  const rootPath = await realpath(join(dirname(resolvedEntryPath), ".."));
  const expectedLauncher = join(rootPath, "bin/dsh");
  const expectedPhysical = await realpath(expectedLauncher).catch(() => "");
  if (resolvedEntryPath !== expectedPhysical || !isWithin(rootPath, resolvedEntryPath)) {
    throw new LayoutValidationError(
      "DSH_BASENAME_COLLISION",
      `an executable named dsh is not the official source launcher: ${entryPath} -> ${resolvedEntryPath}`,
    );
  }
  return { entryPath, entryKind: "launcher", resolvedEntryPath, rootPath };
}

function dshHomePath(options: InspectDshOptions, home: string, cwd: string): string {
  const env = options.env ?? process.env;
  const configured = env["DSH_HOME"];
  return configured === undefined || configured.trim() === ""
    ? join(home, ".dsh")
    : absolutePath(configured, cwd, home);
}

/** Discover and fully validate a user-installed DSH source runtime. Never downloads or mutates it. */
export async function inspectDsh(options: InspectDshOptions = {}): Promise<InspectionResult> {
  const home = resolve(options.homeDir ?? homedir());
  const cwd = resolve(options.cwd ?? process.cwd());
  const candidates = buildCandidates(options, home, cwd);
  const attempts: DshCandidateAttempt[] = [];
  let sawRejectedCandidate = false;

  for (const candidate of candidates) {
    try {
      const resolvedCandidate = await resolveCandidate(candidate.path);
      const layout = await validateDsh001Layout(
        resolvedCandidate.rootPath,
        options.nodePath ?? process.execPath,
      );
      const installation: DshInstallation = {
        driverId: "dsh-source-0.0.1",
        source: candidate.source,
        entryPath: resolvedCandidate.entryPath,
        entryKind: resolvedCandidate.entryKind,
        resolvedEntryPath: resolvedCandidate.resolvedEntryPath,
        rootPath: layout.rootPath,
        launcherPath: layout.launcherPath,
        rootPackagePath: layout.rootPackagePath,
        cliPackagePath: layout.cliPackagePath,
        version: layout.version,
        nodePath: layout.nodePath,
        nodeVersion: layout.nodeVersion,
        tsxLoaderPath: layout.tsxLoaderPath,
        tsxVersion: layout.tsxVersion,
        tsconfigPath: layout.tsconfigPath,
        dshHomePath: dshHomePath(options, home, cwd),
        fingerprint: layout.fingerprint,
        validatedFiles: layout.validatedFiles,
      };
      attempts.push({ source: candidate.source, path: candidate.path, status: "compatible" });
      return { ok: true, installation, attempts };
    } catch (error) {
      const failure = error instanceof LayoutValidationError
        ? error
        : new LayoutValidationError("DSH_DISCOVERY_FAILED", String(error));
      const missing = failure.code === "DSH_CANDIDATE_MISSING";
      if (!missing) sawRejectedCandidate = true;
      attempts.push({
        source: candidate.source,
        path: candidate.path,
        status: missing ? "missing" : "rejected",
        code: failure.code,
        message: failure.message,
      });
    }
  }

  return {
    ok: false,
    error: sawRejectedCandidate
      ? { code: "DSH_INCOMPATIBLE", message: "DSH candidates were found, but none matched the supported 0.0.1 source layout" }
      : { code: "DSH_NOT_FOUND", message: "No installed DSH source runtime was found" },
    attempts,
  };
}

/** Re-resolve the discovery entry and recompute the complete runtime identity immediately before boot. */
export async function assertDshUnchanged(installation: DshInstallation): Promise<void> {
  const candidate = await resolveCandidate(installation.entryPath);
  if (candidate.entryKind !== installation.entryKind
    || candidate.resolvedEntryPath !== installation.resolvedEntryPath
    || candidate.rootPath !== installation.rootPath) {
    throw new LayoutValidationError(
      "DSH_INSTALLATION_CHANGED",
      `DSH discovery target changed after inspection: ${installation.entryPath}`,
    );
  }
  const current = await validateDsh001Layout(candidate.rootPath, installation.nodePath);
  if (current.fingerprint !== installation.fingerprint
    || current.nodePath !== installation.nodePath
    || current.nodeVersion !== installation.nodeVersion
    || current.tsxLoaderPath !== installation.tsxLoaderPath) {
    throw new LayoutValidationError(
      "DSH_INSTALLATION_CHANGED",
      `DSH runtime changed after inspection (expected ${installation.fingerprint}, found ${current.fingerprint})`,
    );
  }
}

export async function doctorDsh(options: InspectDshOptions = {}): Promise<DoctorResult> {
  const inspection = await inspectDsh(options);
  if (!inspection.ok) {
    const firstRejected = inspection.attempts.find((attempt) => attempt.status === "rejected");
    const failedMessage = firstRejected?.message ?? inspection.error.message;
    return {
      ok: false,
      inspection,
      checks: [
        { id: "discovery", status: "fail", message: failedMessage },
        { id: "layout", status: "skip", message: "No compatible DSH root was selected" },
        { id: "node", status: "skip", message: "No compatible DSH root was selected" },
        { id: "tsx", status: "skip", message: "No compatible DSH root was selected" },
        { id: "driver", status: "skip", message: "No compatible DSH root was selected" },
        { id: "fingerprint", status: "skip", message: "No compatible DSH root was selected" },
      ],
    };
  }

  const installation = inspection.installation;
  const checks: DoctorCheck[] = [
    { id: "discovery", status: "pass", message: `Selected ${installation.entryPath}` },
    { id: "layout", status: "pass", message: `Validated DSH ${installation.version} source layout` },
    { id: "node", status: "pass", message: `${installation.nodeVersion} at ${installation.nodePath}` },
    { id: "tsx", status: "pass", message: `tsx ${installation.tsxVersion} at ${installation.tsxLoaderPath}` },
    { id: "driver", status: "pass", message: installation.driverId },
    { id: "fingerprint", status: "pass", message: installation.fingerprint },
  ];
  try {
    await assertDshUnchanged(installation);
  } catch (error) {
    checks[5] = { id: "fingerprint", status: "fail", message: error instanceof Error ? error.message : String(error) };
    return { ok: false, inspection, checks };
  }
  return { ok: true, inspection, checks };
}

/** Test/support helper: true when a candidate path itself is a symlink. */
export async function isSymlink(path: string): Promise<boolean> {
  return (await lstat(path)).isSymbolicLink();
}
