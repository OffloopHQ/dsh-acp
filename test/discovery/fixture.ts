import { mkdtemp, mkdir, writeFile, chmod, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DSH_001_FINGERPRINT_FILES } from "../../src/discovery/index.js";

const PACKAGE_FILES: Readonly<Record<string, unknown>> = {
  "package.json": {
    name: "@deepseek-ai/dsh-root",
    version: "0.0.1",
    private: true,
    type: "module",
  },
  "apps/cli/package.json": {
    name: "@deepseek-ai/dsh",
    version: "0.0.1",
    private: true,
    type: "module",
    bin: { dsh: "lib/bin.js" },
  },
  "node_modules/tsx/package.json": { name: "tsx", version: "4.22.4", type: "module" },
  "packages/ui/app-boot/package.json": { name: "@deepseek-ai/dsh-app-boot", version: "0.0.1" },
  "packages/core/agent/package.json": { name: "@deepseek-ai/dsh-agent", version: "0.0.1" },
  "packages/core/session/package.json": { name: "@deepseek-ai/dsh-session", version: "0.0.1" },
  "packages/llm/llm/package.json": { name: "@deepseek-ai/dsh-llm", version: "0.0.1" },
  "packages/ui/user-approval/package.json": { name: "@deepseek-ai/dsh-user-approval", version: "0.0.1" },
};

function structuralPackage(relativePath: string): Readonly<Record<string, unknown>> {
  return {
    name: `@fixture/${relativePath.replace(/\/package\.json$/u, "").replaceAll("/", "-")}`,
    version: "0.0.1",
    private: true,
    type: "module",
  };
}

export interface DshFixture {
  readonly container: string;
  readonly root: string;
  readonly home: string;
}

export async function createDshFixture(label = "dsh-acp-fixture-"): Promise<DshFixture> {
  const container = await mkdtemp(join(tmpdir(), label));
  const root = join(container, "dsh-root");
  const home = join(container, "home");
  await mkdir(home, { recursive: true });
  for (const relativePath of DSH_001_FINGERPRINT_FILES) {
    const absolute = join(root, relativePath);
    await mkdir(dirname(absolute), { recursive: true });
    const manifest = PACKAGE_FILES[relativePath]
      ?? (relativePath.endsWith("/package.json") || relativePath === "package.json"
        ? structuralPackage(relativePath)
        : undefined);
    const content = manifest === undefined
      ? relativePath === "bin/dsh"
        ? "#!/bin/sh\nexit 0\n"
        : `// structural fixture for ${relativePath}\nexport const fixture = true\n`
      : `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(absolute, content, "utf8");
  }
  await chmod(join(root, "bin/dsh"), 0o755);
  return {
    container: await realpath(container),
    root: await realpath(root),
    home: await realpath(home),
  };
}
