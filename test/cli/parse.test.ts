import { describe, expect, it } from "vitest";

import { CliUsageError, parseCliArguments } from "../../src/cli/parse.js";

describe("parseCliArguments", () => {
  it("defaults to the stdio server", () => {
    expect(parseCliArguments([])).toEqual({ kind: "serve", options: {} });
  });

  it("accepts explicit and implicit serve options", () => {
    const expected = {
      kind: "serve",
      options: {
        dshPath: "/opt/dsh",
        dshHome: "/state/dsh",
        nodePath: "/usr/bin/node",
        expectedRuntimeFingerprint: "abc123",
      },
    };

    expect(
      parseCliArguments([
        "serve",
        "--dsh-path",
        "/opt/dsh",
        "--dsh-home",
        "/state/dsh",
        "--node",
        "/usr/bin/node",
        "--expected-runtime-fingerprint",
        "abc123",
      ]),
    ).toEqual(expected);
    expect(parseCliArguments(["--candidate", "/opt/dsh"])).toEqual({
      kind: "serve",
      options: { dshPath: "/opt/dsh" },
    });
    expect(parseCliArguments(["serve", "--dsh-root", "/opt/dsh-root"])).toEqual({
      kind: "serve",
      options: { dshPath: "/opt/dsh-root" },
    });
  });

  it("requires machine-readable inspection output", () => {
    expect(parseCliArguments(["inspect", "--json", "--dsh-path", "/opt/dsh"])).toEqual({
      kind: "inspect",
      options: { dshPath: "/opt/dsh" },
    });
    expect(parseCliArguments(["doctor", "--json", "--dsh-home", "/state/dsh"])).toEqual({
      kind: "doctor",
      options: { dshHome: "/state/dsh" },
    });
    expect(parseCliArguments(["doctor", "--json", "--dsh-root", "/opt/dsh"])).toEqual({
      kind: "doctor",
      options: { dshPath: "/opt/dsh" },
    });

    expect(() => parseCliArguments(["inspect"])).toThrowError(
      new CliUsageError("inspect requires --json"),
    );
  });

  it("rejects duplicate, unknown, and incomplete options", () => {
    expect(() =>
      parseCliArguments(["serve", "--dsh-path", "/one", "--candidate", "/two"]),
    ).toThrow(/specified only once/);
    expect(() => parseCliArguments(["doctor", "--json", "--wat"])).toThrow(
      /unknown option/,
    );
    expect(() => parseCliArguments(["serve", "--node"])).toThrow(/requires a value/);
    expect(() => parseCliArguments(["unknown"])).toThrow(/Unknown command/);
  });

  it("requires the exact host-enforced external confinement value", () => {
    expect(parseCliArguments([
      "serve",
      "--external-process-confinement",
      "host-enforced",
    ])).toEqual({
      kind: "serve",
      options: { externalProcessConfinement: "host-enforced" },
    });
    expect(() => parseCliArguments([
      "serve",
      "--external-process-confinement",
      "unverified",
    ])).toThrow(CliUsageError);
  });
});
