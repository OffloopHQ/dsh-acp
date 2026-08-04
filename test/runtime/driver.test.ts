import { chmod, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DshAcpAgent } from "../../src/acp/agent.js";
import { inspectDsh, type DshInstallation } from "../../src/discovery/index.js";
import {
  RuntimeCompatibilityError,
  type RuntimeEvent,
  type RuntimeMcpServer,
  type RuntimePermissionRequest,
  type RuntimePromptContext,
  type RuntimeSession,
  type RuntimeSessionLoadInput,
  type RuntimeTurnResult,
} from "../../src/runtime/types.js";
import {
  DSH_EVENT_MAX_SERIALIZED_BYTES,
  DSH_EVENT_MAX_STRING_BYTES,
  DSH_APPROVAL_REASON_MAX_BYTES,
  createDsh001BootPlan,
  createDsh001BootWorkspace,
  createDsh001McpConfigs,
  DSH_PROMPT_MAX_QUEUED_EVENTS,
  DSH_PROMPT_MAX_EVENT_BYTES,
  DSH_TEARDOWN_TIMEOUT_MS,
  DSH_TOOL_RESULT_MAX_BLOCK_BYTES,
  Dsh001RuntimeDriver,
} from "../../src/runtime/drivers/dsh-0.0.1/index.js";
import { createRuntimeDriver } from "../../src/runtime/factory.js";
import { FakeAcpClient } from "../../src/testing/fake-client.js";
import { createDshFixture, type DshFixture } from "../discovery/fixture.js";
import { FakeAgent, FakeDshHost } from "./fake-host.js";
import { TEST_CLIENT_CAPABILITIES } from "../acp/helpers.js";
import {
  DSH_SESSION_MAX_EVENTS,
  DSH_SESSION_MAX_EVENT_SERIALIZED_BYTES,
  DSH_SESSION_MAX_RECORDS,
  DSH_SESSION_MAX_RECORDS_SERIALIZED_BYTES,
  DSH_SESSION_MAX_TITLE_BYTES,
  DSH_SESSION_MAX_TOTAL_SERIALIZED_BYTES,
  DSH_001_DISABLED_NETWORK_PATCH_IDS,
  DSH_001_DISABLED_NETWORK_TOOL_NAMES,
  assertDsh001NetworkSurfaceDisabled,
  validateDsh001SessionSnapshot,
  validateDsh001SessionRecords,
  validateDsh001SessionTitle,
  createDsh001HostCloser,
  Dsh001HostInitializationError,
  type DshHostEvent,
  type DshHostSessionSnapshot,
} from "../../src/runtime/drivers/dsh-0.0.1/host.js";

interface CollectedTurn {
  readonly events: RuntimeEvent[];
  readonly result: RuntimeTurnResult;
}

let fixture: DshFixture;
let installation: DshInstallation;
let host: FakeDshHost;
let driver: Dsh001RuntimeDriver;

beforeEach(async () => {
  fixture = await createDshFixture("dsh-acp-runtime-");
  const inspected = await inspectDsh({ dshPath: fixture.root, homeDir: fixture.home });
  if (!inspected.ok) throw new Error(inspected.error.message);
  installation = inspected.installation;
  host = new FakeDshHost(fixture.root);
  driver = new Dsh001RuntimeDriver(installation, { hostLoader: () => Promise.resolve(host) });
  await driver.initialize(new AbortController().signal);
});

afterEach(async () => {
  await driver.close().catch(() => undefined);
  await rm(fixture.container, { recursive: true, force: true });
});

function promptContext(
  requestPermission: RuntimePromptContext["requestPermission"] = () => Promise.resolve({ outcome: "cancelled" }),
): { readonly context: RuntimePromptContext; readonly abort: AbortController } {
  const abort = new AbortController();
  return {
    abort,
    context: {
      turnId: "turn-fixture",
      signal: abort.signal,
      requestPermission,
      requestElicitation: () => Promise.resolve({ action: "decline" }),
      readTextFile: () => Promise.resolve(""),
      writeTextFile: () => Promise.resolve(),
    },
  };
}

async function openSession(cwd = fixture.root): Promise<RuntimeSession> {
  return (await driver.newSession({
    cwd,
    additionalDirectories: [],
    mcpServers: [],
  }, new AbortController().signal)).session;
}

async function collectTurn(
  generator: AsyncGenerator<RuntimeEvent, RuntimeTurnResult, void>,
): Promise<CollectedTurn> {
  const events: RuntimeEvent[] = [];
  while (true) {
    const item = await generator.next();
    if (item.done) return { events, result: item.value };
    events.push(item.value);
  }
}

function startTurn(hostAgent: FakeAgent, turn = 1): void {
  host.emitSession(hostAgent, {
    type: "turn/start",
    data: { turn, trigger: { kind: "message", source: { kind: "user" } } },
  });
}

function storedSession(
  id: string,
  cwd = fixture.root,
  createdAt = 1_700_000_000_000,
): DshHostSessionSnapshot {
  return {
    session: { version: 0, id, createdAt, cwd },
    events: [{
      type: "turn/start",
      seq: 0,
      time: createdAt + 1,
      data: { turn: 1, trigger: { kind: "message", source: { kind: "user" } } },
    }, {
      type: "user/message",
      seq: 1,
      time: createdAt + 2,
      data: {
        id: `message-${id}`,
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: `question-${id}` }],
      },
      surfaceOp: "append",
    }, {
      type: "step/start",
      seq: 2,
      time: createdAt + 3,
      data: { turn: 1, step: 1 },
    }, {
      type: "assistant/message",
      seq: 3,
      time: createdAt + 4,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: `answer-${id}`,
          role: "assistant",
          source: { kind: "model", provider: "fixture", model: "fixture" },
          content: [{ type: "text", text: `answer-${id}` }],
        },
      },
      surfaceOp: "append",
    }, {
      type: "step/end",
      seq: 4,
      time: createdAt + 5,
      data: { turn: 1, step: 1 },
    }, {
      type: "turn/end",
      seq: 5,
      time: createdAt + 6,
      data: { turn: 1, reason: { kind: "completed" } },
    }],
  };
}

function appendStoredEvents(
  snapshot: DshHostSessionSnapshot,
  additions: readonly {
    readonly type: string;
    readonly data: unknown;
    readonly [key: string]: unknown;
  }[],
): DshHostSessionSnapshot {
  const start = snapshot.events.length;
  return {
    session: snapshot.session,
    events: [
      ...snapshot.events,
      ...additions.map((event, offset): DshHostEvent => ({
        ...event,
        seq: start + offset,
        time: snapshot.session.createdAt + start + offset + 1,
      })),
    ],
  };
}

function insertStoredEventsBeforeTurnEnd(
  snapshot: DshHostSessionSnapshot,
  additions: readonly {
    readonly type: string;
    readonly data: unknown;
    readonly [key: string]: unknown;
  }[],
): DshHostSessionSnapshot {
  const last = snapshot.events.at(-1);
  if (last?.type !== "turn/end") throw new Error("fixture has no final turn/end");
  const prefix = snapshot.events.slice(0, -1);
  const inserted = appendStoredEvents({ session: snapshot.session, events: prefix }, additions).events;
  return {
    session: snapshot.session,
    events: [...inserted, {
      ...last,
      seq: inserted.length,
      time: snapshot.session.createdAt + inserted.length + 1,
    }],
  };
}

function loadInput(
  sessionId: string,
  mcpServers: readonly RuntimeMcpServer[] = [],
): RuntimeSessionLoadInput {
  return {
    sessionId,
    cwd: fixture.root,
    additionalDirectories: [],
    mcpServers,
  };
}

async function collectReplay(events: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const output: RuntimeEvent[] = [];
  for await (const event of events) output.push(event);
  return output;
}

