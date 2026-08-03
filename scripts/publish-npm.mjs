import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const EXPECTED_REPOSITORY = "OffloopHQ/dsh-acp";
const EXPECTED_RELEASE_ACTOR_ID = "22412638";
const DEFAULT_READBACK_ATTEMPTS = 6;
const DEFAULT_READBACK_DELAY_MS = 2_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_COMMAND_KILL_GRACE_MS = 5_000;

class PublishedIntegrityConflictError extends Error {}

function assertVersion(version) {
  if (
    typeof version !== "string"
    || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version)
  ) {
    throw new Error("package.json contains an invalid release version");
  }
}

export function assertPublishEnvironment(version, env = process.env) {
  assertVersion(version);
  const expectedTag = `v${version}`;
  if (env.GITHUB_ACTIONS !== "true") {
    throw new Error("npm publication is restricted to GitHub Actions");
  }
  if (env.GITHUB_REPOSITORY !== EXPECTED_REPOSITORY) {
    throw new Error(`npm publication is restricted to ${EXPECTED_REPOSITORY}`);
  }
  if (env.GITHUB_JOB !== "public-npm") {
    throw new Error("npm publication is restricted to the public-npm job");
  }
  if (env.GITHUB_ACTOR_ID !== EXPECTED_RELEASE_ACTOR_ID) {
    throw new Error(`npm publication is restricted to release actor ${EXPECTED_RELEASE_ACTOR_ID}`);
  }
  if (
    env.GITHUB_REF_TYPE !== "tag"
    || env.GITHUB_REF_NAME !== expectedTag
    || env.GITHUB_REF !== `refs/tags/${expectedTag}`
  ) {
    throw new Error(`npm publication requires the exact tag ${expectedTag}`);
  }
  if (env.DSH_ACP_PUBLISH_NPM !== "confirmed") {
    throw new Error("npm publication requires DSH_ACP_PUBLISH_NPM=confirmed");
  }
  const expectedWorkflowRef = `${EXPECTED_REPOSITORY}/.github/workflows/release.yml@refs/tags/${expectedTag}`;
  if (env.GITHUB_WORKFLOW_REF !== expectedWorkflowRef) {
    throw new Error(`npm publication requires ${expectedWorkflowRef}`);
  }
  for (const key of ["ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"]) {
    if (typeof env[key] !== "string" || env[key].trim() === "") {
      throw new Error(`npm publication requires the GitHub Actions OIDC value ${key}`);
    }
  }
}

export async function sha512Integrity(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile()) throw new Error(`npm artifact is not a regular file: ${path}`);
  return `sha512-${createHash("sha512").update(await readFile(path)).digest("base64")}`;
}

export function publicationPlans(root, version) {
  assertVersion(version);
  return [
    {
      name: "dsh-acp",
      version,
      archive: join(root, "release", `dsh-acp-${version}.tgz`),
    },
    {
      name: "@offloophq/dsh-acp",
      version,
      archive: join(root, "release", `offloophq-dsh-acp-${version}.tgz`),
    },
  ];
}

export async function preparePublicationPlans(root, version) {
  return Promise.all(publicationPlans(root, version).map(async (plan) => ({
    ...plan,
    integrity: await sha512Integrity(plan.archive),
  })));
}

function commandFailure(command, args, result) {
  const rendered = [command, ...args].join(" ");
  if (result.timedOut) return new Error(`${rendered} exceeded its publication timeout`);
  return new Error(`${rendered} failed with exit code ${result.exitCode}`);
}

function isNpmNotFound(result) {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return /\bE404\b/u.test(output) || /\b404\s+Not\s+Found\b/iu.test(output);
}

function parseIntegrity(output, packageSpec) {
  const trimmed = output.trim();
  let value;
  try {
    value = JSON.parse(trimmed);
  } catch {
    value = trimmed;
  }
  if (typeof value !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new Error(`npm returned an invalid dist.integrity for ${packageSpec}`);
  }
  return value;
}

export async function readPublishedIntegrity(plan, execute) {
  const packageSpec = `${plan.name}@${plan.version}`;
  const args = ["view", packageSpec, "dist.integrity", "--json"];
  const result = await execute("npm", args);
  if (result.exitCode === 0) {
    return { found: true, integrity: parseIntegrity(result.stdout ?? "", packageSpec) };
  }
  if (isNpmNotFound(result)) return { found: false };
  throw commandFailure("npm", args, result);
}

