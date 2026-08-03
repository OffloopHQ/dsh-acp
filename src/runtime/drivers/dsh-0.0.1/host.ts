import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import { redactDiagnosticText } from "../../../logger.js";
import { RuntimeCompatibilityError } from "../../types.js";
import type { RuntimeMcpServer } from "../../types.js";
import { assertDshUnchanged } from "../../../discovery/index.js";
import type { DshInstallation } from "../../../discovery/index.js";

export type DshApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable";

export interface DshHostSessionHeader {
  readonly version: number;
  readonly id: string;
  readonly createdAt: number;
  readonly cwd?: string;
  readonly parentSession?: string;
  readonly seedLength?: number;
  readonly origin?: "subagent";
  readonly delegationDepth?: number;
}

export interface DshHostSession {
  readonly id: string;
  readonly header: DshHostSessionHeader;
  readonly events: readonly DshHostEvent[];
}

export interface DshHostAgent {
  readonly id: string;
  readonly session: DshHostSession;
  readonly status: string;
  followup(message: unknown): void;
  cancel(cause: { readonly kind: "user" }): void;
  whenIdle(): Promise<void>;
  steer?(message: unknown): { readonly outcome: Promise<{ readonly status: "admitted" | "rejected" }> };
}

export interface DshHostAgentHandle {
  readonly agent: DshHostAgent;
  dispose(): Promise<void>;
}

export interface DshHostEvent {
  readonly type: string;
  readonly data: unknown;
  readonly seq?: number;
  readonly time?: number;
  readonly [key: string]: unknown;
}

export interface DshHostSessionSnapshot {
  readonly session: DshHostSessionHeader;
  readonly events: readonly DshHostEvent[];
}

export interface DshHostSessionRecord {
  readonly header: DshHostSessionHeader;
  readonly live: boolean;
  readonly persisted: boolean;
}

export interface DshHostSessionTitle {
  readonly title: string;
  readonly updatedAt: number;
}

export interface DshHostApprovalRequest {
  readonly agent: DshHostAgent;
  readonly toolName: string;
  readonly callId?: string;
  readonly reason?: string;
  readonly signal?: AbortSignal;
}

export interface Dsh001Host {
  readonly route: { readonly provider: string; readonly model: string };
  /** Effective global cwd baked into DSH 0.0.1's fs/sandbox composition. */
  readonly cwd: string;
  createAgent(input: {
    readonly id: string;
    readonly cwd: string;
    readonly mcpServers: readonly RuntimeMcpServer[];
    readonly signal: AbortSignal;
    readonly seed?: readonly DshHostEvent[];
    readonly parentSession?: string;
  }): Promise<DshHostAgentHandle>;
  resumeAgent(input: {
    readonly id: string;
    readonly cwd: string;
    readonly mcpServers: readonly RuntimeMcpServer[];
    readonly signal: AbortSignal;
  }): Promise<DshHostAgentHandle>;
  readSession(id: string, signal: AbortSignal): Promise<DshHostSessionSnapshot>;
  listSessions(signal: AbortSignal): Promise<readonly DshHostSessionRecord[]>;
  readTitle(id: string, signal: AbortSignal): Promise<DshHostSessionTitle | undefined>;
  isAgentLive(agent: DshHostAgent): boolean;
  createUserMessage(text: string): unknown;
  onSessionEvent(listener: (session: DshHostSession, event: DshHostEvent) => void): () => void;
  onAgentStatus(listener: (agent: DshHostAgent, status: string) => void): () => void;
  onApproval(
    listener: (
      request: DshHostApprovalRequest,
      next: () => Promise<DshApprovalOutcome>,
    ) => Promise<DshApprovalOutcome>,
  ): () => void;
  drainContinuableDescendants(agents: readonly DshHostAgent[]): Promise<void>;
  close(): Promise<void>;
}

/** Initialization failed while a staged host/workspace cleanup still needs an owner. */
export class Dsh001HostInitializationError extends RuntimeCompatibilityError {
  readonly cleanup: () => Promise<void>;

  constructor(cause: RuntimeCompatibilityError, cleanup: () => Promise<void>) {
    super(cause.code, cause.message, cause.details);
    this.name = "Dsh001HostInitializationError";
    this.cleanup = cleanup;
  }
}

export type Dsh001HostLoader = (installation: DshInstallation) => Promise<Dsh001Host>;

interface DshAppBootModule {
  readonly boot: (
    name: string,
    configPath: string,
    patches?: readonly unknown[],
  ) => Promise<unknown>;
  readonly loadOverlayPatches: (name: string, path: string) => unknown[];
  readonly loadPersonalPatches: (name: string, path?: string) => unknown[] | undefined;
}

interface DshLlmModule {
  readonly createUserMessage: (input: {
    readonly content: readonly { readonly type: "text"; readonly text: string }[];
    readonly source: { readonly kind: "user" };
  }) => unknown;
}

interface DshMcpClientLike {
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
  setNotificationHandler(schema: unknown, handler: () => Promise<void>): void;
}

interface DshMcpModules {
  readonly Client: new (
    info: { readonly name: string; readonly version: string },
    options: { readonly capabilities: Record<string, never> },
  ) => DshMcpClientLike;
  readonly toolListChangedNotificationSchema: unknown;
  readonly StdioClientTransport: new (config: {
    readonly command: string;
    readonly args: string[];
    readonly env: Record<string, string>;
    readonly cwd: string;
    readonly stderr: "pipe";
  }) => { readonly stderr: Readable | null };
  readonly scrubbedParentEnv: () => Record<string, string>;
  readonly createTransport: (config: unknown) => unknown;
  readonly syncTools: (
    client: DshMcpClientLike,
    context: unknown,
    options: { readonly serverName: string; readonly toolCallTimeoutMs: number },
    previous: Map<string, () => void>,
  ) => Promise<Map<string, () => void>>;
}

interface CordisContextLike {
  readonly agents: {
    create(input: unknown): Promise<unknown>;
    resume(input: unknown): Promise<unknown>;
    get(id: string): unknown;
  };
  readonly fiber: { dispose(): Promise<void> };
  on(name: string, listener: (...args: never[]) => unknown): unknown;
  get(name: string): unknown;
}

interface DshSessionQueryLike {
  readSession(id: string): Promise<unknown>;
  listSessions(signal?: AbortSignal): Promise<unknown>;
  readTitle(id: string, signal?: AbortSignal): Promise<unknown>;
}

interface CordisScopedContextLike {
  readonly logger: {
    error(message: string): void;
  };
  effect(callback: () => (() => void | Promise<void>), label?: string): unknown;
}