function forgedCursor(payload: Readonly<Record<string, unknown>>): string {
  return `dsh001.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

function sizedSessionEvent(serializedBytes: number, seq = 0): Record<string, unknown> {
  const empty = { type: "fixture", seq, time: 1, data: { text: "" } };
  const envelopeBytes = Buffer.byteLength(JSON.stringify(empty), "utf8");
  if (serializedBytes < envelopeBytes) throw new Error("fixture event target is smaller than its envelope");
  return {
    ...empty,
    data: { text: "x".repeat(serializedBytes - envelopeBytes) },
  };
}

function untrustedSessionSnapshot(
  events: readonly unknown[],
  version = 0,
): Record<string, unknown> {
  return {
    session: {
      version,
      id: "untrusted-session",
      createdAt: 1,
      cwd: fixture.root,
    },
    events,
  };
}

function sizedSessionRecord(serializedBytes: number, id = "record"): Record<string, unknown> {
  const empty = {
    header: { version: 0, id, createdAt: 1, cwd: fixture.root },
    live: false,
    persisted: true,
    padding: "",
  };
  const envelopeBytes = Buffer.byteLength(JSON.stringify(empty), "utf8");
  if (serializedBytes < envelopeBytes) throw new Error("fixture record target is smaller than its envelope");
  return { ...empty, padding: "x".repeat(serializedBytes - envelopeBytes) };
}

describe("Dsh001RuntimeDriver", () => {
  it("advertises only capabilities implemented by the source driver", () => {
    expect(driver.capabilities).toMatchObject({
      prompt: { text: true, image: false, embeddedContext: false, resourceLink: true },
      sessions: { close: true, load: true, resume: true, fork: true, list: true, delete: false },
      permissions: true,
      steering: true,
      providers: false,
      mcp: { stdio: true, http: true, sse: false },
    });
    expect([...driver.capabilities.updates]).toContain("tool_call_update");
    expect([...driver.capabilities.updates]).toContain("user_message_chunk");
  });

  it("disables built-in network plugins and projects every overlay onto the supported headless surface", () => {
    const plan = createDsh001BootPlan([{
      id: "agent-loop",
      config: { agents: [{ id: "main", provider: "p", model: "m" }] },
    }], [{
      insert: [{ id: "web", name: "@deepseek-ai/dsh-web" }],
    }, {
      id: "web",
      disabled: false,
    }, {
      id: "web-search-deepseek",
      disabled: false,
    }, {
      id: "tool-web",
      disabled: false,
    }, {
      id: "repository-plugins",
      disabled: false,
    }, {
      id: "agent-loop",
      config: { agents: [{ id: "main", provider: "personal", model: "chosen" }] },
      unexpectedLoaderField: "must-not-cross",
    }, {
      id: "system-prompt",
      config: { persona: "personal" },
    }, {
      id: "sandbox-policy",
      config: { mode: "danger-full-access" },
    }, {
      id: "permission",
      config: { defaultPreset: "danger-full-access" },
    }]);
    expect(plan.route).toEqual({ provider: "personal", model: "chosen" });
    expect(plan.patches).toContainEqual({ id: "telemetry-otel", disabled: true });
    expect(plan.patches).toContainEqual({ id: "system-prompt", config: { persona: "personal" } });
    expect(plan.patches).not.toContainEqual(expect.objectContaining({ insert: expect.anything() }));
    for (const id of DSH_001_DISABLED_NETWORK_PATCH_IDS) {
      const matching = plan.patches.filter((patch) => {
        return patch !== null && typeof patch === "object"
          && (patch as { id?: unknown }).id === id;
      });
      expect(matching).toEqual([{ id, disabled: true }]);
    }
    expect(plan.patches).not.toContainEqual(expect.objectContaining({ unexpectedLoaderField: expect.anything() }));
    expect(JSON.stringify(plan.patches)).not.toContain("danger-full-access");
    expect(plan.patches).toContainEqual({
      id: "sandbox-policy",
      disabled: false,
      config: { mode: "workspace-write", workspaceRoot: process.cwd() },
    });
    expect(plan.patches).toContainEqual({ id: "approval", disabled: false, config: { policy: "ask" } });
    expect(plan.patches).toContainEqual({
      id: "permission",
      disabled: false,
      config: {
        defaultPreset: "workspace-write",
        presets: {
          "read-only": { sandbox: "read-only", approval: "ask" },
          "workspace-write": { sandbox: "workspace-write", approval: "ask" },
        },
      },
    });
    expect(() => createDsh001BootPlan([{
      id: "agent-loop",
      config: { agents: [{ id: "main", provider: "p", model: "m" }] },
    }], [{ id: "agent-loop", config: { agents: [] } }])).toThrow("does not provide an enabled main provider/model route");
  });

  it("disables nested sandboxing only for an explicit host-enforced outer process boundary", () => {
    const plan = createDsh001BootPlan([{
      id: "agent-loop",
      config: { agents: [{ id: "main", provider: "deepseek", model: "deepseek-chat" }] },
    }], [], {
      externalProcessConfinement: "host-enforced",
    });
    expect(plan.patches).toContainEqual({
      id: "sandbox-policy",
      disabled: false,
      config: { mode: "danger-full-access", workspaceRoot: process.cwd() },
    });
    expect(plan.patches).toContainEqual({ id: "approval", disabled: false, config: { policy: "ask" } });
    expect(plan.patches).toContainEqual(expect.objectContaining({
      id: "permission",
      config: expect.objectContaining({ defaultPreset: "workspace-write" }),
    }));
  });

  it("rejects any built-in web service or web tool in the settled DSH catalog", () => {
    const context = (
      toolNames: readonly string[],
      web: unknown = undefined,
    ): { get(name: string): unknown } => ({
      get(name: string): unknown {
        if (name === "web") return web;
        if (name === "tools") {
          return {
            schemas: () => toolNames.map(toolName => ({
              name: toolName,
              description: `${toolName} fixture`,
              parameters: { type: "object" },
            })),
          };
        }
        return undefined;
      },
    });

    expect(() => assertDsh001NetworkSurfaceDisabled(context(["bash", "read", "write"])))
      .not.toThrow();
    expect(() => assertDsh001NetworkSurfaceDisabled(context(["bash"], {})))
      .toThrow(expect.objectContaining({ code: "DSH_NETWORK_SURFACE_ENABLED" }));
    for (const toolName of DSH_001_DISABLED_NETWORK_TOOL_NAMES) {
      expect(() => assertDsh001NetworkSurfaceDisabled(context(["bash", toolName])))
        .toThrow(expect.objectContaining({ code: "DSH_NETWORK_SURFACE_ENABLED" }));
    }
  });

  it("boots from an adapter-owned private copy and removes it without touching the installation", async () => {
    const sourcePath = join(installation.rootPath, "apps/cli/config/base.cordis.yml");
    const sourceBefore = await readFile(sourcePath);
    const workspace = await createDsh001BootWorkspace(installation);
    const copied = await readFile(workspace.configPath);
    const copiedStat = await stat(workspace.configPath);

    expect(copied).toEqual(sourceBefore);
    if (process.platform !== "win32") expect(copiedStat.mode & 0o777).toBe(0o600);
    await expect(realpath(join(dirname(workspace.configPath), "node_modules")))
      .resolves.toBe(await realpath(join(installation.rootPath, "node_modules")));

    await workspace.cleanup();
    await workspace.cleanup();
    await expect(stat(workspace.configPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(sourcePath)).resolves.toEqual(sourceBefore);
  });

  it("keeps failed temporary-workspace cleanup retryable", async () => {
    if (process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0)) return;
    const workspace = await createDsh001BootWorkspace(installation);
    const directory = dirname(workspace.configPath);
    await chmod(directory, 0o500);

    let firstFailure: unknown;
    try {
      await workspace.cleanup();
    } catch (error) {
      firstFailure = error;
    } finally {
      await chmod(directory, 0o700).catch(() => undefined);
    }

    expect(firstFailure).toBeDefined();
    await workspace.cleanup();
    await expect(stat(workspace.configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts only session header version zero and returns a detached lossless snapshot", () => {
    const sourceEvent = sizedSessionEvent(256);
    const source = untrustedSessionSnapshot([sourceEvent]);
    const validated = validateDsh001SessionSnapshot(source);

    expect(validated).not.toBe(source);
    expect(validated.events[0]).not.toBe(sourceEvent);
    expect(Buffer.byteLength(JSON.stringify(validated.events[0]), "utf8")).toBe(256);
    (sourceEvent["data"] as { text: string }).text = "mutated-after-validation";
    expect((validated.events[0]?.data as { text: string }).text).not.toBe("mutated-after-validation");
    expect(() => validateDsh001SessionSnapshot(untrustedSessionSnapshot([], 1)))
      .toThrow("supported value 0");
  });

  it("enforces session title, event, aggregate-byte, and event-count boundaries", () => {
    expect(validateDsh001SessionTitle({
      title: "x".repeat(DSH_SESSION_MAX_TITLE_BYTES),
      updatedAt: 1,
    })?.title).toHaveLength(DSH_SESSION_MAX_TITLE_BYTES);
    expect(() => validateDsh001SessionTitle({
      title: "x".repeat(DSH_SESSION_MAX_TITLE_BYTES + 1),
      updatedAt: 1,
    })).toThrow("serialized byte limit");

    expect(() => validateDsh001SessionSnapshot(untrustedSessionSnapshot([
      sizedSessionEvent(DSH_SESSION_MAX_EVENT_SERIALIZED_BYTES),
    ]))).not.toThrow();
    expect(() => validateDsh001SessionSnapshot(untrustedSessionSnapshot([
      sizedSessionEvent(DSH_SESSION_MAX_EVENT_SERIALIZED_BYTES + 1),
    ]))).toThrow("per-event serialized byte limit");

    const aggregateEventBytes = Math.floor(DSH_SESSION_MAX_TOTAL_SERIALIZED_BYTES / 17) + 1;
    expect(aggregateEventBytes).toBeLessThan(DSH_SESSION_MAX_EVENT_SERIALIZED_BYTES);
    expect(() => validateDsh001SessionSnapshot(untrustedSessionSnapshot(
      Array.from({ length: 17 }, (_, seq) => sizedSessionEvent(aggregateEventBytes, seq)),
    ))).toThrow("total serialized byte limit");

    expect(() => validateDsh001SessionSnapshot(untrustedSessionSnapshot(
      Array.from({ length: DSH_SESSION_MAX_EVENTS + 1 }, (_, seq) => ({
        type: "fixture",
        seq,
        time: 1,
        data: {},
      })),
    ))).toThrow("event count limit");
  });

  it("bounds session-list records before sorting or hashing", () => {
    const maximumCount = Array.from({ length: DSH_SESSION_MAX_RECORDS }, (_, index) => ({
      header: { version: 0, id: `record-${String(index)}`, createdAt: index, cwd: fixture.root },
      live: false,
      persisted: true,
    }));
    expect(validateDsh001SessionRecords(maximumCount)).toHaveLength(DSH_SESSION_MAX_RECORDS);
    expect(() => validateDsh001SessionRecords([...maximumCount, maximumCount[0]]))
      .toThrow("record count limit");

    expect(() => validateDsh001SessionRecords([
      sizedSessionRecord(DSH_SESSION_MAX_RECORDS_SERIALIZED_BYTES),
    ])).not.toThrow();
    expect(() => validateDsh001SessionRecords([
      sizedSessionRecord(DSH_SESSION_MAX_RECORDS_SERIALIZED_BYTES + 1),
    ])).toThrow("serialized byte limit");
  });

  it("validates and maps ACP stdio and HTTP MCP servers onto scoped DSH tools", async () => {
    const stdioCommand = join(fixture.root, "bin/dsh");
    const configs = createDsh001McpConfigs([{
      name: "files (local)",
      transport: "stdio",
      command: stdioCommand,
      args: ["--safe"],
      env: { EXPLICIT_VALUE: "yes" },
    }, {
      name: "remote",
      transport: "http",
      url: "https://mcp.example.test/rpc",
      headers: { Authorization: "Bearer explicit" },
    }], fixture.root);

    expect(configs).toEqual([expect.objectContaining({
      transport: "stdio",
      serverName: expect.stringMatching(/^files__local__?[0-9a-f]*$/),
      command: stdioCommand,
      cwd: fixture.root,
    }), expect.objectContaining({
      transport: "streamable-http",
      serverName: "remote",
      url: "https://mcp.example.test/rpc",
    })]);

    const mcpServers = [{
      name: "local",
      transport: "stdio" as const,
      command: stdioCommand,
      args: [],
      env: {},
    }];
    const opened = await driver.newSession({
      cwd: fixture.root,
      additionalDirectories: [],
      mcpServers,
    }, new AbortController().signal);
    expect(host.createInputs.at(-1)?.mcpServers).toEqual(mcpServers);
    await opened.session.close();

    expect(() => createDsh001McpConfigs([{
      name: "bad",
      transport: "stdio",
      command: "relative-command",
      args: [],
    }], fixture.root)).toThrow("must be an absolute path");
  });

  it("loads with replay, resumes without replay, and applies MCP setup to both opens", async () => {
    const sessionId = "persisted-lifecycle";
    const persisted = storedSession(sessionId);
    host.seedSession({
      session: persisted.session,
      events: [
        ...persisted.events.slice(0, 2),
        {
          type: "steering/message",
          seq: 2,
          time: persisted.session.createdAt + 3,
          data: {
            turn: 1,
            message: {
              id: `steering-${sessionId}`,
              role: "user",
              source: { kind: "user" },
              content: [{ type: "text", text: `steering-${sessionId}` }],
            },
          },
        },
        ...persisted.events.slice(2).map((event, index) => ({ ...event, seq: index + 3 })),
      ],
    }, {
      title: "Persisted title",
      updatedAt: 1_700_000_000_100,
    });
    const mcpServers: readonly RuntimeMcpServer[] = [{
      name: "local",
      transport: "stdio",
      command: join(fixture.root, "bin/dsh"),
      args: ["mcp"],
    }];

    const loaded = await driver.loadSession(loadInput(sessionId, mcpServers), new AbortController().signal);
    expect(loaded.session.id).toBe(sessionId);
    if (loaded.replay === undefined) throw new Error("load did not return replay");
    const replay = await collectReplay(loaded.replay);
    expect(replay).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "user_message_chunk",
        content: { type: "text", text: `question-${sessionId}` },
      }),
      expect.objectContaining({
        type: "agent_message_chunk",
        content: { type: "text", text: `answer-${sessionId}` },
      }),
      expect.objectContaining({
        type: "user_message_chunk",
        content: { type: "text", text: `steering-${sessionId}` },
      }),
    ]));
    expect(host.resumeInputs.at(-1)?.mcpServers).toEqual(mcpServers);
    await loaded.session.close();

    const resumed = await driver.resumeSession(loadInput(sessionId, mcpServers), new AbortController().signal);
    expect(resumed.replay).toBeUndefined();
    expect(host.resumeInputs.at(-1)?.mcpServers).toEqual(mcpServers);
    await resumed.session.close();
  });

  it("rejects persisted danger-full-access and never facts before load or resume activates DSH", async () => {
    for (const operation of ["load", "resume"] as const) {
      const sessionId = `unsafe-${operation}`;
      host.seedSession(appendStoredEvents(storedSession(sessionId), [{
        type: "permission/preset",
        data: { preset: "danger-full-access" },
      }, {
        type: "sandbox/mode",
        data: { mode: "danger-full-access" },
      }, {
        type: "approval/policy",
        data: { policy: "never" },
      }]));

      const opening = operation === "load"
        ? driver.loadSession(loadInput(sessionId), new AbortController().signal)
        : driver.resumeSession(loadInput(sessionId), new AbortController().signal);
      await expect(opening).rejects.toMatchObject({ code: "DSH_SESSION_POLICY_UNSAFE" });
    }
    expect(host.resumeInputs).toHaveLength(0);
    expect(host.agents).toHaveLength(0);
  });

  it("accepts only the reviewed read-only or workspace-write plus ask policy facts", async () => {
    const sessionId = "safe-persisted-policy";
    host.seedSession(appendStoredEvents(storedSession(sessionId), [{
      type: "permission/preset",
      data: { preset: "read-only" },
    }, {
      type: "sandbox/mode",
      data: { mode: "workspace-write", source: "delegation" },
    }, {
      type: "approval/policy",
      data: { policy: "ask", source: "delegation" },
    }]));

    const loaded = await driver.loadSession(loadInput(sessionId), new AbortController().signal);
    expect(loaded.session.id).toBe(sessionId);
    await loaded.session.close();
  });

  it("accepts DSH pinning missing safe policy facts after the resume seed marker", async () => {
    const sessionId = "safe-resume-policy-pinning";
    host.seedSession(storedSession(sessionId));
    const originalResume = host.resumeAgent.bind(host);
    vi.spyOn(host, "resumeAgent").mockImplementationOnce(async (input) => {
      const opened = await originalResume(input);
      const events = opened.agent.session.events as DshHostEvent[];
      for (const event of [{
        type: "permission/preset",
        data: { preset: "workspace-write" },
      }, {
        type: "sandbox/mode",
        data: { mode: "workspace-write" },
      }, {
        type: "approval/policy",
        data: { policy: "ask" },
      }]) {
        events.push({
          ...event,
          seq: events.length,
          time: 1_700_000_000_100 + events.length,
        });
      }
      return opened;
    });

    const loaded = await driver.loadSession(loadInput(sessionId), new AbortController().signal);
    expect(loaded.session.id).toBe(sessionId);
    await loaded.session.close();
  });

  it("rejects unsafe or merge-extended fork seeds before creating a child", async () => {
    const unsafeId = "unsafe-fork-seed";
    host.seedSession(insertStoredEventsBeforeTurnEnd(storedSession(unsafeId), [{
      type: "permission/preset",
      data: { preset: "danger-full-access" },
    }, {
      type: "sandbox/mode",
      data: { mode: "danger-full-access" },
    }, {
      type: "approval/policy",
      data: { policy: "never" },
    }]));
    await expect(driver.forkSession(loadInput(unsafeId), new AbortController().signal))
      .rejects.toMatchObject({ code: "DSH_SESSION_POLICY_UNSAFE" });

    const extendedDataId = "extended-fork-data";
    host.seedSession(insertStoredEventsBeforeTurnEnd(storedSession(extendedDataId), [{
      type: "sandbox/mode",
      data: { mode: "workspace-write", mergedMode: "danger-full-access" },
    }]));
    await expect(driver.forkSession(loadInput(extendedDataId), new AbortController().signal))
      .rejects.toMatchObject({ code: "DSH_SESSION_POLICY_UNSAFE" });

    const extendedEnvelopeId = "extended-fork-envelope";
    host.seedSession(insertStoredEventsBeforeTurnEnd(storedSession(extendedEnvelopeId), [{
      type: "approval/policy",
      data: { policy: "ask" },
      surfaceOp: "append",
    }]));
    await expect(driver.forkSession(loadInput(extendedEnvelopeId), new AbortController().signal))
      .rejects.toMatchObject({ code: "DSH_SESSION_POLICY_UNSAFE" });
    expect(host.createInputs).toHaveLength(0);
  });

  it("rolls back a new session when the actual DSH handle contains an unknown policy value", async () => {
    const originalCreate = host.createAgent.bind(host);
    vi.spyOn(host, "createAgent").mockImplementationOnce(async (input) => {
      const opened = await originalCreate(input);
      const events = opened.agent.session.events as DshHostEvent[];
      events.push({
        type: "sandbox/mode",
        seq: events.length,
        time: 1_700_000_000_001,
        data: { mode: "future-unreviewed-mode" },
      });
      return opened;
    });

    await expect(driver.newSession({
      cwd: fixture.root,
      additionalDirectories: [],
      mcpServers: [],
    }, new AbortController().signal)).rejects.toMatchObject({ code: "DSH_SESSION_POLICY_UNSAFE" });
    expect(host.agents.at(-1)).toMatchObject({ disposed: true, cancelCalls: 1 });
  });

  it("rejects duplicate load and resume but forks an idle source owned by this driver", async () => {
    const sessionId = "active-session";
    host.seedSession(storedSession(sessionId));
    const active = await driver.loadSession(loadInput(sessionId), new AbortController().signal);

    await expect(driver.loadSession(loadInput(sessionId), new AbortController().signal))
      .rejects.toMatchObject({ code: "DSH_SESSION_ALREADY_ACTIVE" });
    await expect(driver.resumeSession(loadInput(sessionId), new AbortController().signal))
      .rejects.toMatchObject({ code: "DSH_SESSION_ALREADY_ACTIVE" });
    const forked = await driver.forkSession(loadInput(sessionId), new AbortController().signal);
    expect(forked.session.id).not.toBe(sessionId);
    expect(host.createInputs.at(-1)).toMatchObject({ parentSession: sessionId });
    expect(host.resumeInputs).toHaveLength(1);
    await forked.session.close();
    await active.session.close();
  });

  it("rejects a fork while the owned source has an active prompt", async () => {
    const sessionId = "busy-fork-source";
    host.seedSession(storedSession(sessionId));
    const active = await driver.loadSession(loadInput(sessionId), new AbortController().signal);
    const { context, abort } = promptContext();
    const pending = active.session
      .prompt({ content: [{ type: "text", text: "keep working" }] }, context)
      .next();
    await Promise.resolve();

    await expect(driver.forkSession(loadInput(sessionId), new AbortController().signal))
      .rejects.toMatchObject({ code: "DSH_SESSION_BUSY" });

    abort.abort();
    await expect(pending).resolves.toMatchObject({
      done: true,
      value: { stopReason: "cancelled" },
    });
    await active.session.close();
  });

  it("forks a complete-turn prefix under a new independent id with lineage and MCP", async () => {
    const sessionId = "fork-parent";
    const base = storedSession(sessionId);
    host.seedSession({
      session: base.session,
      events: [...base.events, {
        type: "session/title",
        seq: 6,
        time: base.session.createdAt + 7,
        data: { title: "between turns" },
      }, {
        type: "turn/start",
        seq: 7,
        time: base.session.createdAt + 8,
        data: { turn: 2, trigger: { kind: "message", source: { kind: "user" } } },
      }],
    });
    const mcpServers: readonly RuntimeMcpServer[] = [{
      name: "fork-tools",
      transport: "http",
      url: "https://mcp.example.test/fork",
    }];

    const forked = await driver.forkSession(loadInput(sessionId, mcpServers), new AbortController().signal);
    expect(forked.session.id).not.toBe(sessionId);
    expect(forked.replay).toBeUndefined();
    const creation = host.createInputs.at(-1);
    expect(creation).toMatchObject({ parentSession: sessionId, mcpServers });
    expect(creation?.seed?.map(event => event.type)).toEqual([
      "turn/start",
      "user/message",
      "step/start",
      "assistant/message",
      "step/end",
      "turn/end",
    ]);
    const child = await host.readSession(forked.session.id, new AbortController().signal);
    expect(child.session).toMatchObject({
      id: forked.session.id,
      parentSession: sessionId,
      seedLength: 6,
    });
    expect((await host.readSession(sessionId, new AbortController().signal)).events).toHaveLength(8);
    await forked.session.close();
  });

  it("rolls back a failed MCP-backed resume claim so the same session can retry", async () => {
    const sessionId = "resume-setup-failure";
    host.seedSession(storedSession(sessionId));
    const resume = vi.spyOn(host, "resumeAgent")
      .mockRejectedValueOnce(new Error("MCP setup failed before publication"));
    const input = loadInput(sessionId, [{
      name: "fails",
      transport: "http",
      url: "https://mcp.example.test/fail",
    }]);

    await expect(driver.resumeSession(input, new AbortController().signal))
      .rejects.toThrow("MCP setup failed before publication");
    expect(host.agents).toHaveLength(0);
    resume.mockRestore();
    const retry = await driver.resumeSession(input, new AbortController().signal);
    await retry.session.close();
  });

  it.each(["new", "load", "fork"] as const)(
    "retains a validation-rejected %s handle until driver cleanup can retry disposal",
    async (method) => {
      const sourceId = `orphan-${method}`;
      if (method !== "new") host.seedSession(storedSession(sourceId));
      host.disposeFailuresRemaining = 1;
      const corrupt = <T extends { agent: { session: { header: DshHostSessionSnapshot["session"] } } }>(
        handle: T,
      ): T => {
        (handle.agent.session.header as { cwd?: string }).cwd = join(fixture.root, "mismatched-cwd");
        return handle;
      };
      if (method === "load") {
        const resume = host.resumeAgent.bind(host);
        vi.spyOn(host, "resumeAgent").mockImplementationOnce(async input => corrupt(await resume(input)));
      } else {
        const create = host.createAgent.bind(host);
        vi.spyOn(host, "createAgent").mockImplementationOnce(async input => corrupt(await create(input)));
      }

      const operation = method === "new"
        ? driver.newSession({
            cwd: fixture.root,
            additionalDirectories: [],
            mcpServers: [],
          }, new AbortController().signal)
        : method === "load"
          ? driver.loadSession(loadInput(sourceId), new AbortController().signal)
          : driver.forkSession(loadInput(sourceId), new AbortController().signal);
      await expect(operation).rejects.toBeInstanceOf(AggregateError);
      const orphan = host.agents.at(-1);
      if (orphan === undefined) throw new Error("missing rejected handle");
      expect(orphan.disposed).toBe(false);

      await expect(driver.close()).resolves.toBeUndefined();
      expect(orphan.disposed).toBe(true);
      expect(host.closed).toBe(true);
    },
  );

  it("paginates before ACP cwd filtering with strict snapshot-bound cursors and durable activity time", async () => {
    const cwdA = fixture.root;
    const cwdB = join(fixture.root, "other-workspace");
    let newestAActivity = 0;
    for (let index = 0; index < 51; index += 1) {
      for (const [prefix, cwd] of [["a", cwdA], ["b", cwdB]] as const) {
        const row = storedSession(`${prefix}-${String(index).padStart(2, "0")}`, cwd, 10_000 + index);
        const titleTime = row.session.createdAt + 7;
        const withTitleAndMarker: DshHostSessionSnapshot = {
          session: row.session,
          events: [...row.events, {
            type: "session/title",
            seq: 6,
            time: titleTime,
            data: { title: `${prefix}-title-${String(index)}` },
          }, {
            type: "session/end-seed",
            seq: 7,
            time: row.session.createdAt + 50_000,
            data: {},
          }],
        };
        host.seedSession(withTitleAndMarker, {
          title: `${prefix}-title-${String(index)}`,
          updatedAt: titleTime,
        });
        if (prefix === "a" && index === 50) newestAActivity = titleTime;
      }
    }

    const signal = new AbortController().signal;
    const first = await driver.listSessions(cwdA, undefined, signal);
    const repeated = await driver.listSessions(cwdA, undefined, signal);
    expect(first.sessions).toHaveLength(50);
    expect(first.nextCursor).toBe(repeated.nextCursor);
    expect(first.sessions[0]).toMatchObject({
      id: "a-50",
      title: "a-title-50",
      updatedAt: new Date(newestAActivity).toISOString(),
    });
    expect(first.sessions.every(session => session.cwd === cwdA)).toBe(true);
    if (first.nextCursor === undefined) throw new Error("first page did not return a cursor");
    const second = await driver.listSessions(cwdA, first.nextCursor, signal);
    expect(second.sessions).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();

    const decoded = JSON.parse(Buffer.from(
      first.nextCursor.slice("dsh001.".length),
      "base64url",
    ).toString("utf8")) as Record<string, unknown>;
    await expect(driver.listSessions(cwdA, forgedCursor({ ...decoded, v: 2 }), signal))
      .rejects.toMatchObject({ code: "DSH_SESSION_CURSOR_INVALID" });
    await expect(driver.listSessions(cwdA, forgedCursor({ ...decoded, offset: -1 }), signal))
      .rejects.toMatchObject({ code: "DSH_SESSION_CURSOR_INVALID" });
    await expect(driver.listSessions(cwdB, first.nextCursor, signal))
      .resolves.toEqual({ sessions: [] });

    host.seedSession(storedSession("a-new", cwdA, 99_999));
    await expect(driver.listSessions(cwdA, first.nextCursor, signal))
      .rejects.toMatchObject({ code: "DSH_SESSION_CURSOR_STALE" });
  });

  it("fails closed when a client requests a cwd different from DSH's effective filesystem root", async () => {
    await expect(openSession(join(fixture.root, "different"))).rejects.toMatchObject({ code: "DSH_CWD_UNSUPPORTED" });
    expect(host.agents).toHaveLength(0);
  });

  it("maps committed text, tool lifecycle, usage, and one-shot permission", async () => {
    let permission: RuntimePermissionRequest | undefined;
    const permissionHandler = vi.fn((request: RuntimePermissionRequest) => {
      permission = request;
      return Promise.resolve({ outcome: "selected" as const, optionId: "allow-once" });
    });
    const { context } = promptContext(permissionHandler);
    const session = await openSession();
    const agent = host.agents[0];
    if (agent === undefined) throw new Error("missing fake agent");
    const collecting = collectTurn(session.prompt({ content: [{ type: "text", text: "work" }] }, context));
    await Promise.resolve();
    startTurn(agent);
    host.emitSession(agent, {
      type: "tool/call",
      seq: 2,
      data: { turn: 1, step: 1, callId: "call-1", name: "write", arguments: "{\"path\":\"a.txt\"}" },
    });

    const approval = await host.requestApproval({
      agent,
      toolName: "write",
      callId: "call-1",
      reason: "write the requested file",
    });
    expect(approval).toBe("allowed-once");
    expect(permission).toMatchObject({
      toolCallId: "call-1",
      title: "write",
      kind: "edit",
      rawInput: { path: "a.txt" },
      choices: [
        { id: "allow-once", kind: "allow_once" },
        { id: "reject-once", kind: "reject_once" },
      ],
    });

    host.emitSession(agent, {
      type: "assistant/message",
      data: {
        turn: 1,
        step: 1,
        message: { id: "message-1", content: [{ type: "text", text: "done" }] },
        usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 3 },
      },
    });
    host.emitSession(agent, {
      type: "tool/result",
      data: {
        turn: 1,
        step: 1,
        message: {
          source: { kind: "tool", callId: "call-1" },
          content: [{
            type: "tool-result",
            toolCallId: "call-1",
            content: [{ type: "text", text: "wrote a.txt" }],
          }],
        },
      },
    });
    host.emitSession(agent, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });

    const turn = await collecting;
    expect(turn.result).toEqual({ stopReason: "end_turn" });
    expect(turn.events.map(event => event.type)).toEqual([
      "tool_call",
      "agent_message_chunk",
      "usage_update",
      "tool_call_update",
    ]);
    expect(turn.events[0]).toMatchObject({ kind: "edit", status: "in_progress" });
    expect(turn.events[3]).toMatchObject({ status: "completed" });
  });

  it("redacts and bounds the DSH approval reason before exposing ACP metadata", async () => {
    let permission: RuntimePermissionRequest | undefined;
    const { context } = promptContext((request) => {
      permission = request;
      return Promise.resolve({ outcome: "selected", optionId: "reject-once" });
    });
    const session = await openSession();
    const agent = host.agents[0];
    if (agent === undefined) throw new Error("missing fake agent");
    const collecting = collectTurn(session.prompt({ content: [{ type: "text", text: "permission" }] }, context));
    await Promise.resolve();
    startTurn(agent);

    await host.requestApproval({
      agent,
      toolName: "bash",
      callId: "approval-safe",
      reason: `Authorization: Bearer approval-secret\n${"x".repeat(DSH_APPROVAL_REASON_MAX_BYTES * 4)}`,
    });
    const projected = permission?._meta?.["reason"];
    expect(typeof projected).toBe("string");
    expect(String(projected)).not.toContain("approval-secret");
    expect(String(projected)).toContain("[REDACTED]");
    expect(Buffer.byteLength(String(projected), "utf8")).toBeLessThanOrEqual(DSH_APPROVAL_REASON_MAX_BYTES);

    host.emitSession(agent, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
    await collecting;
  });

  it("redacts secrets and bounds every raw tool projection and result block", async () => {
    const { context } = promptContext();
    const session = await openSession();
    const agent = host.agents[0];
    if (agent === undefined) throw new Error("missing fake agent");
    const collecting = collectTurn(session.prompt({ content: [{ type: "text", text: "safe projection" }] }, context));
    await Promise.resolve();
    startTurn(agent);

    const longValue = "x".repeat(DSH_EVENT_MAX_STRING_BYTES * 4);
    host.emitSession(agent, {
      type: "tool/call",
      data: {
        turn: 1,
        step: 1,
        callId: "safe-1",
        name: "write",
        arguments: JSON.stringify({
          path: "safe.txt",
          apiKey: "input-secret",
          quotedJson: JSON.stringify({ authorization: "Bearer nested-secret", safe: true }),
          longValue,
        }),
      },
    });
    const resultMessage = {
      source: { kind: "tool", callId: "safe-1" },
      content: [{
        type: "tool-result",
        toolCallId: "safe-1",
        content: [{
          type: "text",
          text: JSON.stringify({ password: "result-secret", output: longValue }),
        }],
      }],
    };
    host.emitSession(agent, {
      type: "tool/result",
      data: {
        turn: 1,
        step: 1,
        message: resultMessage,
        error: { message: JSON.stringify({ token: "error-secret" }) },
        meta: { headers: { cookie: "meta-secret" }, safe: "kept" },
      },
    });
    host.emitSession(agent, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });

    const turn = await collecting;
    const call = turn.events.find((event): event is Extract<RuntimeEvent, { type: "tool_call" }> => event.type === "tool_call");
    const update = turn.events.find((event): event is Extract<RuntimeEvent, { type: "tool_call_update" }> => event.type === "tool_call_update");
    if (call === undefined || update === undefined) throw new Error("missing mapped tool lifecycle");

    const serialized = JSON.stringify(turn.events);
    for (const secret of ["input-secret", "nested-secret", "result-secret", "error-secret", "meta-secret"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain("[REDACTED]");
    expect(Buffer.byteLength(JSON.stringify(call.rawInput), "utf8")).toBeLessThanOrEqual(DSH_EVENT_MAX_SERIALIZED_BYTES);
    expect(call.rawInput).toMatchObject({
      apiKey: "[REDACTED]",
      quotedJson: expect.stringContaining("[REDACTED]"),
      longValue: expect.stringContaining("[TRUNCATED]"),
    });
    expect(Buffer.byteLength((call.rawInput as { longValue: string }).longValue, "utf8"))
      .toBeLessThanOrEqual(DSH_EVENT_MAX_STRING_BYTES);
    expect(update.rawOutput).not.toBe(resultMessage);
    expect(update._meta).toMatchObject({
      error: { message: expect.stringContaining("[REDACTED]") },
      toolMeta: { headers: "[REDACTED]", safe: "kept" },
    });
    const resultText = update.content?.[0]?.content?.type === "text"
      ? update.content[0].content.text
      : undefined;
    expect(resultText).toContain("[REDACTED]");
    expect(Buffer.byteLength(resultText ?? "", "utf8")).toBeLessThanOrEqual(DSH_TOOL_RESULT_MAX_BLOCK_BYTES);
  });

  it("does not expose failed-attempt raw chunks when DSH retries", async () => {
    const { context } = promptContext();
    const session = await openSession();
    const agent = host.agents[0];
    if (agent === undefined) throw new Error("missing fake agent");
    const collecting = collectTurn(session.prompt({ content: [{ type: "text", text: "retry" }] }, context));
    await Promise.resolve();
    startTurn(agent, 1);
    host.emitSession(agent, {
      type: "assistant/chunk",
      data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "failed partial" } },
    });
    host.emitSession(agent, {
      type: "turn/end",
      data: { turn: 1, reason: { kind: "error", step: 1, message: "temporary" } },
    });
    host.emitSession(agent, { type: "turn/start", data: { turn: 2, trigger: { kind: "retry" } } });
    host.emitSession(agent, {
      type: "assistant/message",
      data: { turn: 2, step: 2, message: { content: [{ type: "text", text: "committed" }] } },
    });
    host.emitSession(agent, { type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } });

    const turn = await collecting;
    expect(turn.events).toEqual([{ type: "agent_message_chunk", content: { type: "text", text: "committed" } }]);
  });

  it("cooperatively cancels the exact turn and fences late events", async () => {
    const { context } = promptContext();
    const session = await openSession();
    const agent = host.agents[0];
    if (agent === undefined) throw new Error("missing fake agent");
    const collecting = collectTurn(session.prompt({ content: [{ type: "text", text: "long task" }] }, context));
    await Promise.resolve();
    startTurn(agent);
    await session.cancel(context.turnId);
    host.emitSession(agent, {
      type: "assistant/message",
      data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "too late" }] } },
    });

    await expect(collecting).resolves.toEqual({ events: [], result: { stopReason: "cancelled" } });
    expect(agent.cancelCalls).toBe(1);
  });

  it("binds ACP cancellation settlement to the exact real-driver cleanup promise", async () => {
    const client = new FakeAcpClient();
    const core = new DshAcpAgent({ driver, version: "test", cancelDrainTimeoutMs: 1_000 });
    await core.initialize(
      { protocolVersion: 1, clientCapabilities: TEST_CLIENT_CAPABILITIES },
      client,
      new AbortController().signal,
    );
    const opened = await core.newSession(
      { cwd: fixture.root, mcpServers: [] },
      client,
      new AbortController().signal,
    );
    const agent = host.agents[0];
    if (agent === undefined) throw new Error("missing fake agent");
    let releaseIdle!: () => void;
    vi.spyOn(agent, "whenIdle").mockImplementationOnce(() =>
      new Promise<void>((resolveIdle) => { releaseIdle = resolveIdle; }));
    const requestAbort = new AbortController();
    let promptSettled = false;
    const first = core.prompt(
      { sessionId: opened.sessionId, prompt: [{ type: "text", text: "cancel and drain" }] },
      client,
      requestAbort.signal,
    ).then((result) => {
      promptSettled = true;
      return result;
    });
    await vi.waitFor(() => expect(agent.followups).toHaveLength(1));
    startTurn(agent, 1);
    requestAbort.abort();
    await Promise.resolve();
    expect(promptSettled).toBe(false);
    expect(agent.cancelCalls).toBe(1);

    releaseIdle();
    await expect(first).resolves.toEqual({ stopReason: "cancelled" });
    const second = core.prompt(
      { sessionId: opened.sessionId, prompt: [{ type: "text", text: "usable after drain" }] },
      client,
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(agent.followups).toHaveLength(2));
    startTurn(agent, 2);
    host.emitSession(agent, { type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } });
    await expect(second).resolves.toEqual({ stopReason: "end_turn" });
    expect(agent.cancelCalls).toBe(1);
    await core.close();
  });

  it("settles a cancelled prompt once and retires the session when host cancel throws", async () => {
    const { context } = promptContext();
    const session = await openSession();
    const agent = host.agents[0];
    if (agent === undefined) throw new Error("missing fake agent");
    const collecting = collectTurn(session.prompt({ content: [{ type: "text", text: "fragile cancel" }] }, context));
    await Promise.resolve();
    startTurn(agent);
    agent.cancelFailuresRemaining = 1;

    const cancellation = session.cancel(context.turnId);
    await expect(session.prompt({
      content: [{ type: "text", text: "must not overlap" }],
    }, promptContext().context).next()).rejects.toMatchObject({ code: "DSH_SESSION_CLOSED" });
    await expect(cancellation).rejects.toThrow("transient agent cancel failure");

    host.emitSession(agent, {
      type: "assistant/message",
      data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "too late" }] } },
    });
    host.emitSession(agent, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
    await expect(collecting).resolves.toEqual({ events: [], result: { stopReason: "cancelled" } });
    expect(agent.followups).toHaveLength(1);
    expect(agent.cancelCalls).toBe(1);

    await expect(session.close()).resolves.toBeUndefined();
    expect(agent.disposed).toBe(true);
    expect(agent.cancelCalls).toBe(2);
  });

  it("preserves a mapping failure when its defensive host cancel also throws", async () => {
    const { context } = promptContext();
    const session = await openSession();
    const agent = host.agents[0];
    if (agent === undefined) throw new Error("missing fake agent");
    const generator = session.prompt({ content: [{ type: "text", text: "invalid event" }] }, context);
    const waiting = generator.next();
    await vi.waitFor(() => expect(agent.followups).toHaveLength(1));
    startTurn(agent);
    agent.cancelFailuresRemaining = 1;
    host.emitSession(agent, {
      type: "session/title",
      data: { title: "x".repeat(DSH_PROMPT_MAX_EVENT_BYTES + 1) },
    });

    await expect(waiting).rejects.toMatchObject({ code: "DSH_EVENT_TOO_LARGE" });
    await expect(generator.next()).resolves.toMatchObject({ done: true });
    await expect(session.prompt({
      content: [{ type: "text", text: "must remain retired" }],
    }, promptContext().context).next()).rejects.toMatchObject({ code: "DSH_SESSION_CLOSED" });
    await expect(session.close()).resolves.toBeUndefined();
  });

  it("does not let a prompt-finally cancel failure overwrite generator return", async () => {
    const { context } = promptContext();
    const session = await openSession();
    const agent = host.agents[0];
    if (agent === undefined) throw new Error("missing fake agent");
    const generator = session.prompt({ content: [{ type: "text", text: "stop consuming" }] }, context);
    const first = generator.next();
    await vi.waitFor(() => expect(agent.followups).toHaveLength(1));
    startTurn(agent);
    host.emitSession(agent, { type: "session/title", data: { title: "first" } });
    await expect(first).resolves.toMatchObject({ done: false });
    agent.cancelFailuresRemaining = 1;

    await expect(generator.return({ stopReason: "cancelled" })).resolves.toEqual({
      done: true,
      value: { stopReason: "cancelled" },
    });
    await expect(generator.next()).resolves.toMatchObject({ done: true });
    await expect(session.prompt({
      content: [{ type: "text", text: "must remain retired" }],
    }, promptContext().context).next()).rejects.toMatchObject({ code: "DSH_SESSION_CLOSED" });
    await expect(session.close()).resolves.toBeUndefined();
  });

  it("fences a replacement prompt until abandoned-generator cleanup is idle", async () => {
    const { context } = promptContext();
    const session = await openSession();
    const agent = host.agents[0];
    if (agent === undefined) throw new Error("missing fake agent");
    let releaseIdle!: () => void;
    vi.spyOn(agent, "whenIdle").mockImplementationOnce(() =>
      new Promise<void>((resolveIdle) => { releaseIdle = resolveIdle; }));
    const generator = session.prompt({ content: [{ type: "text", text: "stop consuming" }] }, context);
    const first = generator.next();
    await vi.waitFor(() => expect(agent.followups).toHaveLength(1));
    startTurn(agent);
    host.emitSession(agent, { type: "session/title", data: { title: "first" } });
    await expect(first).resolves.toMatchObject({ done: false });

    const returning = generator.return({ stopReason: "cancelled" });
    await Promise.resolve();
    await expect(session.prompt({
      content: [{ type: "text", text: "must wait" }],
    }, promptContext().context).next()).rejects.toMatchObject({ code: "DSH_PROMPT_INFLIGHT" });

    releaseIdle();
    await expect(returning).resolves.toEqual({
      done: true,
      value: { stopReason: "cancelled" },
    });
    const replacementContext = promptContext();
    const replacement = session.prompt({
      content: [{ type: "text", text: "after drain" }],
    }, replacementContext.context);
    const pending = replacement.next();
    await vi.waitFor(() => expect(agent.followups).toHaveLength(2));
    replacementContext.abort.abort();
    await expect(pending).resolves.toMatchObject({
      done: true,
      value: { stopReason: "cancelled" },
    });
  });

  it("observes an abort triggered synchronously inside steer before a receipt settles", async () => {
    const session = await openSession();
    const agent = host.agents[0];
    if (agent === undefined) throw new Error("missing fake agent");
    const abort = new AbortController();
    vi.spyOn(agent, "steer").mockImplementationOnce(() => {
      abort.abort();
      return { outcome: new Promise<never>(() => undefined) };
    });
    if (session.steer === undefined) throw new Error("runtime session has no steer seam");

    await expect(session.steer(
      { content: [{ type: "text", text: "race" }] },
      abort.signal,
    )).rejects.toMatchObject({ code: "DSH_STEER_REJECTED" });
  });

  it("cancels and fails a slow consumer when the bounded event queue overflows", async () => {
    const { context } = promptContext();
    const session = await openSession();
    const agent = host.agents[0];
    if (agent === undefined) throw new Error("missing fake agent");
    const generator = session.prompt({ content: [{ type: "text", text: "many events" }] }, context);
    const firstItem = generator.next();
    await Promise.resolve();
    startTurn(agent);
    host.emitSession(agent, { type: "session/title", data: { title: "first" } });
    await expect(firstItem).resolves.toMatchObject({ done: false });
    for (let index = 0; index <= DSH_PROMPT_MAX_QUEUED_EVENTS; index += 1) {
      host.emitSession(agent, { type: "session/title", data: { title: `queued-${String(index)}` } });
    }

    await expect(generator.next()).rejects.toMatchObject({ code: "DSH_EVENT_BACKPRESSURE" });
    expect(agent.cancelCalls).toBe(1);
  });

  it("rejects an oversized live event on the direct-waiter path", async () => {
    const { context } = promptContext();
    const session = await openSession();
    const agent = host.agents[0];
    if (agent === undefined) throw new Error("missing fake agent");
    const generator = session.prompt({ content: [{ type: "text", text: "direct event" }] }, context);
    const waiting = generator.next();
    await vi.waitFor(() => expect(agent.followups).toHaveLength(1));
    startTurn(agent);
    host.emitSession(agent, {
      type: "session/title",
      data: { title: "x".repeat(DSH_PROMPT_MAX_EVENT_BYTES + 1) },
    });

    await expect(waiting).rejects.toMatchObject({ code: "DSH_EVENT_TOO_LARGE" });
    expect(agent.cancelCalls).toBe(1);
    await expect(session.prompt({
      content: [{ type: "text", text: "retired after mapping failure" }],
    }, promptContext().context).next()).rejects.toMatchObject({ code: "DSH_SESSION_CLOSED" });
  });

  it("rejects an oversized live event on the queued path", async () => {
    const { context } = promptContext();
    const session = await openSession();
    const agent = host.agents[0];
    if (agent === undefined) throw new Error("missing fake agent");
    const generator = session.prompt({ content: [{ type: "text", text: "queued event" }] }, context);
    const first = generator.next();
    await vi.waitFor(() => expect(agent.followups).toHaveLength(1));
    startTurn(agent);
    host.emitSession(agent, { type: "session/title", data: { title: "first" } });
    await expect(first).resolves.toMatchObject({ done: false });
    host.emitSession(agent, {
      type: "session/title",
      data: { title: "x".repeat(DSH_PROMPT_MAX_EVENT_BYTES + 1) },
    });

    await expect(generator.next()).rejects.toMatchObject({ code: "DSH_EVENT_TOO_LARGE" });
    expect(agent.cancelCalls).toBe(1);
  });

  it("fails instead of reporting success for a merge-extended unknown turn reason", async () => {
    const { context } = promptContext();
    const session = await openSession();
    const agent = host.agents[0];
    if (agent === undefined) throw new Error("missing fake agent");
    const collecting = collectTurn(session.prompt({ content: [{ type: "text", text: "future" }] }, context));
    await Promise.resolve();
    startTurn(agent);
    host.emitSession(agent, { type: "turn/end", data: { turn: 1, reason: { kind: "future-reason" } } });

    await expect(collecting).rejects.toMatchObject({ code: "DSH_TURN_REASON_UNSUPPORTED" });
  });

  it("drains descendants before disposing every owned handle", async () => {
    await openSession();
    await openSession();
    const ids = host.agents.map(agent => agent.id);
    await driver.close();

    for (const id of ids) {
      expect(host.lifecycle.indexOf(`drain:${id}`)).toBeGreaterThan(-1);
      expect(host.lifecycle.indexOf(`dispose:${id}`)).toBeGreaterThan(host.lifecycle.indexOf(`drain:${id}`));
    }
    expect(host.lifecycle.at(-1)).toBe("host-close");
    expect(host.agents.every(agent => agent.disposed)).toBe(true);
  });

  it("retains ownership and retries after a transient handle-disposal failure", async () => {
    const session = await openSession();
    const agent = host.agents[0];
    if (agent === undefined) throw new Error("missing fake agent");
    host.disposeFailuresRemaining = 1;

    await expect(session.close()).rejects.toThrow("failed to close DSH session");
    expect(agent.disposed).toBe(false);
    expect(host.lifecycle).toContain(`dispose-failed:${session.id}`);

    await expect(session.close()).resolves.toBeUndefined();
    expect(agent.disposed).toBe(true);
    expect(host.lifecycle.filter(item => item === `dispose:${session.id}`)).toHaveLength(1);
  });

  it("keeps the exact live root registered until a failed descendant drain retries", async () => {
    const session = await openSession();
    const agent = host.agents[0];
    if (agent === undefined) throw new Error("missing fake agent");
    host.descendantDrainFailuresRemaining = 1;

    await expect(session.close()).rejects.toThrow("failed to close DSH session");
    expect(agent.disposed).toBe(false);
    expect(host.isAgentLive(agent)).toBe(true);
    expect(host.lifecycle).not.toContain(`dispose:${session.id}`);

    await expect(session.close()).resolves.toBeUndefined();
    expect(agent.disposed).toBe(true);
    expect(host.lifecycle.filter(item => item === `drain:${session.id}`)).toHaveLength(2);
    expect(host.lifecycle.filter(item => item === `dispose:${session.id}`)).toHaveLength(1);
  });

  it("reuses the exact pending descendant drain after a teardown timeout", async () => {
    vi.useFakeTimers();
    try {
      const session = await openSession();
      const agent = host.agents[0];
      if (agent === undefined) throw new Error("missing fake agent");
      let releaseDrain!: () => void;
      const drain = vi.spyOn(host, "drainContinuableDescendants").mockImplementation(() =>
        new Promise<void>((resolveDrain) => { releaseDrain = resolveDrain; }));

      const firstClose = session.close();
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(DSH_TEARDOWN_TIMEOUT_MS);
      await expect(firstClose).rejects.toThrow("failed to close DSH session");
      expect(agent.disposed).toBe(false);
      expect(host.isAgentLive(agent)).toBe(true);
      expect(drain).toHaveBeenCalledTimes(1);

      const retry = session.close();
      await Promise.resolve();
      await Promise.resolve();
      expect(drain).toHaveBeenCalledTimes(1);
      releaseDrain();
      await expect(retry).resolves.toBeUndefined();
      expect(agent.disposed).toBe(true);
      expect(drain).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a validation-rejected handle live until descendant rollback succeeds", async () => {
    host.descendantDrainFailuresRemaining = 1;
    const create = host.createAgent.bind(host);
    vi.spyOn(host, "createAgent").mockImplementationOnce(async input => {
      const handle = await create(input);
      (handle.agent.session.header as { cwd?: string }).cwd = join(fixture.root, "mismatched-cwd");
      return handle;
    });

    await expect(driver.newSession({
      cwd: fixture.root,
      additionalDirectories: [],
      mcpServers: [],
    }, new AbortController().signal)).rejects.toBeInstanceOf(AggregateError);
    const orphan = host.agents.at(-1);
    if (orphan === undefined) throw new Error("missing rejected handle");
    expect(orphan.disposed).toBe(false);
    expect(host.isAgentLive(orphan)).toBe(true);

    await expect(driver.close()).resolves.toBeUndefined();
    expect(orphan.disposed).toBe(true);
    expect(host.closed).toBe(true);
  });

  it("keeps the driver host open until a failed session close is retried", async () => {
    await openSession();
    const agent = host.agents[0];
    if (agent === undefined) throw new Error("missing fake agent");
    host.disposeFailuresRemaining = 1;

    await expect(driver.close()).rejects.toThrow("failed to close one or more owned DSH handles");
    expect(agent.disposed).toBe(false);
    expect(host.closed).toBe(false);

    await expect(driver.close()).resolves.toBeUndefined();
    expect(agent.disposed).toBe(true);
    expect(host.closed).toBe(true);
    expect(host.lifecycle.at(-1)).toBe("host-close");
  });

  it("retries staged host close without removing boot state before fiber disposal", async () => {
    let fiberAttempts = 0;
    let cleanupAttempts = 0;
    const closeAfterFiberFailure = createDsh001HostCloser(
      async () => {
        fiberAttempts += 1;
        if (fiberAttempts === 1) throw new Error("fiber busy");
      },
      async () => { cleanupAttempts += 1; },
    );
    await expect(closeAfterFiberFailure()).rejects.toThrow("fiber busy");
    expect(cleanupAttempts).toBe(0);
    await expect(closeAfterFiberFailure()).resolves.toBeUndefined();
    expect(fiberAttempts).toBe(2);
    expect(cleanupAttempts).toBe(1);

    fiberAttempts = 0;
    cleanupAttempts = 0;
    const closeAfterCleanupFailure = createDsh001HostCloser(
      async () => { fiberAttempts += 1; },
      async () => {
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) throw new Error("workspace busy");
      },
    );
    await expect(closeAfterCleanupFailure()).rejects.toThrow("workspace busy");
    await expect(closeAfterCleanupFailure()).resolves.toBeUndefined();
    expect(fiberAttempts).toBe(1);
    expect(cleanupAttempts).toBe(2);
  });

  it("keeps unknown tools fail-closed in permission mapping", async () => {
    let captured: RuntimePermissionRequest | undefined;
    const { context } = promptContext((request) => {
      captured = request;
      return Promise.resolve({ outcome: "selected", optionId: "reject-once" });
    });
    const session = await openSession();
    const agent = host.agents[0];
    if (agent === undefined) throw new Error("missing fake agent");
    const collecting = collectTurn(session.prompt({ content: [{ type: "text", text: "custom" }] }, context));
    await Promise.resolve();
    startTurn(agent);
    host.emitSession(agent, {
      type: "tool/call",
      data: { turn: 1, step: 1, callId: "custom-1", name: "custom_plugin_tool", arguments: "{}" },
    });
    await expect(host.requestApproval({ agent, toolName: "custom_plugin_tool", callId: "custom-1" })).resolves.toBe("rejected");
    expect(captured?.kind).toBe("other");
    host.emitSession(agent, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
    await collecting;
  });

  it("rechecks the fingerprint in the factory and at initialize", async () => {
    const inspected = await inspectDsh({ dshPath: fixture.root, homeDir: fixture.home });
    if (!inspected.ok) throw new Error(inspected.error.message);
    await writeFile(join(fixture.root, "packages/core/session/src/types.ts"), "export const drift = true\n", "utf8");

    await expect(createRuntimeDriver(inspected)).rejects.toMatchObject({ code: "DSH_INSTALLATION_CHANGED" });
    const stale = new Dsh001RuntimeDriver(inspected.installation, { hostLoader: () => Promise.resolve(new FakeDshHost(fixture.root)) });
    await expect(stale.initialize(new AbortController().signal)).rejects.toMatchObject({ code: "DSH_INSTALLATION_CHANGED" });
    await stale.close();
  });

  it("rolls back an earlier listener and closes the host when initialization is only partially registered", async () => {
    const failingHost = new FakeDshHost(fixture.root, "status");
    const candidate = new Dsh001RuntimeDriver(installation, { hostLoader: () => Promise.resolve(failingHost) });
    await expect(candidate.initialize(new AbortController().signal)).rejects.toThrow("status listener failed");
    expect(failingHost.lifecycle).toContain("listener-dispose:session");
    expect(failingHost.lifecycle.at(-1)).toBe("host-close");
    await candidate.close();
  });

  it("retains a host whose initialization rollback close fails and retries it", async () => {
    const failingHost = new FakeDshHost(fixture.root, "status");
    failingHost.closeFailuresRemaining = 1;
    const candidate = new Dsh001RuntimeDriver(installation, {
      hostLoader: () => Promise.resolve(failingHost),
    });

    const initializationError = await candidate.initialize(new AbortController().signal).catch(error => error as unknown);
    expect(initializationError).toBeInstanceOf(AggregateError);
    expect((initializationError as AggregateError).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "status listener failed" }),
    ]));
    expect(failingHost.closed).toBe(false);
    await expect(candidate.close()).resolves.toBeUndefined();
    expect(failingHost.closed).toBe(true);
    expect(failingHost.lifecycle).toContain("host-close-failed");
  });

  it("keeps close pending across a late host publication and transient rollback failure", async () => {
    const lateHost = new FakeDshHost(fixture.root);
    lateHost.closeFailuresRemaining = 1;
    let publishHost!: (value: FakeDshHost) => void;
    const hostPromise = new Promise<FakeDshHost>((resolveHost) => { publishHost = resolveHost; });
    const candidate = new Dsh001RuntimeDriver(installation, { hostLoader: () => hostPromise });
    const initializing = candidate.initialize(new AbortController().signal);
    await Promise.resolve();
    const closing = candidate.close();
    publishHost(lateHost);

    await expect(initializing).rejects.toThrow("failed to roll back cancelled DSH initialization");
    await expect(closing).resolves.toBeUndefined();
    expect(lateHost.closed).toBe(true);
    expect(lateHost.lifecycle).toEqual(expect.arrayContaining(["host-close-failed", "host-close"]));
  });

  it("retains staged cleanup ownership from a host-loader rejection", async () => {
    let cleanupAttempts = 0;
    const cleanup = async (): Promise<void> => {
      cleanupAttempts += 1;
      if (cleanupAttempts === 1) throw new Error("cleanup busy");
    };
    const candidate = new Dsh001RuntimeDriver(installation, {
      hostLoader: () => Promise.reject(new Dsh001HostInitializationError(
        new RuntimeCompatibilityError("DSH_BOOT_FAILED", "boot validation failed"),
        cleanup,
      )),
    });

    await expect(candidate.initialize(new AbortController().signal)).rejects.toMatchObject({
      code: "DSH_BOOT_FAILED",
    });
    await expect(candidate.close()).rejects.toThrow("failed to finish DSH initialization cleanup");
    await expect(candidate.close()).resolves.toBeUndefined();
    expect(cleanupAttempts).toBe(2);
  });
});
