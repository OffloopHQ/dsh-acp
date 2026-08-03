import type { DoctorOptions, InspectOptions, ServeOptions } from "./types.js";

export type CliCommand =
  | { readonly kind: "serve"; readonly options: ServeOptions }
  | { readonly kind: "inspect"; readonly options: InspectOptions }
  | { readonly kind: "doctor"; readonly options: DoctorOptions }
  | { readonly kind: "version" }
  | { readonly kind: "help" };

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

interface MutableSelectionOptions {
  dshPath?: string;
  dshHome?: string;
}

interface MutableServeOptions extends MutableSelectionOptions {
  nodePath?: string;
  expectedRuntimeFingerprint?: string;
}

const valueOptions = new Set([
  "--dsh-path",
  "--candidate",
  "--dsh-home",
  "--dsh-root",
  "--node",
  "--expected-runtime-fingerprint",
]);

export function parseCliArguments(args: readonly string[]): CliCommand {
  if (args.length === 0) {
    return { kind: "serve", options: {} };
  }

  const first = args[0];
  if (first === "--version" || first === "-V" || first === "version") {
    assertNoTrailingArguments(args, first);
    return { kind: "version" };
  }
  if (first === "--help" || first === "-h" || first === "help") {
    assertNoTrailingArguments(args, first);
    return { kind: "help" };
  }
  if (first === "inspect") {
    return { kind: "inspect", options: parseInspectionOptions(args.slice(1), "inspect") };
  }
  if (first === "doctor") {
    return { kind: "doctor", options: parseInspectionOptions(args.slice(1), "doctor") };
  }
  if (first === "serve") {
    return { kind: "serve", options: parseServeOptions(args.slice(1)) };
  }
  if (first?.startsWith("-")) {
    return { kind: "serve", options: parseServeOptions(args) };
  }

  throw new CliUsageError(`Unknown command: ${first ?? ""}`);
}

function assertNoTrailingArguments(args: readonly string[], option: string): void {
  if (args.length > 1) {
    throw new CliUsageError(`${option} does not accept additional arguments`);
  }
}

function parseInspectionOptions(
  args: readonly string[],
  command: "doctor" | "inspect",
): InspectOptions | DoctorOptions {
  const options: MutableSelectionOptions = {};
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--json") {
      if (json) {
        throw new CliUsageError(`${command}: --json may be specified only once`);
      }
      json = true;
      continue;
    }
    const value = optionValue(args, index, command);
    index += 1;
    switch (option) {
      case "--dsh-path":
      case "--candidate":
      case "--dsh-root":
        setOnce(options, "dshPath", value, command, option);
        break;
      case "--dsh-home":
        setOnce(options, "dshHome", value, command, option);
        break;
      default:
        throw new CliUsageError(`${command}: unknown option ${option ?? ""}`);
    }
  }

  if (!json) {
    throw new CliUsageError(`${command} requires --json`);
  }
  return options;
}

function parseServeOptions(args: readonly string[]): ServeOptions {
  const options: MutableServeOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = optionValue(args, index, "serve");
    index += 1;
    switch (option) {
      case "--dsh-path":
      case "--candidate":
      case "--dsh-root":
        // Legacy aliases still enter discovery as a logical DSH path. They do
        // not bind a root directly or bypass the runtime fingerprint fence.
        setOnce(options, "dshPath", value, "serve", option);
        break;
      case "--dsh-home":
        setOnce(options, "dshHome", value, "serve", option);
        break;
      case "--node":
        setOnce(options, "nodePath", value, "serve", option);
        break;
      case "--expected-runtime-fingerprint":
        setOnce(options, "expectedRuntimeFingerprint", value, "serve", option);
        break;
      default:
        throw new CliUsageError(`serve: unknown option ${option ?? ""}`);
    }
  }
  return options;
}

function optionValue(
  args: readonly string[],
  index: number,
  command: string,
): string {
  const option = args[index];
  if (option === undefined || !option.startsWith("-") || !valueOptions.has(option)) {
    throw new CliUsageError(`${command}: unknown option ${option ?? ""}`);
  }
  const value = args[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("-")) {
    throw new CliUsageError(`${command}: ${option} requires a value`);
  }
  return value;
}

function setOnce<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K],
  command: string,
  option: string,
): void {
  if (target[key] !== undefined) {
    throw new CliUsageError(`${command}: ${option} may be specified only once`);
  }
  target[key] = value;
}

export function cliUsage(programName = "dsh-acp"): string {
  return [
    `Usage: ${programName} [serve] [options]`,
    `       ${programName} inspect --json [--dsh-path <path>] [--dsh-home <path>]`,
    `       ${programName} doctor --json [--dsh-path <path>] [--dsh-home <path>]`,
    `       ${programName} --version`,
    "",
    "Serve options:",
    "  --dsh-path <path>                      Logical DSH launcher or root to inspect",
    "  --dsh-home <path>                      Override DSH home for discovery",
    "  --node <path>                          Bind an exact Node executable",
    "  --expected-runtime-fingerprint <sha256> Reject runtime drift",
    "",
    "The default command is serve. In serve mode stdout is reserved for ACP JSON-RPC.",
  ].join("\n");
}
