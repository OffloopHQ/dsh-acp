export type DshCandidateSource =
  | "option"
  | "environment"
  | "official-current"
  | "official-bin"
  | "path";

export interface InspectDshOptions {
  /** A DSH checkout root or the official `bin/dsh` launcher. */
  readonly dshPath?: string;
  /** Injectable environment for deterministic discovery and tests. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Injectable home directory. Defaults to the current user's home. */
  readonly homeDir?: string;
  /** PATH override. Defaults to `env.PATH`. */
  readonly path?: string;
  /** Node executable used to host the in-process source driver. */
  readonly nodePath?: string;
  /** Base directory for a relative explicit path. Defaults to `process.cwd()`. */
  readonly cwd?: string;
}

export interface DshCandidateAttempt {
  readonly source: DshCandidateSource;
  readonly path: string;
  readonly status: "missing" | "rejected" | "compatible";
  readonly code?: string;
  readonly message?: string;
}

/** JSON-safe, immutable description of one validated source installation. */
export interface DshInstallation {
  readonly driverId: "dsh-source-0.0.1";
  readonly source: DshCandidateSource;
  /** Original absolute candidate. Re-resolved before runtime boot for TOCTOU protection. */
  readonly entryPath: string;
  readonly entryKind: "root" | "launcher";
  readonly resolvedEntryPath: string;
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
  readonly dshHomePath: string;
  /** Stable content identity; installation paths and mtimes are deliberately excluded. */
  readonly fingerprint: string;
  readonly validatedFiles: readonly string[];
}

export type InspectionResult =
  | {
      readonly ok: true;
      readonly installation: DshInstallation;
      readonly attempts: readonly DshCandidateAttempt[];
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
      };
      readonly attempts: readonly DshCandidateAttempt[];
    };

export interface DoctorCheck {
  readonly id: "discovery" | "layout" | "node" | "tsx" | "driver" | "fingerprint";
  readonly status: "pass" | "fail" | "skip";
  readonly message: string;
}

export interface DoctorResult {
  readonly ok: boolean;
  readonly inspection: InspectionResult;
  readonly checks: readonly DoctorCheck[];
}
