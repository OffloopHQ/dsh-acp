#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { main } from "./cli/services.js";
import { createDiagnosticLogger } from "./logger.js";

const secondArgument = process.argv[1];
const isBun = process.versions["bun"] !== undefined;
const isBunScriptInvocation = secondArgument !== undefined
  && pathToFileURL(resolve(secondArgument)).href === import.meta.url;
// Bun standalone executables omit the usual script-name argv slot. Normal
// Node and `bun file.js` invocations keep it.
const args = isBun && !isBunScriptInvocation
  ? process.argv.slice(1)
  : process.argv.slice(2);

try {
  process.exitCode = await main(args);
} catch (error) {
  createDiagnosticLogger().error("fatal CLI failure", { error });
  process.exitCode = 1;
}
