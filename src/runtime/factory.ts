import {
  assertDshUnchanged,
  inspectDsh,
  type DshInstallation,
  type InspectDshOptions,
  type InspectionResult,
} from "../discovery/index.js";
import { RuntimeCompatibilityError, type DshRuntimeDriver } from "./types.js";
import { Dsh001RuntimeDriver } from "./drivers/dsh-0.0.1/index.js";

export type RuntimeFactoryInput = InspectionResult | DshInstallation | InspectDshOptions | undefined;
export interface RuntimeFactoryOptions {
  readonly externalProcessConfinement?: "host-enforced";
}

function isInspection(value: unknown): value is InspectionResult {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && typeof (value as Record<string, unknown>)["ok"] === "boolean";
}

function isInstallation(value: unknown): value is DshInstallation {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>)["driverId"] === "dsh-source-0.0.1";
}

async function resolveInstallation(input: RuntimeFactoryInput): Promise<DshInstallation> {
  if (isInstallation(input)) return input;
  const inspection = isInspection(input) ? input : await inspectDsh(input);
  if (!inspection.ok) {
    throw new RuntimeCompatibilityError(
      inspection.error.code,
      inspection.error.message,
      { attempts: inspection.attempts },
    );
  }
  return inspection.installation;
}

/** Select an exact version driver and revalidate its inspected runtime immediately before construction. */
export async function createRuntimeDriver(
  input?: RuntimeFactoryInput,
  options: RuntimeFactoryOptions = {},
): Promise<DshRuntimeDriver> {
  const installation = await resolveInstallation(input);
  await assertDshUnchanged(installation);
  switch (installation.driverId) {
    case "dsh-source-0.0.1":
      return new Dsh001RuntimeDriver(installation, {
        ...(options.externalProcessConfinement === undefined
          ? {}
          : { externalProcessConfinement: options.externalProcessConfinement }),
      });
    default: {
      const unreachable: never = installation.driverId;
      throw new RuntimeCompatibilityError("DSH_DRIVER_UNSUPPORTED", `unsupported DSH driver: ${String(unreachable)}`);
    }
  }
}