interface PatchLike {
  readonly id?: unknown;
  readonly config?: unknown;
  readonly disabled?: unknown;
  readonly insert?: unknown;
}

let installedTsxRoot: string | undefined;

export const DSH_SESSION_MAX_EVENTS = 20_000;
export const DSH_SESSION_MAX_EVENT_SERIALIZED_BYTES = 1024 * 1024;
export const DSH_SESSION_MAX_TOTAL_SERIALIZED_BYTES = 16 * 1024 * 1024;
export const DSH_SESSION_MAX_TITLE_BYTES = 4 * 1024;
export const DSH_SESSION_MAX_RECORDS = 20_000;
export const DSH_SESSION_MAX_RECORDS_SERIALIZED_BYTES = 16 * 1024 * 1024;
export const DSH_MCP_STDERR_MAX_LINE_BYTES = 4 * 1024;
export const DSH_MCP_STDERR_MAX_TOTAL_BYTES = 64 * 1024;
export const DSH_MCP_STDERR_MAX_LINES = 64;
const DSH_MCP_STDERR_SCAN_BYTES = 32 * 1024;

// Exact row ids in DSH 0.0.1's shipped base composition that can introduce a
// built-in network side channel independent of the selected model transport.
// Optional Exa, Perplexity, and local-fetch packages have no shipped rows, and
// surfacePatches() rejects personal insert lists before Loader sees them.
export const DSH_001_DISABLED_NETWORK_PATCH_IDS = Object.freeze([
  "repository-plugins",
  "web",
  "web-search-deepseek",
  "tool-web",
  "telemetry-otel",
] as const);

export const DSH_001_DISABLED_NETWORK_TOOL_NAMES = Object.freeze([
  "web_search",
  "web_fetch",
] as const);

