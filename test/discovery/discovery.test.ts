import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertDshUnchanged,
  doctorDsh,
  inspectDsh,
  type DshInstallation,
} from "../../src/discovery/index.js";
import { createDshFixture } from "./fixture.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<Awaited<ReturnType<typeof createDshFixture>>> {
  const value = await createDshFixture();
  cleanup.push(value.container);
  return value;
}

function installationOf(result: Awaited<ReturnType<typeof inspectDsh>>): DshInstallation {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.installation;
}

describe("DSH discovery", () => {
  it("validates an explicit source root and returns JSON-safe diagnostics", async () => {
    const value = await fixture();
    const result = await inspectDsh({ dshPath: value.root, homeDir: value.home });
    const installation = installationOf(result);

    expect(installation.driverId).toBe("dsh-source-0.0.1");
    expect(installation.version).toBe("0.0.1");
    expect(installation.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(installation.rootPath).toBe(value.root);
    expect(installation.validatedFiles).toEqual(expect.arrayContaining([
      "vendor/include/src/index.ts",
      "vendor/loader/src/index.ts",
      "packages/ui/permission/src/index.ts",
      "packages/sandbox/sandbox-policy/src/session-mode.ts",
      "packages/sandbox/sandbox-local/src/profiles.ts",
      "packages/bash/bash-sandbox/src/index.ts",
      "packages/bash/tool-bash/src/index.ts",
      "packages/fs/fs-sandbox/src/containment.ts",
      "packages/fs/tool-fs/src/write.ts",
      "packages/subprocess/subprocess-local/src/spawn.ts",
      "packages/web/web-search-deepseek/src/provider.ts",
      "packages/session-persistence/session-persistence/src/coordinator.ts",
      "packages/session-query/session-query-sqlite/src/query.ts",
      "packages/mcp/mcp-client/src/transport.ts",
      "packages/mcp/mcp-client/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js",
      "packages/subprocess/subprocess/src/index.ts",
    ]));
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("honours DSH_PATH and resolves a launcher symlink to its physical checkout", async () => {
    const value = await fixture();
    const binDir = join(value.container, "bin-links");
    await mkdir(binDir);
    const link = join(binDir, "dsh");
    await symlink(join(value.root, "bin/dsh"), link);

    const result = await inspectDsh({ env: { DSH_PATH: link, PATH: "" }, homeDir: value.home });
    const installation = installationOf(result);
    expect(installation.source).toBe("environment");
    expect(installation.entryKind).toBe("launcher");
    expect(installation.entryPath).toBe(link);
    expect(installation.rootPath).toBe(value.root);
  });

  it("discovers the official current symlink before PATH", async () => {
    const value = await fixture();
    const source = join(value.home, ".dsh/source");
    await mkdir(source, { recursive: true });
    await symlink(value.root, join(source, "current"));

    const result = await inspectDsh({ homeDir: value.home, env: { PATH: "" } });
    const installation = installationOf(result);
    expect(installation.source).toBe("official-current");
    expect(installation.rootPath).toBe(value.root);
  });

  it("rejects an unrelated executable that merely has the dsh basename", async () => {
    const value = await fixture();
    const fakeBin = join(value.container, "fake-bin");
    await mkdir(fakeBin);
    const fake = join(fakeBin, "dsh");
    await writeFile(fake, "#!/bin/sh\necho unrelated\n", "utf8");
    await chmod(fake, 0o755);

    const result = await inspectDsh({ homeDir: value.home, env: { PATH: fakeBin } });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected compatible result");
    expect(result.error.code).toBe("DSH_INCOMPATIBLE");
    expect(result.attempts).toContainEqual(expect.objectContaining({
      source: "path",
      status: "rejected",
      code: "DSH_BASENAME_COLLISION",
    }));
  });

  it("fails closed for an unknown DSH package version", async () => {
    const value = await fixture();
    const packagePath = join(value.root, "package.json");
    const manifest = JSON.parse(await readFile(packagePath, "utf8")) as Record<string, unknown>;
    manifest["version"] = "0.0.2";
    await writeFile(packagePath, `${JSON.stringify(manifest)}\n`, "utf8");

    const result = await inspectDsh({ dshPath: value.root, homeDir: value.home });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected compatible result");
    expect(result.attempts[0]).toMatchObject({ code: "DSH_UNSUPPORTED_VERSION", status: "rejected" });
  });

  it("detects content drift between inspection and runtime boot", async () => {
    const value = await fixture();
    const installation = installationOf(await inspectDsh({ dshPath: value.root, homeDir: value.home }));
    await writeFile(join(value.root, "packages/core/agent/src/types.ts"), "export const changed = true\n", "utf8");

    await expect(assertDshUnchanged(installation)).rejects.toMatchObject({ code: "DSH_INSTALLATION_CHANGED" });
  });

  it("detects drift in the reviewed loader and security integration seam", async () => {
    const value = await fixture();
    const installation = installationOf(await inspectDsh({ dshPath: value.root, homeDir: value.home }));
    await writeFile(
      join(value.root, "packages/sandbox/sandbox-local/src/profiles.ts"),
      "export const unsafeDrift = true\n",
      "utf8",
    );

    await expect(assertDshUnchanged(installation)).rejects.toMatchObject({ code: "DSH_INSTALLATION_CHANGED" });
  });

  it("binds the native esbuild child executable into the runtime fingerprint", async () => {
    const value = await fixture();
    const installation = installationOf(await inspectDsh({ dshPath: value.root, homeDir: value.home }));
    await writeFile(installation.tsxEsbuildBinaryPath, "changed native runtime\n", "utf8");

    await expect(assertDshUnchanged(installation)).rejects.toMatchObject({
      code: "DSH_INSTALLATION_CHANGED",
    });
  });

  it("fails closed when a concrete enforcement file is absent", async () => {
    const value = await fixture();
    await rm(join(value.root, "packages/fs/fs-sandbox/src/containment.ts"));

    const result = await inspectDsh({ dshPath: value.root, homeDir: value.home });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected compatible result");
    expect(result.attempts[0]).toMatchObject({ code: "DSH_LAYOUT_MISSING", status: "rejected" });
  });

  it("detects an atomic official-current repoint even when both trees have the same content", async () => {
    const first = await fixture();
    const second = await fixture();
    const source = join(first.home, ".dsh/source");
    await mkdir(source, { recursive: true });
    const current = join(source, "current");
    await symlink(first.root, current);
    const installation = installationOf(await inspectDsh({ homeDir: first.home, env: { PATH: "" } }));
    await rm(current);
    await symlink(second.root, current);

    await expect(assertDshUnchanged(installation)).rejects.toMatchObject({ code: "DSH_INSTALLATION_CHANGED" });
  });

  it("returns a complete JSON-safe doctor report", async () => {
    const value = await fixture();
    const doctor = await doctorDsh({ dshPath: value.root, homeDir: value.home });
    expect(doctor.ok).toBe(true);
    expect(doctor.checks.map(check => check.status)).toEqual(["pass", "pass", "pass", "pass", "pass", "pass"]);
    expect(() => JSON.stringify(doctor)).not.toThrow();
  });
});
