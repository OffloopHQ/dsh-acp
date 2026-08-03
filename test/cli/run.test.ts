import { Readable, Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/run.js";
import type { CliServices, CliStreams } from "../../src/cli/types.js";

class CaptureWritable extends Writable {
  #chunks: Buffer[] = [];

  override _write(
    chunk: string | Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    callback();
  }

  text(): string {
    return Buffer.concat(this.#chunks).toString("utf8");
  }
}

function fixture(): {
  streams: CliStreams;
  stdout: CaptureWritable;
  stderr: CaptureWritable;
  services: CliServices;
} {
  const stdout = new CaptureWritable();
  const stderr = new CaptureWritable();
  const services: CliServices = {
    programName: "dsh-acp",
    version: "9.8.7",
    serve: vi.fn(async () => undefined),
    inspect: vi.fn(async () => ({ status: "compatible", schemaVersion: 1 })),
    doctor: vi.fn(async () => ({ status: "healthy", schemaVersion: 1 })),
  };

  return {
    stdout,
    stderr,
    services,
    streams: {
      stdin: Readable.from([]),
      stdout,
      stderr,
    },
  };
}

describe("runCli", () => {
  it("routes the default command without contaminating stdio", async () => {
    const { services, streams, stdout, stderr } = fixture();

    expect(await runCli([], services, streams)).toBe(0);
    expect(services.serve).toHaveBeenCalledOnce();
    expect(services.serve).toHaveBeenCalledWith({}, streams);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toBe("");
  });

  it("prints exactly one JSON value for inspect and doctor", async () => {
    const inspect = fixture();
    const doctor = fixture();

    expect(
      await runCli(["inspect", "--json", "--dsh-path", "/opt/dsh"], inspect.services, inspect.streams),
    ).toBe(0);
    expect(inspect.services.inspect).toHaveBeenCalledWith({ dshPath: "/opt/dsh" });
    expect(inspect.stdout.text()).toBe('{"status":"compatible","schemaVersion":1}\n');
    expect(inspect.stderr.text()).toBe("");

    expect(
      await runCli(["doctor", "--json", "--dsh-home", "/state/dsh"], doctor.services, doctor.streams),
    ).toBe(0);
    expect(doctor.services.doctor).toHaveBeenCalledWith({ dshHome: "/state/dsh" });
    expect(doctor.stdout.text()).toBe('{"status":"healthy","schemaVersion":1}\n');
    expect(doctor.stderr.text()).toBe("");
  });

  it("keeps version output separate from diagnostic help", async () => {
    const version = fixture();
    const help = fixture();

    expect(await runCli(["--version"], version.services, version.streams)).toBe(0);
    expect(version.stdout.text()).toBe("dsh-acp 9.8.7\n");
    expect(version.stderr.text()).toBe("");

    expect(await runCli(["--help"], help.services, help.streams)).toBe(0);
    expect(help.stdout.text()).toBe("");
    expect(help.stderr.text()).toContain("Usage: dsh-acp");
  });

  it("reports usage errors on stderr and leaves stdout empty", async () => {
    const { services, streams, stdout, stderr } = fixture();

    expect(await runCli(["inspect"], services, streams)).toBe(2);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("inspect requires --json");
    expect(stderr.text()).toContain("Usage: dsh-acp");
  });

  it("redacts runtime errors and leaves stdout empty", async () => {
    const { services, streams, stdout, stderr } = fixture();
    vi.mocked(services.serve).mockRejectedValueOnce(
      new Error("authorization=super-secret Bearer abc.def"),
    );

    expect(await runCli([], services, streams)).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toBe(
      "dsh-acp: authorization=[REDACTED] Bearer [REDACTED]\n",
    );
  });
});