interface Dsh001BootWorkspace {
  readonly configPath: string;
  cleanup(): Promise<void>;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function drainIncludeWrites(configPath: string): Promise<void> {
  // DSH's vendored Include schedules a zero-delay atomic rewrite when Loader
  // children update or dispose. Keep its writable target adapter-owned, then
  // wait for two quiet observations before deleting the workspace so the
  // detached async writer cannot race cleanup.
  let quietObservations = 0;
  for (let attempt = 0; attempt < 100 && quietObservations < 2; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    quietObservations = await pathExists(`${configPath}.tmp`)
      ? 0
      : quietObservations + 1;
  }
}

/**
 * Give Loader a disposable config tree. The DSH Include implementation may
 * atomically rewrite its config during ordinary shutdown; pointing it at the
 * installed checkout would mutate user-owned DSH and fails for read-only
 * installations. Bare package resolution still uses the exact validated DSH
 * node_modules tree through this adapter-owned link.
 */
export async function createDsh001BootWorkspace(
  installation: DshInstallation,
): Promise<Dsh001BootWorkspace> {
  const directory = await mkdtemp(join(tmpdir(), "dsh-acp-boot-"));
  const configPath = join(directory, "base.cordis.yml");
  let cleaned = false;
  let cleanupPromise: Promise<void> | undefined;
  try {
    await copyFile(
      join(installation.rootPath, "apps/cli/config/base.cordis.yml"),
      configPath,
    );
    await chmod(configPath, 0o600);
    await symlink(
      join(installation.rootPath, "node_modules"),
      join(directory, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return {
    configPath,
    async cleanup() {
      if (cleaned) return;
      cleanupPromise ??= (async () => {
        await drainIncludeWrites(configPath);
        await rm(directory, { recursive: true, force: true });
        cleaned = true;
      })();
      try {
        await cleanupPromise;
      } finally {
        // A transient EBUSY/EPERM must remain retryable. Concurrent callers
        // share one attempt, while only a successful rm seals the workspace.
        if (!cleaned) cleanupPromise = undefined;
      }
    },
  };
}

/** Build a staged, retryable host closer without deleting boot state early. */
export function createDsh001HostCloser(
  disposeFiber: () => Promise<void>,
  cleanupWorkspace: () => Promise<void>,
): () => Promise<void> {
  let fiberDisposed = false;
  let closeComplete = false;
  let closePromise: Promise<void> | undefined;
  return () => {
    if (closePromise === undefined) {
      const attempt = (async () => {
        if (!fiberDisposed) {
          await disposeFiber();
          fiberDisposed = true;
        }
        await cleanupWorkspace();
        closeComplete = true;
      })();
      closePromise = attempt;
      void attempt.catch(() => {
        if (!closeComplete && closePromise === attempt) closePromise = undefined;
      });
    }
    return closePromise;
  };
}

function compatibility(code: string, message: string): RuntimeCompatibilityError {
  return new RuntimeCompatibilityError(code, message);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw compatibility("DSH_RUNTIME_LAYOUT_INVALID", `${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function requireNonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw compatibility("DSH_RUNTIME_LAYOUT_INVALID", `${label} is not a non-negative safe integer`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw compatibility("DSH_RUNTIME_LAYOUT_INVALID", `${label} is not a non-empty string`);
  }
  return value;
}

function requireSessionHeader(value: unknown, label: string): DshHostSessionHeader {
  const header = asRecord(value, label);
  const id = requireNonEmptyString(header["id"], `${label}.id`);
  const version = requireNonNegativeSafeInteger(header["version"], `${label}.version`);
  if (version !== 0) {
    throw compatibility("DSH_RUNTIME_LAYOUT_INVALID", `${label}.version is not the supported value 0`);
  }
  const createdAt = requireNonNegativeSafeInteger(header["createdAt"], `${label}.createdAt`);
  const cwd = header["cwd"];
  if (cwd !== undefined && (typeof cwd !== "string" || !isAbsolute(cwd))) {
    throw compatibility("DSH_RUNTIME_LAYOUT_INVALID", `${label}.cwd is not an absolute path`);
  }
  const parentSession = header["parentSession"];
  if (parentSession !== undefined) {
    requireNonEmptyString(parentSession, `${label}.parentSession`);
  }
  const seedLength = header["seedLength"];
  if (seedLength !== undefined) {
    requireNonNegativeSafeInteger(seedLength, `${label}.seedLength`);
  }
  const origin = header["origin"];
  if (origin !== undefined && origin !== "subagent") {
    throw compatibility("DSH_RUNTIME_LAYOUT_INVALID", `${label}.origin is unsupported`);
  }
  const delegationDepth = header["delegationDepth"];
  if (delegationDepth !== undefined) {
    requireNonNegativeSafeInteger(delegationDepth, `${label}.delegationDepth`);
  }
  return {
    version,
    id,
    createdAt,
    ...(cwd === undefined ? {} : { cwd }),
    ...(parentSession === undefined ? {} : { parentSession: parentSession as string }),
    ...(seedLength === undefined ? {} : { seedLength: seedLength as number }),
    ...(origin === undefined ? {} : { origin: "subagent" as const }),
    ...(delegationDepth === undefined ? {} : { delegationDepth: delegationDepth as number }),
  };
}

function requireSessionEvent(
  value: unknown,
  index: number,
  label: string,
  state: { serializedBytes: number },
): DshHostEvent {
  const event = asRecord(value, `${label}[${String(index)}]`);
  const type = requireNonEmptyString(event["type"], `${label}[${String(index)}].type`);
  const seq = requireNonNegativeSafeInteger(event["seq"], `${label}[${String(index)}].seq`);
  const time = requireNonNegativeSafeInteger(event["time"], `${label}[${String(index)}].time`);
  if (seq !== index) {
    throw compatibility(
      "DSH_RUNTIME_LAYOUT_INVALID",
      `${label}[${String(index)}].seq is ${String(seq)} instead of ${String(index)}`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(event, "data")) {
    throw compatibility("DSH_RUNTIME_LAYOUT_INVALID", `${label}[${String(index)}] has no data`);
  }
  const eventLabel = `${label}[${String(index)}]`;
  const encoded = encodeLosslessJson(event, eventLabel);
  const serializedBytes = Buffer.byteLength(encoded, "utf8");
  if (serializedBytes > DSH_SESSION_MAX_EVENT_SERIALIZED_BYTES) {
    throw compatibility(
      "DSH_SESSION_HISTORY_LIMIT",
      `${eventLabel} exceeds the per-event serialized byte limit`,
    );
  }
  state.serializedBytes += serializedBytes;
  if (state.serializedBytes > DSH_SESSION_MAX_TOTAL_SERIALIZED_BYTES) {
    throw compatibility(
      "DSH_SESSION_HISTORY_LIMIT",
      `${label} exceeds the total serialized byte limit`,
    );
  }
  const cloned = JSON.parse(encoded) as unknown;
  // The checks above pin the public envelope while the lossless clone keeps
  // merge-extended fields such as surfaceOp that are required by a fork seed.
  return cloned as DshHostEvent;
}

function encodeLosslessJson(value: unknown, label: string): string {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value, (_key, child: unknown) => {
      if (typeof child === "number" && !Number.isFinite(child)) throw new TypeError("non-finite number");
      if (typeof child === "undefined" || typeof child === "function"
        || typeof child === "symbol" || typeof child === "bigint") {
        throw new TypeError(`unsupported ${typeof child}`);
      }
      return child;
    });
  } catch {
    throw compatibility(
      "DSH_RUNTIME_LAYOUT_INVALID",
      `${label} is not losslessly JSON-serializable`,
    );
  }
  if (encoded === undefined) {
    throw compatibility(
      "DSH_RUNTIME_LAYOUT_INVALID",
      `${label} is not losslessly JSON-serializable`,
    );
  }
  return encoded;
}

function requireSessionEvents(value: unknown, label: string): readonly DshHostEvent[] {
  if (!Array.isArray(value)) {
    throw compatibility("DSH_RUNTIME_LAYOUT_INVALID", `${label} is not an array`);
  }
  if (value.length > DSH_SESSION_MAX_EVENTS) {
    throw compatibility("DSH_SESSION_HISTORY_LIMIT", `${label} exceeds the event count limit`);
  }
  const state = { serializedBytes: 0 };
  return value.map((event, index) => requireSessionEvent(event, index, label, state));
}

function requireSessionSnapshot(value: unknown, label: string): DshHostSessionSnapshot {
  const snapshot = asRecord(value, label);
  return {
    session: requireSessionHeader(snapshot["session"], `${label}.session`),
    events: requireSessionEvents(snapshot["events"], `${label}.events`),
  };
}

/** Validate and bound one untrusted DSH sessionQuery snapshot. */
export function validateDsh001SessionSnapshot(value: unknown): DshHostSessionSnapshot {
  return requireSessionSnapshot(value, "DSH session snapshot");
}

function requireSessionRecords(value: unknown): readonly DshHostSessionRecord[] {
  if (!Array.isArray(value)) {
    throw compatibility("DSH_RUNTIME_LAYOUT_INVALID", "DSH sessionQuery.listSessions() did not return an array");
  }
  if (value.length > DSH_SESSION_MAX_RECORDS) {
    throw compatibility("DSH_SESSION_HISTORY_LIMIT", "DSH session list exceeds the record count limit");
  }
  const ids = new Set<string>();
  let serializedBytes = 0;
  return value.map((candidate, index): DshHostSessionRecord => {
    serializedBytes += Buffer.byteLength(
      encodeLosslessJson(candidate, `DSH session record ${String(index)}`),
      "utf8",
    );
    if (serializedBytes > DSH_SESSION_MAX_RECORDS_SERIALIZED_BYTES) {
      throw compatibility("DSH_SESSION_HISTORY_LIMIT", "DSH session list exceeds the serialized byte limit");
    }
    const record = asRecord(candidate, `DSH session record ${String(index)}`);
    const header = requireSessionHeader(record["header"], `DSH session record ${String(index)}.header`);
    if (ids.has(header.id)) {
      throw compatibility("DSH_RUNTIME_LAYOUT_INVALID", `DSH session list contains duplicate id ${header.id}`);
    }
    ids.add(header.id);
    if (typeof record["live"] !== "boolean" || typeof record["persisted"] !== "boolean") {
      throw compatibility(
        "DSH_RUNTIME_LAYOUT_INVALID",
        `DSH session record ${String(index)} has invalid source availability`,
      );
    }
    return { header, live: record["live"], persisted: record["persisted"] };
  });
}

/** Validate and bound the untrusted list projection before sorting or hashing. */
export function validateDsh001SessionRecords(value: unknown): readonly DshHostSessionRecord[] {
  return requireSessionRecords(value);
}

function requireSessionTitle(value: unknown): DshHostSessionTitle | undefined {
  if (value === undefined) return undefined;
  const title = asRecord(value, "DSH session title");
  const text = requireNonEmptyString(title["title"], "DSH session title.title");
  if (Buffer.byteLength(text, "utf8") > DSH_SESSION_MAX_TITLE_BYTES) {
    throw compatibility("DSH_SESSION_HISTORY_LIMIT", "DSH session title exceeds the serialized byte limit");
  }
  return {
    title: text,
    updatedAt: requireNonNegativeSafeInteger(title["updatedAt"], "DSH session title.updatedAt"),
  };
}

/** Validate and bound one untrusted DSH session title projection. */
export function validateDsh001SessionTitle(value: unknown): DshHostSessionTitle | undefined {
  return requireSessionTitle(value);
}

function requireFunction<T extends (...args: never[]) => unknown>(
  module: Record<string, unknown>,
  key: string,
  label: string,
): T {
  const value = module[key];
  if (typeof value !== "function") {
    throw compatibility("DSH_RUNTIME_LAYOUT_INVALID", `${label} does not export ${key}()`);
  }
  return value as T;
}

async function importDshModules(installation: DshInstallation): Promise<{
  appBoot: DshAppBootModule;
  llm: DshLlmModule;
  mcp: DshMcpModules;
}> {
  if (installedTsxRoot !== undefined && installedTsxRoot !== installation.rootPath) {
    throw compatibility(
      "DSH_RUNTIME_CONFLICT",
      `this process already installed the TypeScript loader for ${installedTsxRoot}`,
    );
  }
  process.env["TSX_TSCONFIG_PATH"] = installation.tsconfigPath;
  process.env["DSH_HOME"] = installation.dshHomePath;
  process.env["DSH_BUNDLED_SKILL_DIR"] = join(installation.rootPath, "skills");
  // The adapter owns the authorization boundary. Never let an ambient shell
  // variable silently turn ACP's one-turn approval contract into DSH's
  // unrestricted, approval-free mode.
  process.env["DSH_PERMISSION_MODE"] = "workspace-write";
  process.env["NODE_USE_ENV_PROXY"] ??= "1";
  if (installedTsxRoot === undefined) {
    await import(pathToFileURL(installation.tsxLoaderPath).href);
    installedTsxRoot = installation.rootPath;
  }

  const appBootRaw: unknown = await import(pathToFileURL(
    join(installation.rootPath, "packages/ui/app-boot/src/index.ts"),
  ).href);
  const llmRaw: unknown = await import(pathToFileURL(
    join(installation.rootPath, "packages/llm/llm/src/index.ts"),
  ).href);
  const mcpTransportRaw: unknown = await import(pathToFileURL(
    join(installation.rootPath, "packages/mcp/mcp-client/src/transport.ts"),
  ).href);
  const mcpToolsRaw: unknown = await import(pathToFileURL(
    join(installation.rootPath, "packages/mcp/mcp-client/src/tools.ts"),
  ).href);
  const mcpSdkRaw: unknown = await import(pathToFileURL(
    join(
      installation.rootPath,
      "packages/mcp/mcp-client/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js",
    ),
  ).href);
  const mcpStdioRaw: unknown = await import(pathToFileURL(
    join(
      installation.rootPath,
      "packages/mcp/mcp-client/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js",
    ),
  ).href);
  const mcpTypesRaw: unknown = await import(pathToFileURL(
    join(
      installation.rootPath,
      "packages/mcp/mcp-client/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js",
    ),
  ).href);
  const subprocessRaw: unknown = await import(pathToFileURL(
    join(installation.rootPath, "packages/subprocess/subprocess/src/index.ts"),
  ).href);
  const appBootModule = asRecord(appBootRaw, "DSH app-boot module");
  const llmModule = asRecord(llmRaw, "DSH llm module");
  const mcpTransportModule = asRecord(mcpTransportRaw, "DSH MCP transport module");
  const mcpToolsModule = asRecord(mcpToolsRaw, "DSH MCP tools module");
  const mcpSdkModule = asRecord(mcpSdkRaw, "DSH MCP SDK client module");
  const mcpStdioModule = asRecord(mcpStdioRaw, "DSH MCP SDK stdio module");
  const mcpTypesModule = asRecord(mcpTypesRaw, "DSH MCP SDK types module");
  const subprocessModule = asRecord(subprocessRaw, "DSH subprocess module");
  const Client = mcpSdkModule["Client"];
  if (typeof Client !== "function") {
    throw compatibility("DSH_RUNTIME_LAYOUT_INVALID", "DSH MCP SDK client module does not export Client");
  }
  const toolListChangedNotificationSchema = mcpTypesModule["ToolListChangedNotificationSchema"];
  if (toolListChangedNotificationSchema === undefined) {
    throw compatibility(
      "DSH_RUNTIME_LAYOUT_INVALID",
      "DSH MCP SDK types module does not export ToolListChangedNotificationSchema",
    );
  }
  const StdioClientTransport = mcpStdioModule["StdioClientTransport"];
  if (typeof StdioClientTransport !== "function") {
    throw compatibility("DSH_RUNTIME_LAYOUT_INVALID", "DSH MCP SDK stdio module does not export StdioClientTransport");
  }
  const scrubbedParentEnv = subprocessModule["scrubbedParentEnv"];
  if (typeof scrubbedParentEnv !== "function") {
    throw compatibility("DSH_RUNTIME_LAYOUT_INVALID", "DSH subprocess module does not export scrubbedParentEnv");
  }
  return {
    appBoot: {
      boot: requireFunction(appBootModule, "boot", "DSH app-boot module"),
      loadOverlayPatches: requireFunction(appBootModule, "loadOverlayPatches", "DSH app-boot module"),
      loadPersonalPatches: requireFunction(appBootModule, "loadPersonalPatches", "DSH app-boot module"),
    },
    llm: {
      createUserMessage: requireFunction(llmModule, "createUserMessage", "DSH llm module"),
    },
    mcp: {
      Client: Client as DshMcpModules["Client"],
      toolListChangedNotificationSchema,
      StdioClientTransport: StdioClientTransport as DshMcpModules["StdioClientTransport"],
      scrubbedParentEnv: scrubbedParentEnv as DshMcpModules["scrubbedParentEnv"],
      createTransport: requireFunction(
        mcpTransportModule,
        "createTransport",
        "DSH MCP transport module",
      ),
      syncTools: requireFunction(mcpToolsModule, "syncTools", "DSH MCP tools module"),
    },
  };
}

function surfacePatches(patches: readonly unknown[], label: string): unknown[] {
  const supportedIds = new Set(["agent-loop", "system-prompt", "llm-deepseek", "fs-sandbox", "tools"]);
  return patches.flatMap((patch): unknown[] => {
    const row = asRecord(patch, label) as PatchLike;
    if (typeof row.id !== "string" || !supportedIds.has(row.id) || row.insert !== undefined) return [];

    // Loader patches have a larger surface than this adapter needs. Rebuild
    // each accepted row instead of forwarding arbitrary keys from a personal
    // config into the headless composition.
    const projected: { id: string; config?: unknown; disabled?: boolean } = { id: row.id };
    if (row.config !== undefined) projected.config = row.config;
    if (typeof row.disabled === "boolean") projected.disabled = row.disabled;
    return [projected];
  });
}

function resolveRoute(patches: readonly unknown[]): { provider: string; model: string } {
  let route: { provider: string; model: string } | undefined;
  let disabled = false;
  for (const patch of patches) {
    const row = asRecord(patch, "DSH route patch") as PatchLike;
    if (row.id !== "agent-loop") continue;
    if (typeof row.disabled === "boolean") disabled = row.disabled;
    const config = row.config;
    if (config === undefined) continue;
    // A patch replaces this row's complete config. Clear the earlier route
    // before reading it so an empty/invalid personal override cannot silently
    // fall back to the shipped model.
    route = undefined;
    if (config === null || typeof config !== "object" || Array.isArray(config)) continue;
    const agents = (config as Record<string, unknown>)["agents"];
    if (!Array.isArray(agents)) continue;
    const main = agents.find((agent: unknown) => {
      return agent !== null && typeof agent === "object" && !Array.isArray(agent)
        && (agent as Record<string, unknown>)["id"] === "main";
    }) ?? agents[0];
    if (main === null || typeof main !== "object" || Array.isArray(main)) continue;
    const provider = (main as Record<string, unknown>)["provider"];
    const model = (main as Record<string, unknown>)["model"];
    if (typeof provider === "string" && provider.length > 0
      && typeof model === "string" && model.length > 0) {
      route = { provider, model };
    }
  }
  if (disabled || route === undefined) {
    throw compatibility(
      "DSH_ROUTE_UNAVAILABLE",
      "the effective DSH TUI configuration does not provide an enabled main provider/model route",
    );
  }
  return route;
}

export interface Dsh001BootPlan {
  readonly route: { readonly provider: string; readonly model: string };
  readonly patches: readonly unknown[];
}

/**
 * Compose the non-UI DSH surface. Built-in web tools, repository plugins, and
 * telemetry are disabled unconditionally. The selected model transport and
 * ACP-explicit MCP servers are separate, caller-visible network boundaries.
 */
export function createDsh001BootPlan(
  tuiPatches: readonly unknown[],
  personalPatches: readonly unknown[],
): Dsh001BootPlan {
  const shippedSurface = surfacePatches(tuiPatches, "DSH TUI overlay patch");
  const personalSurface = surfacePatches(personalPatches, "DSH personal overlay patch");
  const route = resolveRoute([...shippedSurface, ...personalSurface]);
  return {
    route,
    patches: [
      ...shippedSurface,
      ...personalSurface,
      { id: "agent-loop", disabled: false, config: { agents: [] } },
      // These final patches are adapter authority. Personal config can select
      // a provider/model and prompt surface, but cannot widen filesystem or
      // approval policy behind the ACP client's back.
      {
        id: "sandbox-policy",
        disabled: false,
        config: { mode: "workspace-write", workspaceRoot: process.cwd() },
      },
      { id: "approval", disabled: false, config: { policy: "ask" } },
      {
        id: "permission",
        disabled: false,
        config: {
          defaultPreset: "workspace-write",
          presets: {
            "read-only": { sandbox: "read-only", approval: "ask" },
            "workspace-write": { sandbox: "workspace-write", approval: "ask" },
          },
        },
      },
      { id: "hmr", disabled: true },
      { id: "session-query-sqlite", config: { path: ":memory:", openAt: "first-search" } },
      ...DSH_001_DISABLED_NETWORK_PATCH_IDS.map(id => ({ id, disabled: true })),
    ],
  };
}

function requireContext(value: unknown): CordisContextLike {
  const record = asRecord(value, "DSH boot context");
  const agents = asRecord(record["agents"], "DSH agents service");
  const fiber = asRecord(record["fiber"], "DSH root fiber");
  if (typeof agents["create"] !== "function" || typeof agents["resume"] !== "function"
    || typeof agents["get"] !== "function"
    || typeof fiber["dispose"] !== "function" || typeof record["on"] !== "function"
    || typeof record["get"] !== "function") {
    throw compatibility("DSH_RUNTIME_LAYOUT_INVALID", "DSH boot context is missing required 0.0.1 services");
  }
  return value as CordisContextLike;
}

/**
 * Verify the settled Cordis composition rather than trusting patch intent
 * alone. HMR and repository plugin loading are disabled, so this global
 * catalog is stable after boot; ACP-explicit MCP tools are installed later in
 * an individual Agent scope and are not part of this built-in boundary.
 */
export function assertDsh001NetworkSurfaceDisabled(
  context: Pick<CordisContextLike, "get">,
): void {
  if (context.get("web") !== undefined) {
    throw compatibility(
      "DSH_NETWORK_SURFACE_ENABLED",
      "the settled DSH composition unexpectedly exposes its built-in web service",
    );
  }

  const tools = asRecord(context.get("tools"), "DSH tools service");
  const schemas = requireFunction<() => unknown>(tools, "schemas", "DSH tools service");
  let rawCatalog: unknown;
  try {
    rawCatalog = schemas.call(tools);
  } catch {
    throw compatibility(
      "DSH_RUNTIME_LAYOUT_INVALID",
      "DSH tools service could not project its settled catalog",
    );
  }
  if (!Array.isArray(rawCatalog)) {
    throw compatibility(
      "DSH_RUNTIME_LAYOUT_INVALID",
      "DSH tools service returned a non-array catalog",
    );
  }

  const disabledNames = new Set<string>(DSH_001_DISABLED_NETWORK_TOOL_NAMES);
  for (let index = 0; index < rawCatalog.length; index += 1) {
    const schema = asRecord(rawCatalog[index], `DSH tool catalog entry ${String(index)}`);
    const name = requireNonEmptyString(schema["name"], `DSH tool catalog entry ${String(index)}.name`);
    if (disabledNames.has(name)) {
      throw compatibility(
        "DSH_NETWORK_SURFACE_ENABLED",
        "the settled DSH tool catalog unexpectedly exposes a built-in network tool",
      );
    }
  }
}

function requireSessionQuery(value: unknown): DshSessionQueryLike {
  const service = asRecord(value, "DSH sessionQuery service");
  if (typeof service["readSession"] !== "function"
    || typeof service["listSessions"] !== "function"
    || typeof service["readTitle"] !== "function") {
    throw compatibility(
      "DSH_RUNTIME_LAYOUT_INVALID",
      "DSH sessionQuery service is missing readSession/listSessions/readTitle",
    );
  }
  return value as DshSessionQueryLike;
}

function requireScopedContext(value: unknown): CordisScopedContextLike {
  const record = asRecord(value, "DSH scoped Agent context");
  const logger = asRecord(record["logger"], "DSH scoped Agent logger");
  if (typeof record["effect"] !== "function" || typeof logger["error"] !== "function") {
    throw compatibility(
      "DSH_RUNTIME_LAYOUT_INVALID",
      "DSH scoped Agent context is missing effect/logger services required for MCP ownership",
    );
  }
  return value as CordisScopedContextLike;
}

const DSH_MCP_SETUP_TIMEOUT_MS = 15_000;
const DSH_MCP_TOOL_CALL_TIMEOUT_MS = 60_000;

interface DshMcpConfig {
  readonly transport: "stdio" | "streamable-http";
  readonly serverName: string;
  readonly toolCallTimeoutMs: number;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    output += character;
    bytes += size;
  }
  return output;
}

function drainMcpStderr(stream: Readable, logger: CordisScopedContextLike["logger"]): void {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let pendingBytes = 0;
  let lineTruncated = false;
  let emittedBytes = 0;
  let emittedLines = 0;
  let observedLines = 0;

  const emit = (): void => {
    observedLines += 1;
    if (observedLines > DSH_MCP_STDERR_MAX_LINES
      || emittedLines >= DSH_MCP_STDERR_MAX_LINES
      || emittedBytes >= DSH_MCP_STDERR_MAX_TOTAL_BYTES) {
      pending = "";
      pendingBytes = 0;
      lineTruncated = false;
      return;
    }
    const raw = pending.replace(/\r$/u, "");
    pending = "";
    pendingBytes = 0;
    if (raw.length === 0 && !lineTruncated) return;
    const marker = lineTruncated ? "...[TRUNCATED]" : "";
    lineTruncated = false;
    const prefix = "dsh-acp MCP server stderr: ";
    const safe = redactDiagnosticText(`${raw}${marker}`);
    let message = truncateUtf8(`${prefix}${safe}`, DSH_MCP_STDERR_MAX_LINE_BYTES);
    const remaining = DSH_MCP_STDERR_MAX_TOTAL_BYTES - emittedBytes;
    message = truncateUtf8(message, remaining);
    if (message.length === 0) return;
    emittedBytes += Buffer.byteLength(message, "utf8");
    emittedLines += 1;
    try {
      logger.error(message);
    } catch {
      // Diagnostics are best-effort; the data listener must remain attached
      // and draining even if the host logger itself fails.
    }
  };

  const append = (value: string): void => {
    if (lineTruncated || value.length === 0) return;
    const remaining = DSH_MCP_STDERR_SCAN_BYTES - pendingBytes;
    if (remaining <= 0) {
      lineTruncated = true;
      return;
    }
    const accepted = truncateUtf8(value, remaining);
    pending += accepted;
    pendingBytes += Buffer.byteLength(accepted, "utf8");
    if (accepted.length < value.length) lineTruncated = true;
  };

  const consume = (text: string): void => {
    if (observedLines >= DSH_MCP_STDERR_MAX_LINES
      || emittedLines >= DSH_MCP_STDERR_MAX_LINES
      || emittedBytes >= DSH_MCP_STDERR_MAX_TOTAL_BYTES) return;
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf("\n", offset);
      if (newline < 0) {
        append(text.slice(offset));
        return;
      }
      append(text.slice(offset, newline));
      emit();
      if (observedLines >= DSH_MCP_STDERR_MAX_LINES
        || emittedLines >= DSH_MCP_STDERR_MAX_LINES
        || emittedBytes >= DSH_MCP_STDERR_MAX_TOTAL_BYTES) return;
      offset = newline + 1;
    }
  };

  stream.on("data", (chunk: string | Buffer | Uint8Array) => {
    consume(typeof chunk === "string" ? chunk : decoder.write(Buffer.from(chunk)));
  });
  stream.once("end", () => {
    consume(decoder.end());
    if (pending.length > 0 || lineTruncated) emit();
  });
  // A transport stream error must not become an unhandled process error or
  // expose its potentially secret-bearing raw message.
  stream.once("error", () => {
    append("MCP stderr stream failed");
    emit();
  });
}

function createOwnedMcpTransport(
  config: DshMcpConfig,
  modules: DshMcpModules,
  logger: CordisScopedContextLike["logger"],
): unknown {
  if (config.transport !== "stdio") return modules.createTransport(config);
  if (config.command === undefined || config.cwd === undefined) {
    throw compatibility("DSH_RUNTIME_LAYOUT_INVALID", "DSH stdio MCP config is incomplete");
  }
  const transport = new modules.StdioClientTransport({
    command: config.command,
    args: [...(config.args ?? [])],
    env: { ...modules.scrubbedParentEnv(), ...(config.env ?? {}) },
    cwd: config.cwd,
    stderr: "pipe",
  });
  if (transport.stderr === null) {
    throw compatibility("DSH_RUNTIME_LAYOUT_INVALID", "DSH MCP SDK did not expose the requested stderr pipe");
  }
  // Attach before Client.connect() starts the child so even its earliest
  // diagnostic bytes are drained instead of blocking or reaching ambient
  // process stderr.
  drainMcpStderr(transport.stderr, logger);
  return transport;
}

function mcpNamespace(name: string): string {
  if (name.length === 0 || name.includes("\0")) {
    throw compatibility("DSH_MCP_CONFIG_INVALID", "MCP server names must be non-empty and contain no NUL bytes");
  }
  const normalized = name.replace(/[^A-Za-z0-9_-]/g, "_");
  if (normalized === name && normalized.length <= 32) return normalized;
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 10);
  const prefix = (normalized || "server").slice(0, 21);
  return `${prefix}_${hash}`;
}

function assertNoNul(value: string, label: string): void {
  if (value.includes("\0")) {
    throw compatibility("DSH_MCP_CONFIG_INVALID", `${label} contains a NUL byte`);
  }
}

/** Convert ACP MCP inputs into the exact configuration consumed by DSH 0.0.1. */
export function createDsh001McpConfigs(
  servers: readonly RuntimeMcpServer[],
  cwd: string,
): readonly DshMcpConfig[] {
  const namespaces = new Set<string>();
  return servers.map((server): DshMcpConfig => {
    const serverName = mcpNamespace(server.name);
    if (namespaces.has(serverName)) {
      throw compatibility(
        "DSH_MCP_CONFIG_INVALID",
        `MCP server name ${JSON.stringify(server.name)} collides with another configured server`,
      );
    }
    namespaces.add(serverName);
    if (server.transport === "stdio") {
      if (!isAbsolute(server.command)) {
        throw compatibility(
          "DSH_MCP_CONFIG_INVALID",
          `MCP stdio command must be an absolute path: ${server.command}`,
        );
      }
      assertNoNul(server.command, `MCP server ${server.name} command`);
      for (const arg of server.args) assertNoNul(arg, `MCP server ${server.name} argument`);
      for (const [key, value] of Object.entries(server.env ?? {})) {
        assertNoNul(key, `MCP server ${server.name} environment key`);
        assertNoNul(value, `MCP server ${server.name} environment value`);
        if (key.includes("=")) {
          throw compatibility(
            "DSH_MCP_CONFIG_INVALID",
            `MCP server ${server.name} environment keys cannot contain '='`,
          );
        }
      }
      return {
        transport: "stdio",
        serverName,
        command: server.command,
        args: [...server.args],
        env: { ...server.env },
        cwd,
        toolCallTimeoutMs: DSH_MCP_TOOL_CALL_TIMEOUT_MS,
      };
    }
    if (server.transport === "http") {
      let url: URL;
      try {
        url = new URL(server.url);
      } catch {
        throw compatibility("DSH_MCP_CONFIG_INVALID", `MCP server ${server.name} has an invalid URL`);
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw compatibility(
          "DSH_MCP_CONFIG_INVALID",
          `MCP server ${server.name} URL must use http or https`,
        );
      }
      for (const [key, value] of Object.entries(server.headers ?? {})) {
        assertNoNul(key, `MCP server ${server.name} header name`);
        assertNoNul(value, `MCP server ${server.name} header value`);
      }
      return {
        transport: "streamable-http",
        serverName,
        url: url.href,
        headers: { ...server.headers },
        toolCallTimeoutMs: DSH_MCP_TOOL_CALL_TIMEOUT_MS,
      };
    }
    throw compatibility("DSH_MCP_CONFIG_INVALID", "DSH 0.0.1 does not support MCP SSE transport");
  });
}

async function boundedMcpSetup<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  label: string,
): Promise<T> {
  if (signal.aborted) {
    throw compatibility("DSH_MCP_SETUP_CANCELLED", `${label} was cancelled`);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(compatibility("DSH_MCP_SETUP_CANCELLED", `${label} was cancelled`));
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbort = () => signal.removeEventListener("abort", onAbort);
    timer = setTimeout(() => {
      reject(compatibility("DSH_MCP_SETUP_TIMEOUT", `${label} exceeded ${String(DSH_MCP_SETUP_TIMEOUT_MS)}ms`));
    }, DSH_MCP_SETUP_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([operation, interrupted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeAbort?.();
  }
}

function disposeMcpToolGeneration(disposers: Map<string, () => void>): void {
  for (const dispose of disposers.values()) {
    try {
      dispose();
    } catch {
      // Disposal is best-effort, but every remaining registration still gets
      // its own attempt and the generation is always forgotten locally.
    }
  }
  disposers.clear();
}

export async function installDsh001McpServers(
  value: unknown,
  configs: readonly DshMcpConfig[],
  modules: DshMcpModules,
  signal: AbortSignal,
): Promise<void> {
  const context = requireScopedContext(value);
  for (const config of configs) {
    const client = new modules.Client(
      { name: "dsh-acp", version: "0.1.0" },
      { capabilities: {} },
    );
    let disposers = new Map<string, () => void>();
    let refresh = Promise.resolve();
    let live = true;
    let fiberOwnsClient = false;
    const refreshAbort = new AbortController();
    try {
      const connecting = client.connect(createOwnedMcpTransport(config, modules, context.logger));
      try {
        await boundedMcpSetup(
          connecting,
          signal,
          `MCP server ${config.serverName} connection`,
        );
      } catch (error) {
        // A transport that ignores cancellation may connect after our bounded
        // setup returned. Close again at that late settlement boundary so it
        // cannot outlive the unpublished Agent transaction.
        void connecting.then(
          () => client.close().catch(() => undefined),
          () => client.close().catch(() => undefined),
        );
        throw error;
      }
      const discovering = modules.syncTools(
        client,
        value,
        { serverName: config.serverName, toolCallTimeoutMs: config.toolCallTimeoutMs },
        disposers,
      );
      try {
        disposers = await boundedMcpSetup(
          discovering,
          signal,
          `MCP server ${config.serverName} initial tool discovery`,
        );
      } catch (error) {
        // syncTools can complete after the setup timeout and register a late
        // generation. Dispose that result explicitly; the local `disposers`
        // variable still owns only the prior generation.
        void discovering.then(
          (lateDisposers) => {
            disposeMcpToolGeneration(lateDisposers);
          },
          () => undefined,
        );
        throw error;
      }
      client.setNotificationHandler(modules.toolListChangedNotificationSchema, async () => {
        refresh = refresh.then(async () => {
          if (!live) return;
          const discoveringRefresh = modules.syncTools(
            client,
            value,
            { serverName: config.serverName, toolCallTimeoutMs: config.toolCallTimeoutMs },
            disposers,
          );
          try {
            const next = await boundedMcpSetup(
              discoveringRefresh,
              refreshAbort.signal,
              "MCP tool refresh",
            );
            if (!live) {
              disposeMcpToolGeneration(next);
              return;
            }
            disposers = next;
          } catch (error) {
            // syncTools may settle after cancellation/timeout and register a
            // late generation. Dispose it without ever logging its raw error.
            void discoveringRefresh.then(
              (lateDisposers) => disposeMcpToolGeneration(lateDisposers),
              () => undefined,
            );
            throw error;
          }
        }).catch(() => {
          if (live) context.logger.error("dsh-acp MCP tool refresh failed");
        });
        await refresh;
      });
      context.effect(() => async () => {
        live = false;
        refreshAbort.abort();
        // Start close first so the SDK transport can interrupt any outstanding
        // tools/list request, then bound the combined drain. Cleanup proceeds
        // even if a buggy transport ignores close.
        const closing = client.close().catch(() => undefined);
        await boundedMcpSetup(
          Promise.all([refresh.catch(() => undefined), closing]).then(() => undefined),
          new AbortController().signal,
          "MCP scope cleanup",
        ).catch(() => undefined);
        disposeMcpToolGeneration(disposers);
      }, "dsh-acp MCP server");
      fiberOwnsClient = true;
    } finally {
      if (!fiberOwnsClient) {
        live = false;
        refreshAbort.abort();
        disposeMcpToolGeneration(disposers);
        await boundedMcpSetup(
          client.close(),
          new AbortController().signal,
          "MCP setup rollback",
        ).catch(() => undefined);
      }
    }
  }
}

function requireAgentHandle(value: unknown): DshHostAgentHandle {
  const handle = asRecord(value, "DSH AgentHandle");
  const agent = asRecord(handle["agent"], "DSH Agent");
  const session = asRecord(agent["session"], "DSH Session");
  const header = requireSessionHeader(session["header"], "DSH Session.header");
  requireSessionEvents(session["events"], "DSH Session.events");
  if (typeof handle["dispose"] !== "function" || typeof agent["id"] !== "string"
    || typeof agent["followup"] !== "function" || typeof agent["cancel"] !== "function"
    || typeof agent["whenIdle"] !== "function" || typeof session["id"] !== "string"
    || typeof agent["status"] !== "string"
    || (agent["steer"] !== undefined && typeof agent["steer"] !== "function")) {
    throw compatibility("DSH_RUNTIME_LAYOUT_INVALID", "DSH AgentHandle does not match the supported 0.0.1 API");
  }
  if (agent["id"] !== session["id"] || agent["id"] !== header.id) {
    throw compatibility("DSH_RUNTIME_LAYOUT_INVALID", "DSH AgentHandle has inconsistent agent/session identity");
  }
  return value as DshHostAgentHandle;
}

function requireDisposer(value: unknown, label: string): () => void {
  if (typeof value !== "function") {
    throw compatibility("DSH_RUNTIME_LAYOUT_INVALID", `${label} did not return a disposer`);
  }
  return value as () => void;
}

/** Load the user's normal DSH composition, but own the ACP bridge independently. */
export const loadInstalledDsh001Host: Dsh001HostLoader = async (installation) => {
  await assertDshUnchanged(installation);
  const { appBoot, llm, mcp } = await importDshModules(installation);
  const bootWorkspace = await createDsh001BootWorkspace(installation);
  let route: { provider: string; model: string };
  let context: CordisContextLike;
  const closeBootWorkspace = createDsh001HostCloser(
    () => Promise.resolve(),
    () => bootWorkspace.cleanup(),
  );
  try {
    const tuiOverlay = join(installation.rootPath, "apps/cli/config/tui.cordis.yml");
    const personal = appBoot.loadPersonalPatches("dsh-acp", installation.dshHomePath) ?? [];
    const plan = createDsh001BootPlan(
      appBoot.loadOverlayPatches("dsh-acp", tuiOverlay),
      personal,
    );
    route = plan.route;
    context = requireContext(await appBoot.boot("dsh-acp", bootWorkspace.configPath, plan.patches));
  } catch (error) {
    const bootError = error instanceof RuntimeCompatibilityError
      ? error
      : compatibility("DSH_BOOT_FAILED", "DSH 0.0.1 composition failed to boot");
    try {
      await closeBootWorkspace();
    } catch {
      throw new Dsh001HostInitializationError(bootError, closeBootWorkspace);
    }
    throw bootError;
  }
  const closeHost = createDsh001HostCloser(
    () => context.fiber.dispose(),
    () => bootWorkspace.cleanup(),
  );
  let sessionQuery: DshSessionQueryLike;
  try {
    assertDsh001NetworkSurfaceDisabled(context);
    sessionQuery = requireSessionQuery(context.get("sessionQuery"));
  } catch (error) {
    const validationError = error instanceof RuntimeCompatibilityError
      ? error
      : compatibility("DSH_RUNTIME_LAYOUT_INVALID", "DSH boot validation failed");
    try {
      await closeHost();
    } catch {
      throw new Dsh001HostInitializationError(validationError, closeHost);
    }
    throw validationError;
  }

  const on = (name: string, listener: (...args: never[]) => unknown): (() => void) => {
    return requireDisposer(context.on(name, listener), `DSH ${name} listener`);
  };

  const setupMcp = (
    mcpServers: readonly RuntimeMcpServer[],
    cwd: string,
    signal: AbortSignal,
  ): { readonly setup?: (agentContext: unknown) => Promise<void> } => {
    const configs = createDsh001McpConfigs(mcpServers, cwd);
    return configs.length === 0
      ? {}
      : {
          setup: async (agentContext: unknown) => {
            await installDsh001McpServers(agentContext, configs, mcp, signal);
          },
        };
  };
  return {
    route,
    cwd: process.cwd(),
    async createAgent(input) {
      const raw = await context.agents.create({
        sessionId: input.id,
        meta: {
          cwd: input.cwd,
          ...(input.parentSession === undefined ? {} : {
            parentSession: input.parentSession,
            seedLength: input.seed?.length ?? 0,
          }),
        },
        ...(input.seed === undefined ? {} : { seed: input.seed }),
        agentOptions: route,
        signal: input.signal,
        ...setupMcp(input.mcpServers, input.cwd, input.signal),
      });
      return requireAgentHandle(raw);
    },
    async resumeAgent(input) {
      const raw = await context.agents.resume({
        resumeSessionId: input.id,
        agentOptions: route,
        signal: input.signal,
        ...setupMcp(input.mcpServers, input.cwd, input.signal),
      });
      return requireAgentHandle(raw);
    },
    async readSession(id, signal) {
      signal.throwIfAborted();
      const raw = await Reflect.apply(sessionQuery.readSession, sessionQuery, [id]);
      signal.throwIfAborted();
      const snapshot = requireSessionSnapshot(raw, "DSH sessionQuery.readSession() result");
      if (snapshot.session.id !== id) {
        throw compatibility("DSH_RUNTIME_LAYOUT_INVALID", "DSH readSession returned a mismatched identity");
      }
      return snapshot;
    },
    async listSessions(signal) {
      signal.throwIfAborted();
      const raw = await Reflect.apply(sessionQuery.listSessions, sessionQuery, [signal]);
      signal.throwIfAborted();
      return requireSessionRecords(raw);
    },
    async readTitle(id, signal) {
      signal.throwIfAborted();
      const raw = await Reflect.apply(sessionQuery.readTitle, sessionQuery, [id, signal]);
      signal.throwIfAborted();
      return requireSessionTitle(raw);
    },
    isAgentLive(agent) {
      return context.agents.get(agent.id) === agent;
    },
    createUserMessage(text) {
      return llm.createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
    },
    onSessionEvent(listener) {
      return on("session/event", listener as (...args: never[]) => unknown);
    },
    onAgentStatus(listener) {
      return on("agent/status", listener as (...args: never[]) => unknown);
    },
    onApproval(listener) {
      return on("approval/request", listener as (...args: never[]) => unknown);
    },
    async drainContinuableDescendants(agents) {
      const service = context.get("subagents");
      if (service === undefined) return;
      const record = asRecord(service, "DSH subagents service");
      const drain = record["drainContinuableDescendants"];
      if (typeof drain !== "function") {
        throw compatibility("DSH_RUNTIME_LAYOUT_INVALID", "DSH subagents service has no descendant drain API");
      }
      await Reflect.apply(drain, service, [agents]);
    },
    close() {
      return closeHost();
    },
  };
};
