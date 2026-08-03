import { rm } from "node:fs/promises";
import { Readable, Writable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { createCliServices, main } from "../../src/cli/services.js";
import type { CliStreams } from "../../src/cli/types.js";
import { createDshFixture } from "../discovery/fixture.js";

class CaptureWritable extends Writable {
  value = "";

  override _write(
    chunk: string | Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.value += Buffer.isBuffer(chunk)
      ? chunk.toString("utf8")
      : Buffer.from(chunk, encoding).toString("utf8");
    callback();
  }
}

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function streams(): { readonly streams: CliStreams; readonly stdout: CaptureWritable; readonly stderr: CaptureWritable } {
  const stdout = new CaptureWritable();
  const stderr = new CaptureWritable();
  return {
    stdout,
    stderr,
    streams: { stdin: Readable.from([]), stdout, stderr },
  };
}

describe("production CLI binding", () => {
  it("imports without starting stdio and prints the compiled version on demand", async () => {
    const io = streams();

    expect(await main(["--version"], io.streams)).toBe(0);
    expect(io.stdout.value).toMatch(/^dsh-acp \d+\.\d+\.\d+(?:-[^\s]+)?\n$/);
    expect(io.stderr.value).toBe("");
  });

  it("routes inspect and doctor through the real discovery facade", async () => {
    const fixture = await createDshFixture("dsh-acp-cli-");
    cleanup.push(fixture.container);
    const services = createCliServices();

    const inspection = await services.inspect({ dshPath: fixture.root, dshHome: fixture.home });
    const doctor = await services.doctor({ dshPath: fixture.root, dshHome: fixture.home });

    expect(inspection).toMatchObject({
      ok: true,
      installation: { driverId: "dsh-source-0.0.1", rootPath: fixture.root },
    });
    expect(doctor).toMatchObject({ ok: true });
  });

  it("rejects an expected-fingerprint mismatch before driver boot", async () => {
    const fixture = await createDshFixture("dsh-acp-cli-fence-");
    cleanup.push(fixture.container);
    const io = streams();

    await expect(
      createCliServices().serve(
        {
          dshPath: fixture.root,
          dshHome: fixture.home,
          expectedRuntimeFingerprint: `sha256:${"0".repeat(64)}`,
        },
        io.streams,
      ),
    ).rejects.toMatchObject({ code: "DSH_RUNTIME_FINGERPRINT_MISMATCH" });
    expect(io.stdout.value).toBe("");
  });

  it("rejects a selected Node that is not the in-process host", async () => {
    const io = streams();

    await expect(
      createCliServices().serve({ nodePath: "/bin/sh" }, io.streams),
    ).rejects.toMatchObject({ code: "DSH_NODE_HOST_MISMATCH" });
    expect(io.stdout.value).toBe("");
  });
});