function assertMatchingIntegrity(plan, remoteIntegrity) {
  if (remoteIntegrity !== plan.integrity) {
    throw new PublishedIntegrityConflictError(
      `published integrity conflict for ${plan.name}@${plan.version}: registry content differs from the reviewed archive`,
    );
  }
}

async function readBackPublishedIntegrity(plan, options) {
  const attempts = options.readbackAttempts ?? DEFAULT_READBACK_ATTEMPTS;
  const delayMs = options.readbackDelayMs ?? DEFAULT_READBACK_DELAY_MS;
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new Error("readbackAttempts must be a positive integer");
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
    throw new Error("readbackDelayMs must be a non-negative integer");
  }

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const remote = await readPublishedIntegrity(plan, options.execute);
      if (remote.found) {
        assertMatchingIntegrity(plan, remote.integrity);
        return;
      }
      lastError = new Error(`npm readback has not found ${plan.name}@${plan.version}`);
    } catch (error) {
      if (error instanceof PublishedIntegrityConflictError) throw error;
      lastError = error;
    }
    if (attempt < attempts) {
      const sleep = options.sleep ?? ((waitMs) => new Promise((resolveDelay) => setTimeout(resolveDelay, waitMs)));
      await sleep(delayMs);
    }
  }
  throw new Error(
    `npm readback did not confirm ${plan.name}@${plan.version} after ${attempts} attempts`,
    { cause: lastError },
  );
}

export async function publishOne(plan, options) {
  const remote = await readPublishedIntegrity(plan, options.execute);
  if (remote.found) {
    assertMatchingIntegrity(plan, remote.integrity);
    return { ...plan, action: "skipped" };
  }

  return publishMissing(plan, options);
}

async function publishMissing(plan, options) {
  const publishArgs = [
    "publish",
    plan.archive,
    "--access",
    "public",
    "--provenance=false",
  ];
  const published = await options.execute("npm", publishArgs);
  if (published.exitCode !== 0) throw commandFailure("npm", publishArgs, published);

  await readBackPublishedIntegrity(plan, options);
  return { ...plan, action: "published" };
}

export async function publishAll(options) {
  const plans = await preparePublicationPlans(options.root, options.version);
  const shared = {
    execute: options.execute,
    sleep: options.sleep ?? ((delayMs) => new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs))),
    readbackAttempts: options.readbackAttempts,
    readbackDelayMs: options.readbackDelayMs,
  };

  // Resolve both immutable registry states before the first irreversible
  // publish. This prevents one name from being created when the other name's
  // same-version content is already in conflict.
  const preflight = [];
  for (const plan of plans) {
    const remote = await readPublishedIntegrity(plan, shared.execute);
    if (remote.found) assertMatchingIntegrity(plan, remote.integrity);
    preflight.push({ plan, remote });
  }

  const results = [];
  for (const { plan, remote } of preflight) {
    results.push(remote.found
      ? { ...plan, action: "skipped" }
      : await publishMissing(plan, shared));
  }
  return results;
}

export async function executeCommand(command, args, options = {}) {
  const env = { ...(options.env ?? process.env) };
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_COMMAND_KILL_GRACE_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("command timeout must be a positive integer");
  }
  if (!Number.isSafeInteger(killGraceMs) || killGraceMs < 0) {
    throw new Error("command kill grace must be a non-negative integer");
  }
  // Trusted publishing must authenticate through the GitHub OIDC environment,
  // never through an accidentally inherited long-lived npm credential.
  delete env.NODE_AUTH_TOKEN;
  delete env.NPM_TOKEN;

  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let forceKillTimer;
    const clearTimers = () => {
      clearTimeout(timeoutTimer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", (error) => {
      clearTimers();
      rejectCommand(error);
    });
    child.once("close", (code, signal) => {
      clearTimers();
      resolveCommand({
        exitCode: timedOut ? 1 : (code ?? 1),
        signal,
        timedOut,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

export async function main(env = process.env) {
  const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
  const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const version = metadata.version;
  assertPublishEnvironment(version, env);
  const results = await publishAll({
    root,
    version,
    execute: (command, args) => executeCommand(command, args, { cwd: root, env }),
  });
  for (const result of results) {
    process.stdout.write(`${result.action} ${result.name}@${result.version} ${result.integrity}\n`);
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
