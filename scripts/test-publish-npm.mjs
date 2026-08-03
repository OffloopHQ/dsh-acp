import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertPublishEnvironment,
  executeCommand,
  preparePublicationPlans,
  publishAll,
  publishOne,
  publicationPlans,
  sha512Integrity,
} from "./publish-npm.mjs";

const version = "1.2.3";
const validEnvironment = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "OffloopHQ/dsh-acp",
  GITHUB_JOB: "public-npm",
  GITHUB_ACTOR_ID: "22412638",
  GITHUB_REF_TYPE: "tag",
  GITHUB_REF_NAME: `v${version}`,
  GITHUB_REF: `refs/tags/v${version}`,
  DSH_ACP_PUBLISH_NPM: "confirmed",
  GITHUB_WORKFLOW_REF: `OffloopHQ/dsh-acp/.github/workflows/release.yml@refs/tags/v${version}`,
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.githubusercontent.test/request",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "ephemeral-test-oidc-request-token",
};

assert.doesNotThrow(() => assertPublishEnvironment(version, validEnvironment));
for (const [key, value] of [
  ["GITHUB_ACTIONS", "false"],
  ["GITHUB_REPOSITORY", "fork/dsh-acp"],
  ["GITHUB_JOB", "release-candidate"],
  ["GITHUB_ACTOR_ID", "14072670"],
  ["GITHUB_REF_TYPE", "branch"],
  ["GITHUB_REF_NAME", "v1.2.4"],
  ["GITHUB_REF", "refs/tags/v1.2.4"],
  ["DSH_ACP_PUBLISH_NPM", "yes"],
  ["GITHUB_WORKFLOW_REF", "OffloopHQ/dsh-acp/.github/workflows/other.yml@refs/tags/v1.2.3"],
  ["ACTIONS_ID_TOKEN_REQUEST_URL", ""],
  ["ACTIONS_ID_TOKEN_REQUEST_TOKEN", ""],
]) {
  assert.throws(() => assertPublishEnvironment(version, { ...validEnvironment, [key]: value }));
}

function result(exitCode, stdout = "", stderr = "") {
  return { exitCode, stdout, stderr };
}

