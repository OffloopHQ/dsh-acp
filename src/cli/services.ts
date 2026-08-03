import { Readable, Writable } from "node:stream";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { ndJsonStream } from "@agentclientprotocol/sdk";

import { createDshAcpApp } from "../acp/index.js";
import { doctorDsh, inspectDsh, type InspectDshOptions } from "../discovery/index.js";
import { createRuntimeDriver } from "../runtime/factory.js";
import { RuntimeCompatibilityError } from "../runtime/types.js";
import { runCli } from "./run.js";
import type {
  CliServices,
  CliStreams,
  DoctorOptions,
  InspectOptions,
  JsonValue,
  RuntimeSelectionOptions,
  ServeOptions,
} from "./types.js";
import { DSH_ACP_VERSION } from "./version.js";

function discoveryOptions(
  options: RuntimeSelectionOptions & { readonly nodePath?: string },
): InspectDshOptions {
  const result: {
    dshPath?: string;
    env?: Readonly<Record<string, string | undefined>>;
    nodePath?: string;
  } = {};
  if (options.dshPath !== undefined) result.dshPath = options.dshPath;
  if (options.nodePath !== undefined) result.nodePath = options.nodePath;
  if (options.dshHome !== undefined) {
    result.env = { ...process.env, DSH_HOME: options.dshHome };
  }
  return result;
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

async function assertSelectedNodeIsHost(nodePath: string | undefined): Promise<void> {
  if (nodePath === undefined) return;
  let selected: string;
  let current: string;
  try {
    [selected, current] = await Promise.all([
      realpath(resolve(nodePath)),
      realpath(process.execPath),
    ]);
  } catch (error) {
    throw new RuntimeCompatibilityError(
      "DSH_NODE_HOST_INVALID",
      `cannot resolve the selected Node host: ${String(error)}`,
    );
  }
  if (selected !== current) {
    throw new RuntimeCompatibilityError(
      "DSH_NODE_HOST_MISMATCH",
      `the in-process DSH driver must run under the selected Node (${selected}); current host is ${current}`,
    );
  }
}

async function serve(options: ServeOptions, streams: CliStreams): Promise<void> {
  await assertSelectedNodeIsHost(options.nodePath);
  // Always inspect a logical path first. Even legacy CLI aliases are parsed
  // into dshPath, so no argument can directly bind an unvalidated checkout.
  const inspection = await inspectDsh(discoveryOptions(options));
  if (!inspection.ok) {
    throw new RuntimeCompatibilityError(
      inspection.error.code,
      inspection.error.message,
      { attempts: inspection.attempts },
    );
  }
  if (
    options.expectedRuntimeFingerprint !== undefined
    && inspection.installation.fingerprint !== options.expectedRuntimeFingerprint
  ) {
    throw new RuntimeCompatibilityError(
      "DSH_RUNTIME_FINGERPRINT_MISMATCH",
      `DSH runtime fingerprint changed (expected ${options.expectedRuntimeFingerprint}, found ${inspection.installation.fingerprint})`,
    );
  }

  // The factory performs a second layout and fingerprint check. The selected
  // version driver checks again when ACP initialize boots the runtime.
  const driver = await createRuntimeDriver(inspection);
  const app = createDshAcpApp({
    driver,
    name: "dsh-acp",
    title: "DeepSeek Harness",
    version: DSH_ACP_VERSION,
  });
  // Node's stream/web declarations and the SDK's DOM declarations differ on
  // the optional `value` field of a completed read despite representing the
  // same WHATWG stream at runtime.
  const output = Writable.toWeb(streams.stdout) as unknown as WritableStream<Uint8Array>;
  const input = Readable.toWeb(streams.stdin) as unknown as ReadableStream<Uint8Array>;
  const connection = app.connect(ndJsonStream(output, input));

  const closeForSignal = (): void => connection.close();
  process.once("SIGINT", closeForSignal);
  process.once("SIGTERM", closeForSignal);
  try {
    await connection.closed;
  } finally {
    process.off("SIGINT", closeForSignal);
    process.off("SIGTERM", closeForSignal);
    // The app owns live ACP session teardown and retains failed staged cleanup.
    // Do not bypass that ownership by closing the driver directly.
    await app.retryCleanup();
  }
}

export function createCliServices(): CliServices {
  return {
    programName: "dsh-acp",
    version: DSH_ACP_VERSION,
    serve,
    inspect: async (options: InspectOptions) =>
      jsonValue(await inspectDsh(discoveryOptions(options))),
    doctor: async (options: DoctorOptions) =>
      jsonValue(await doctorDsh(discoveryOptions(options))),
  };
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
  streams: CliStreams = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  },
): Promise<number> {
  return runCli(args, createCliServices(), streams);
}
