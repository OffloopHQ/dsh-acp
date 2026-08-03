import type { Writable } from "node:stream";

import { cliUsage, CliUsageError, parseCliArguments } from "./parse.js";
import type { CliServices, CliStreams, JsonValue } from "./types.js";
import { diagnosticErrorMessage } from "../logger.js";

export async function runCli(
  args: readonly string[],
  services: CliServices,
  streams: CliStreams,
): Promise<number> {
  let command;
  try {
    command = parseCliArguments(args);
  } catch (error) {
    if (error instanceof CliUsageError) {
      await writeText(streams.stderr, `${error.message}\n\n${cliUsage(services.programName)}\n`);
      return 2;
    }
    throw error;
  }

  try {
    switch (command.kind) {
      case "serve":
        await services.serve(command.options, streams);
        return 0;
      case "inspect":
        await writeJson(streams.stdout, await services.inspect(command.options));
        return 0;
      case "doctor":
        await writeJson(streams.stdout, await services.doctor(command.options));
        return 0;
      case "version":
        await writeText(streams.stdout, `${services.programName} ${services.version}\n`);
        return 0;
      case "help":
        // Help is diagnostic output rather than a machine-readable command, so
        // keep stdout untouched just like other non-ACP diagnostics.
        await writeText(streams.stderr, `${cliUsage(services.programName)}\n`);
        return 0;
    }
  } catch (error) {
    await writeText(streams.stderr, `${services.programName}: ${diagnosticErrorMessage(error)}\n`);
    return 1;
  }
}

async function writeJson(stream: Writable, value: JsonValue): Promise<void> {
  await writeText(stream, `${JSON.stringify(value)}\n`);
}

export async function writeText(stream: Writable, text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(text, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