function fakeExecutor(responses) {
  const calls = [];
  return {
    calls,
    execute: async (command, args) => {
      calls.push({ command, args });
      const response = responses.shift();
      assert.notEqual(response, undefined, `unexpected command: ${command} ${args.join(" ")}`);
      return typeof response === "function" ? response(command, args) : response;
    },
  };
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "dsh-acp-publish-test-"));
try {
  const releaseDir = join(temporaryRoot, "release");
  const plans = publicationPlans(temporaryRoot, version);
  assert.deepEqual(plans.map(({ name }) => name), ["dsh-acp", "@offloophq/dsh-acp"]);
  await mkdir(releaseDir, { recursive: true });
  await writeFile(plans[0].archive, "unscoped archive");
  await writeFile(plans[1].archive, "scoped archive");
  const prepared = await preparePublicationPlans(temporaryRoot, version);
  assert.equal(prepared[0].integrity, await sha512Integrity(plans[0].archive));

  {
    const fake = fakeExecutor([result(0, JSON.stringify(prepared[0].integrity))]);
    const outcome = await publishOne(prepared[0], {
      execute: fake.execute,
      sleep: async () => undefined,
    });
    assert.equal(outcome.action, "skipped");
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(fake.calls[0].args, [
      "view",
      `${prepared[0].name}@${prepared[0].version}`,
      "dist.integrity",
      "--json",
      "--prefer-online",
    ]);
  }

  {
    const differentIntegrity = `sha512-${Buffer.from("different").toString("base64")}`;
    const fake = fakeExecutor([result(0, JSON.stringify(differentIntegrity))]);
    await assert.rejects(
      publishOne(prepared[0], { execute: fake.execute, sleep: async () => undefined }),
      /published integrity conflict/u,
    );
    assert.equal(fake.calls.length, 1);
  }

  {
    const fake = fakeExecutor([
      result(1, "", "npm error code E404"),
      result(0),
      result(0, JSON.stringify(prepared[0].integrity)),
    ]);
    const outcome = await publishOne(prepared[0], {
      execute: fake.execute,
      sleep: async () => undefined,
    });
    assert.equal(outcome.action, "published");
    assert.deepEqual(fake.calls[1], {
      command: "npm",
      args: [
        "publish",
        prepared[0].archive,
        "--access",
        "public",
        "--provenance=false",
      ],
    });
  }

  {
    const sleeps = [];
    const fake = fakeExecutor([
      result(1, "", "npm error code E404"),
      result(0),
      result(1, "", "npm error code E404"),
      result(1, "", "npm error code E404"),
      result(0, JSON.stringify(prepared[0].integrity)),
    ]);
    const outcome = await publishOne(prepared[0], {
      execute: fake.execute,
      sleep: async (delayMs) => sleeps.push(delayMs),
      readbackAttempts: 3,
      readbackDelayMs: 7,
    });
    assert.equal(outcome.action, "published");
    assert.deepEqual(sleeps, [7, 7]);
  }

  {
    // A successful Trusted Publisher mutation can take substantially longer
    // than the publish command itself to appear on the public registry edge.
    // The default policy must tolerate a full one-minute propagation window.
    const registryMisses = Array.from({ length: 12 }, () => result(1, "", "npm error code E404"));
    const sleeps = [];
    const fake = fakeExecutor([
      result(1, "", "npm error code E404"),
      result(0),
      ...registryMisses,
      result(0, JSON.stringify(prepared[0].integrity)),
    ]);
    const outcome = await publishOne(prepared[0], {
      execute: fake.execute,
      sleep: async (delayMs) => sleeps.push(delayMs),
    });
    assert.equal(outcome.action, "published");
    assert.equal(sleeps.length, 12);
    assert(sleeps.every((delayMs) => delayMs === 5_000));
  }

  {
    const sleeps = [];
    const registryMisses = Array.from({ length: 13 }, () => result(1, "", "npm error code E404"));
    const fake = fakeExecutor([
      result(1, "", "npm error code E404"),
      result(0),
      ...registryMisses,
      result(0, JSON.stringify(prepared[0].integrity)),
    ]);
    await assert.rejects(
      publishOne(prepared[0], {
        execute: fake.execute,
        sleep: async (delayMs) => sleeps.push(delayMs),
      }),
      /npm readback did not confirm .* after 13 attempts/u,
    );
    assert.equal(fake.calls.length, 15);
    assert.equal(sleeps.length, 12);
    assert(sleeps.every((delayMs) => delayMs === 5_000));
  }

  {
    const fake = fakeExecutor([result(1, "", "npm error code E401")]);
    await assert.rejects(
      publishOne(prepared[0], { execute: fake.execute, sleep: async () => undefined }),
      /npm view .* failed with exit code 1/u,
    );
    assert.equal(fake.calls.length, 1, "non-404 lookup failures must never publish");
  }

  {
    const fake = fakeExecutor([{
      ...result(1, "", "npm error code E404"),
      timedOut: true,
      signal: "SIGTERM",
    }]);
    await assert.rejects(
      publishOne(prepared[0], { execute: fake.execute, sleep: async () => assert.fail("must not retry a timeout") }),
      /exceeded its publication timeout/u,
    );
    assert.equal(fake.calls.length, 1, "a timed-out E404 lookup must never authorize publish");
  }

  {
    const fake = fakeExecutor([
      result(1, "", "npm error code E404"),
      result(0),
      result(1, "", "npm error code E401"),
    ]);
    await assert.rejects(
      publishOne(prepared[0], { execute: fake.execute, sleep: async () => assert.fail("must not retry E401") }),
      /npm view .* failed with exit code 1/u,
    );
    assert.equal(fake.calls.length, 3, "post-publish authentication failures must fail immediately");
  }

  {
    const fake = fakeExecutor([
      result(1, "", "npm error code E404"),
      result(0),
      {
        ...result(1, "", "npm error code E404"),
        timedOut: true,
        signal: "SIGTERM",
      },
    ]);
    await assert.rejects(
      publishOne(prepared[0], { execute: fake.execute, sleep: async () => assert.fail("must not retry a timeout") }),
      /exceeded its publication timeout/u,
    );
    assert.equal(fake.calls.length, 3, "post-publish timeouts must fail immediately");
  }

  {
    const fake = fakeExecutor([{
      ...result(1, "", "npm error code E404"),
      timedOut: false,
      signal: "SIGKILL",
    }]);
    await assert.rejects(
      publishOne(prepared[0], { execute: fake.execute, sleep: async () => assert.fail("must not retry a signal") }),
      /terminated by signal SIGKILL/u,
    );
    assert.equal(fake.calls.length, 1, "a signaled E404 lookup must never authorize publish");
  }

  {
    const fake = fakeExecutor([
      result(1, "", "npm error code E404"),
      result(0),
      result(0, JSON.stringify("not-an-integrity")),
    ]);
    await assert.rejects(
      publishOne(prepared[0], { execute: fake.execute, sleep: async () => assert.fail("must not retry invalid metadata") }),
      /invalid dist\.integrity/u,
    );
    assert.equal(fake.calls.length, 3, "invalid registry metadata must fail immediately");
  }

  {
    // A conflict under the second name must be discovered before publishing
    // the missing first name.
    const differentIntegrity = `sha512-${Buffer.from("different mirror").toString("base64")}`;
    const fake = fakeExecutor([
      result(1, "", "npm error code E404"),
      result(0, JSON.stringify(differentIntegrity)),
    ]);
    await assert.rejects(
      publishAll({
        root: temporaryRoot,
        version,
        execute: fake.execute,
        sleep: async () => undefined,
      }),
      /published integrity conflict/u,
    );
    assert.equal(fake.calls.filter(({ args }) => args[0] === "publish").length, 0);
  }

  {
    // Exercise the full recovery sequence: the first run publishes the first
    // identity and fails on the second, then the rerun reconciles the first and
    // publishes only the missing mirror.
    const registry = new Map();
    const plansBySpec = new Map(prepared.map((plan) => [`${plan.name}@${plan.version}`, plan]));
    const plansByArchive = new Map(prepared.map((plan) => [plan.archive, plan]));
    const calls = [];
    let failMirrorOnce = true;
    const execute = async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "view") {
        const plan = plansBySpec.get(args[1]);
        assert.notEqual(plan, undefined);
        return registry.has(args[1])
          ? result(0, JSON.stringify(registry.get(args[1])))
          : result(1, "", "npm error code E404");
      }
      assert.equal(args[0], "publish");
      const plan = plansByArchive.get(args[1]);
      assert.notEqual(plan, undefined);
      if (plan.name === "@offloophq/dsh-acp" && failMirrorOnce) {
        failMirrorOnce = false;
        return result(1, "", "simulated publish failure");
      }
      registry.set(`${plan.name}@${plan.version}`, plan.integrity);
      return result(0);
    };

    await assert.rejects(
      publishAll({ root: temporaryRoot, version, execute, sleep: async () => undefined }),
      /npm publish .* failed with exit code 1/u,
    );
    assert.equal(registry.get(`dsh-acp@${version}`), prepared[0].integrity);
    assert.equal(registry.has(`@offloophq/dsh-acp@${version}`), false);

    const outcomes = await publishAll({
      root: temporaryRoot,
      version,
      execute,
      sleep: async () => undefined,
    });
    assert.deepEqual(outcomes.map(({ action }) => action), ["skipped", "published"]);
    const publishCalls = calls.filter(({ args }) => args[0] === "publish");
    assert.equal(publishCalls.length, 3);
    assert.equal(publishCalls.at(-1).args[1], prepared[1].archive);
  }

  {
    const differentIntegrity = `sha512-${Buffer.from("readback conflict").toString("base64")}`;
    const fake = fakeExecutor([
      result(1, "", "npm error code E404"),
      result(0),
      result(0, JSON.stringify(differentIntegrity)),
    ]);
    await assert.rejects(
      publishOne(prepared[0], {
        execute: fake.execute,
        sleep: async () => assert.fail("must not retry an integrity conflict"),
      }),
      /published integrity conflict/u,
    );
    assert.equal(fake.calls.length, 3, "integrity conflicts must fail immediately");
  }

  {
    const fake = fakeExecutor([
      result(1, "", "npm error code E404"),
      result(0),
      result(1, "", "npm error code E404"),
      result(1, "", "npm error code E404"),
    ]);
    await assert.rejects(
      publishOne(prepared[0], {
        execute: fake.execute,
        sleep: async () => undefined,
        readbackAttempts: 2,
      }),
      /npm readback did not confirm/u,
    );
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

{
  const sanitized = await executeCommand(
    process.execPath,
    ["-e", "process.stdout.write(JSON.stringify({node:process.env.NODE_AUTH_TOKEN,npm:process.env.NPM_TOKEN}))"],
    {
      env: { ...process.env, NODE_AUTH_TOKEN: "must-not-leak", NPM_TOKEN: "must-not-leak" },
      timeoutMs: 5_000,
    },
  );
  assert.equal(sanitized.exitCode, 0);
  assert.equal(sanitized.stdout, "{}");
}

{
  const startedAt = Date.now();
  const timedOut = await executeCommand(
    process.execPath,
    ["-e", "setInterval(() => undefined, 1_000)"],
    { env: process.env, timeoutMs: 100 },
  );
  assert.notEqual(timedOut.exitCode, 0);
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.signal, "SIGTERM");
  assert(Date.now() - startedAt < 5_000, "command timeout must have a bounded wall-clock duration");
}

{
  const delayedSuccess = await executeCommand(
    process.execPath,
    ["-e", "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),50));setInterval(()=>undefined,1_000)"],
    { env: process.env, timeoutMs: 100, killGraceMs: 500 },
  );
  assert.equal(delayedSuccess.exitCode, 1, "a command cannot convert a publication timeout into success");
  assert.equal(delayedSuccess.timedOut, true);
}

{
  const startedAt = Date.now();
  const forceKilled = await executeCommand(
    process.execPath,
    ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>undefined,1_000)"],
    { env: process.env, timeoutMs: 100, killGraceMs: 100 },
  );
  assert.equal(forceKilled.exitCode, 1);
  assert.equal(forceKilled.timedOut, true);
  assert.equal(forceKilled.signal, "SIGKILL");
  assert(Date.now() - startedAt < 5_000, "SIGTERM-resistant commands must be force-killed");
}

process.stdout.write("npm publish coordinator safety checks passed\n");
