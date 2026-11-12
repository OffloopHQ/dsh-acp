import { describe, expect, it } from "vitest";
import { DshAcpAgent } from "../../src/acp/agent.js";
import { mapAuthMethods } from "../../src/acp/mapping.js";
import {
  RuntimeCompatibilityError,
  type RuntimeSessionOpenResult,
} from "../../src/runtime/types.js";
import { FakeAcpClient } from "../../src/testing/fake-client.js";
import {
  FakeDshRuntimeDriver,
  FakeRuntimeSession,
  minimalRuntimeCapabilities,
  openResult,
  runtimeEvents,
  deferred,
} from "../../src/testing/fake-runtime.js";
import {
  activeSession,
  initializedAgent,
  TEST_CLIENT_CAPABILITIES,
  waitUntil,
} from "./helpers.js";

describe("ACP lifecycle coverage", () => {
  it("advertises only driver-backed capabilities", async () => {
    const driver = new FakeDshRuntimeDriver({ capabilities: minimalRuntimeCapabilities() });
    const runtimeFingerprint = `sha256:${"a".repeat(64)}`;
    Object.assign(driver, { runtimeFingerprint });
    const agent = new DshAcpAgent({ driver });
    const client = new FakeAcpClient();
    const response = await agent.initialize(
      { protocolVersion: 999, clientCapabilities: TEST_CLIENT_CAPABILITIES },
      client,
      new AbortController().signal,
    );

    expect(response.protocolVersion).toBe(1);
    expect(response.agentCapabilities).toMatchObject({
      loadSession: false,
      promptCapabilities: { image: false, embeddedContext: false },
      mcpCapabilities: { http: false, sse: false },
      sessionCapabilities: {},
    });
    expect(response.agentCapabilities?.providers).toBeUndefined();
    expect(response.authMethods).toEqual([]);
    expect(response._meta).toMatchObject({
      runtimeDriverId: "fake-dsh",
      runtimeFingerprint,
    });
    expect(response.agentCapabilities?._meta?.["offloop.dsh-acp"]).toMatchObject({
      steering: false,
      elicitationCompletion: false,
      security: {
        builtInNetworkTools: false,
        processNetworkIsolation: false,
        permissionGate: "dsh-emitted-only",
        protectedAdmissionFromInitialize: false,
      },
    });
    expect(response.agentCapabilities?._meta?.["steering"]).toEqual({
      supported: false,
    });
  });

  it("rejects protocol versions below v1", async () => {
    const driver = new FakeDshRuntimeDriver();
    const agent = new DshAcpAgent({ driver });
    await expect(
      agent.initialize(
        { protocolVersion: 0 },
        new FakeAcpClient(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("allows exactly one initialize request, including while initialization is pending", async () => {
    const gate = deferred<void>();
    const driver = new FakeDshRuntimeDriver();
    driver.initializeHandler = async () => gate.promise;
    const agent = new DshAcpAgent({ driver });
    const client = new FakeAcpClient();
    const first = agent.initialize(
      { protocolVersion: 1 },
      client,
      new AbortController().signal,
    );
    await Promise.resolve();
    await expect(
      agent.initialize(
        { protocolVersion: 1 },
        client,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: -32600 });
    gate.resolve();
    await expect(first).resolves.toMatchObject({ protocolVersion: 1 });
    await expect(
      agent.initialize(
        { protocolVersion: 1 },
        client,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: -32600 });
  });

  it("fences initialize against connection close", async () => {
    const gate = deferred<void>();
    const driver = new FakeDshRuntimeDriver();
    driver.initializeHandler = async () => gate.promise;
    const agent = new DshAcpAgent({ driver });
    const initializing = agent.initialize(
      { protocolVersion: 1 },
      new FakeAcpClient(),
      new AbortController().signal,
    );
    await Promise.resolve();
    await agent.close();
    await expect(initializing).rejects.toMatchObject({ code: -32800 });
    expect(driver.closeCalls).toBe(1);
    gate.resolve();
  });

  it("advertises terminal auth only for an explicitly supported self command", () => {
    const methods = [
      {
        id: "terminal",
        name: "Terminal login",
        terminal: {
          command: "dsh-acp",
          args: ["auth", "login"],
          label: "Open login",
        },
      },
    ];
    expect(
      mapAuthMethods(methods, {
        clientSupportsTerminal: true,
        terminalAuthCommand: "dsh-acp",
      }),
    ).toEqual([
      expect.objectContaining({
        id: "terminal",
        type: "terminal",
        args: ["auth", "login"],
        _meta: { label: "Open login" },
      }),
    ]);
    expect(
      mapAuthMethods(methods, {
        clientSupportsTerminal: true,
        terminalAuthCommand: "different-binary",
      }),
    ).toEqual([
      expect.objectContaining({
        id: "terminal",
        _meta: { terminalAuthHandledByAgent: true },
      }),
    ]);
  });

  it("supports load replay, resume, fork, list, mode, config, close, and delete", async () => {
    const driver = new FakeDshRuntimeDriver();
    const loadSession = new FakeRuntimeSession("persisted", "/workspace");
    driver.loadResults.push(
      openResult(loadSession, {
        replay: runtimeEvents([
          {
            type: "user_message_chunk",
            content: { type: "text", text: "history" },
          },
        ]),
        descriptor: {
          id: "persisted",
          cwd: "/workspace",
          modeId: "code",
        },
        modes: [
          { id: "code", name: "Code" },
          { id: "plan", name: "Plan" },
        ],
        configOptions: [
          {
            id: "thinking",
            name: "Thinking",
            kind: "boolean",
            currentValue: false,
          },
          {
            id: "model",
            name: "Model",
            kind: "select",
            currentValue: "chat",
            options: [
              { value: "chat", name: "Chat" },
              { value: "reasoner", name: "Reasoner" },
            ],
          },
        ],
        commands: [{ name: "review", description: "Review code", inputHint: "path" }],
      }),
    );
    const resumed = new FakeRuntimeSession("resume-me", "/workspace");
    driver.resumeResults.push(openResult(resumed));
    const forked = new FakeRuntimeSession("forked", "/workspace");
    driver.forkResults.push(openResult(forked));
    driver.sessionPage = {
      sessions: [
        { id: "persisted", cwd: "/workspace", title: "One" },
        { id: "elsewhere", cwd: "/other", title: "Two" },
      ],
      nextCursor: "next",
    };
    const { agent, client } = await initializedAgent(driver);

    const loaded = await agent.loadSession(
      { sessionId: "persisted", cwd: "/workspace", mcpServers: [] },
      client,
      new AbortController().signal,
    );
    expect(client.updates.map((item) => item.update.sessionUpdate)).toEqual([
      "user_message_chunk",
      "available_commands_update",
    ]);
    expect(loaded.modes?.currentModeId).toBe("code");
    expect(loaded.configOptions).toHaveLength(2);

    await agent.setSessionMode(
      { sessionId: "persisted", modeId: "plan" },
      client,
      new AbortController().signal,
    );
    const config = await agent.setSessionConfigOption(
      { sessionId: "persisted", configId: "thinking", type: "boolean", value: true },
      client,
      new AbortController().signal,
    );
    expect(loadSession.modeCalls).toEqual(["plan"]);
    expect(config.configOptions).toContainEqual(
      expect.objectContaining({ id: "thinking", type: "boolean", currentValue: true }),
    );

    await agent.resumeSession(
      { sessionId: "resume-me", cwd: "/workspace" },
      client,
      new AbortController().signal,
    );
    const fork = await agent.forkSession(
      { sessionId: "persisted", cwd: "/workspace" },
      client,
      new AbortController().signal,
    );
    expect(fork.sessionId).toBe("forked");

    const page = await agent.listSessions(
      { cwd: "/workspace" },
      client,
      new AbortController().signal,
    );
    expect(page.sessions.map((session) => session.sessionId)).toEqual(["persisted"]);
    expect(page.nextCursor).toBe("next");

    await agent.closeSession(
      { sessionId: "resume-me" },
      client,
      new AbortController().signal,
    );
    await agent.deleteSession(
      { sessionId: "persisted" },
      client,
      new AbortController().signal,
    );
    expect(resumed.closeCalls).toBe(1);
    expect(loadSession.closeCalls).toBe(1);
    expect(driver.calls).toContainEqual({ method: "session/delete", input: "persisted" });
  });

  it.each(["new", "load", "resume", "fork"] as const)(
    "reclaims a late session/%s result after request cancellation",
    async (method) => {
      const driver = new FakeDshRuntimeDriver();
      const lateSession = new FakeRuntimeSession(`late-${method}`, "/workspace");
      const result = deferred<RuntimeSessionOpenResult>();
      const started = deferred<void>();
      const ignoreCancellation = async (): Promise<RuntimeSessionOpenResult> => {
        started.resolve();
        return result.promise;
      };
      const { agent, client } = await initializedAgent(driver);
      const controller = new AbortController();
      let opening: Promise<unknown>;

      switch (method) {
        case "new":
          driver.newSession = ignoreCancellation;
          opening = agent.newSession(
            { cwd: "/workspace", mcpServers: [] },
            client,
            controller.signal,
          );
          break;
        case "load":
          driver.loadSession = ignoreCancellation;
          opening = agent.loadSession(
            { sessionId: lateSession.id, cwd: "/workspace", mcpServers: [] },
            client,
            controller.signal,
          );
          break;
        case "resume":
          driver.resumeSession = ignoreCancellation;
          opening = agent.resumeSession(
            { sessionId: lateSession.id, cwd: "/workspace" },
            client,
            controller.signal,
          );
          break;
        case "fork":
          driver.forkSession = ignoreCancellation;
          opening = agent.forkSession(
            { sessionId: "source", cwd: "/workspace" },
            client,
            controller.signal,
          );
          break;
      }

      await started.promise;
      controller.abort();
      await expect(opening).rejects.toMatchObject({ code: -32800 });
      result.resolve(openResult(lateSession));
      await waitUntil(() => lateSession.closeCalls === 1, "late session cleanup");
    },
  );

  it("defers new and fork commands until the client can route their session", async () => {
    const driver = new FakeDshRuntimeDriver();
    const created = new FakeRuntimeSession("commands-new", "/workspace");
    const forked = new FakeRuntimeSession("commands-fork", "/workspace");
    driver.newResults.push(openResult(created, {
      commands: [{ name: "new-command", description: "Created command" }],
    }));
    driver.forkResults.push(openResult(forked, {
      commands: [{ name: "fork-command", description: "Forked command" }],
    }));
    const { agent, client } = await initializedAgent(driver);

    const opened = await agent.newSession(
      { cwd: "/workspace", mcpServers: [] },
      client,
      new AbortController().signal,
    );
    expect(client.updates).toHaveLength(0);
    await agent.prompt(
      { sessionId: opened.sessionId, prompt: [{ type: "text", text: "start" }] },
      client,
      new AbortController().signal,
    );
    expect(client.updates.at(0)?.update).toMatchObject({
      sessionUpdate: "available_commands_update",
      availableCommands: [expect.objectContaining({ name: "new-command" })],
    });

    const fork = await agent.forkSession(
      { sessionId: opened.sessionId, cwd: "/workspace" },
      client,
      new AbortController().signal,
    );
    expect(client.updates).toHaveLength(1);
    await agent.prompt(
      { sessionId: fork.sessionId, prompt: [{ type: "text", text: "continue" }] },
      client,
      new AbortController().signal,
    );
    expect(client.updates.at(1)?.update).toMatchObject({
      sessionUpdate: "available_commands_update",
      availableCommands: [expect.objectContaining({ name: "fork-command" })],
    });
  });

  it("claims the session turn before awaiting initial command delivery", async () => {
    const delivery = deferred<void>();
    const session = new FakeRuntimeSession("prompt-claim", "/workspace");
    const driver = new FakeDshRuntimeDriver();
    driver.newResults.push(openResult(session, {
      commands: [{ name: "review", description: "Review" }],
    }));
    const { agent, client } = await initializedAgent(driver);
    client.updateHandler = async () => delivery.promise;
    const opened = await agent.newSession(
      { cwd: "/workspace", mcpServers: [] },
      client,
      new AbortController().signal,
    );

    const first = agent.prompt(
      { sessionId: opened.sessionId, prompt: [{ type: "text", text: "first" }] },
      client,
      new AbortController().signal,
    );
    await waitUntil(() => client.updates.length === 1, "initial command delivery");
    await expect(
      agent.prompt(
        { sessionId: opened.sessionId, prompt: [{ type: "text", text: "second" }] },
        client,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: -32600 });
    expect(session.promptCalls).toHaveLength(0);
    delivery.resolve();
    await expect(first).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(session.promptCalls).toHaveLength(1);
  });

  it("cancels a prompt that is still publishing initial commands", async () => {
    const delivery = deferred<void>();
    const session = new FakeRuntimeSession("opening-cancel", "/workspace");
    const driver = new FakeDshRuntimeDriver();
    driver.newResults.push(openResult(session, {
      commands: [{ name: "review", description: "Review" }],
    }));
    const { agent, client } = await initializedAgent(driver);
    client.updateHandler = async () => delivery.promise;
    const opened = await agent.newSession(
      { cwd: "/workspace", mcpServers: [] },
      client,
      new AbortController().signal,
    );
    const prompting = agent.prompt(
      { sessionId: opened.sessionId, prompt: [{ type: "text", text: "wait" }] },
      client,
      new AbortController().signal,
    );
    await waitUntil(() => client.updates.length === 1, "opening prompt");

    agent.cancel({ sessionId: opened.sessionId });
    await expect(prompting).resolves.toEqual({ stopReason: "cancelled" });
    expect(session.promptCalls).toHaveLength(0);
    expect(session.cancelCalls).toHaveLength(1);
    delivery.resolve();
  });

  it("drains a late open cleanup before closing the driver", async () => {
    const result = deferred<RuntimeSessionOpenResult>();
    const closeGate = deferred<void>();
    const started = deferred<void>();
    const lateSession = new FakeRuntimeSession("close-late-open", "/workspace");
    lateSession.closeHandler = async () => closeGate.promise;
    const driver = new FakeDshRuntimeDriver();
    driver.newSession = async () => {
      started.resolve();
      return result.promise;
    };
    const { agent, client } = await initializedAgent(driver);
    const opening = agent.newSession(
      { cwd: "/workspace", mcpServers: [] },
      client,
      new AbortController().signal,
    );
    const openingCancelled = expect(opening).rejects.toMatchObject({ code: -32800 });
    await started.promise;
    const closing = agent.close();
    await openingCancelled;
    result.resolve(openResult(lateSession));
    await waitUntil(() => lateSession.closeCalls === 1, "late open close");
    expect(driver.closeCalls).toBe(0);
    closeGate.resolve();
    await closing;
    expect(driver.closeCalls).toBe(1);
  });

  it("bounds connection close when an open never settles", async () => {
    const never = deferred<RuntimeSessionOpenResult>();
    const started = deferred<void>();
    const driver = new FakeDshRuntimeDriver();
    driver.newSession = async () => {
      started.resolve();
      return never.promise;
    };
    const client = new FakeAcpClient();
    const agent = new DshAcpAgent({ driver, cancelDrainTimeoutMs: 5 });
    await agent.initialize({ protocolVersion: 1 }, client, new AbortController().signal);
    const opening = agent.newSession(
      { cwd: "/workspace", mcpServers: [] },
      client,
      new AbortController().signal,
    );
    const openingCancelled = expect(opening).rejects.toMatchObject({ code: -32800 });
    await started.promise;
    await agent.close();
    await openingCancelled;
    expect(driver.closeCalls).toBe(1);
  });

  it.each([
    ["DSH_SESSION_CURSOR_INVALID", -32602],
    ["DSH_SESSION_CURSOR_STALE", -32602],
    ["DSH_CWD_INVALID", -32602],
    ["DSH_CWD_UNSUPPORTED", -32602],
    ["DSH_PROMPT_EMPTY", -32602],
    ["DSH_STEER_EMPTY", -32602],
    ["DSH_MCP_CONFIG_INVALID", -32602],
  ] as const)("maps %s to an ACP client error", async (runtimeCode, acpCode) => {
    const driver = new FakeDshRuntimeDriver();
    driver.listSessions = async () => {
      throw new RuntimeCompatibilityError(runtimeCode, "runtime detail");
    };
    const { agent, client } = await initializedAgent(driver);
    await expect(
      agent.listSessions({ cursor: "bad" }, client, new AbortController().signal),
    ).rejects.toMatchObject({ code: acpCode, data: { code: runtimeCode } });
  });

  it.each([
    ["DSH_SESSION_NOT_FOUND", -32002],
    ["DSH_SESSION_NOT_PERSISTED", -32002],
    ["DSH_SESSION_CLOSED", -32002],
    ["DSH_AGENT_RETIRED", -32002],
    ["DSH_SESSION_ALREADY_ACTIVE", -32600],
    ["DSH_SESSION_BUSY", -32600],
    ["DSH_SESSION_OWNERSHIP_MISMATCH", -32600],
    ["DSH_PROMPT_INFLIGHT", -32600],
    ["DSH_STEER_REJECTED", -32600],
  ] as const)("maps %s to an ACP session error", async (runtimeCode, acpCode) => {
    const driver = new FakeDshRuntimeDriver();
    driver.loadSession = async () => {
      throw new RuntimeCompatibilityError(runtimeCode, "runtime detail");
    };
    const { agent, client } = await initializedAgent(driver);
    await expect(
      agent.loadSession(
        { sessionId: "persisted", cwd: "/workspace", mcpServers: [] },
        client,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: acpCode });
  });

  it.each([
    "DSH_SESSION_CANCELLED",
    "DSH_INITIALIZE_CANCELLED",
    "DSH_MCP_SETUP_CANCELLED",
    "DSH_STEER_CANCELLED",
  ] as const)("maps %s to ACP request cancellation", async (runtimeCode) => {
    const driver = new FakeDshRuntimeDriver();
    driver.listSessions = async () => {
      throw new RuntimeCompatibilityError(runtimeCode, "runtime detail");
    };
    const { agent, client } = await initializedAgent(driver);
    await expect(
      agent.listSessions({}, client, new AbortController().signal),
    ).rejects.toMatchObject({ code: -32800, data: { code: runtimeCode } });
  });

  it("finishes cancellation and runner drain before close despite an aborted request", async () => {
    const runnerGate = deferred<void>();
    const cancelGate = deferred<void>();
    const closeGate = deferred<void>();
    const session = new FakeRuntimeSession(
      "abort-close",
      "/workspace",
      async function* () {
        await runnerGate.promise;
        return { stopReason: "end_turn" };
      },
    );
    session.cancelHandler = async () => cancelGate.promise;
    session.closeHandler = async () => closeGate.promise;
    const driver = new FakeDshRuntimeDriver();
    driver.newResults.push(openResult(session));
    const client = new FakeAcpClient();
    const agent = new DshAcpAgent({ driver, cancelDrainTimeoutMs: 1_000 });
    await agent.initialize({ protocolVersion: 1 }, client, new AbortController().signal);
    const opened = await agent.newSession(
      { cwd: "/workspace", mcpServers: [] },
      client,
      new AbortController().signal,
    );
    const prompt = agent.prompt(
      { sessionId: opened.sessionId, prompt: [{ type: "text", text: "wait" }] },
      client,
      new AbortController().signal,
    );
    await waitUntil(() => session.promptCalls.length === 1, "active turn");

    const controller = new AbortController();
    controller.abort();
    const closing = agent.closeSession(
      { sessionId: opened.sessionId },
      client,
      controller.signal,
    );
    await waitUntil(() => session.cancelCalls.length === 1, "runtime cancellation");
    expect(session.closeCalls).toBe(0);
    cancelGate.resolve();
    await Promise.resolve();
    expect(session.closeCalls).toBe(0);
    runnerGate.resolve();
    await waitUntil(() => session.closeCalls === 1, "runtime close");
    closeGate.resolve();

    await expect(closing).rejects.toMatchObject({ code: -32800 });
    await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
  });

  it("uses the cancellation drain deadline as a close backstop", async () => {
    const neverRun = deferred<void>();
    const neverCancel = deferred<void>();
    const session = new FakeRuntimeSession(
      "bounded-close",
      "/workspace",
      async function* () {
        await neverRun.promise;
        return { stopReason: "end_turn" };
      },
    );
    session.cancelHandler = async () => neverCancel.promise;
    const driver = new FakeDshRuntimeDriver();
    driver.newResults.push(openResult(session));
    const client = new FakeAcpClient();
    const agent = new DshAcpAgent({ driver, cancelDrainTimeoutMs: 5 });
    await agent.initialize({ protocolVersion: 1 }, client, new AbortController().signal);
    const opened = await agent.newSession(
      { cwd: "/workspace", mcpServers: [] },
      client,
      new AbortController().signal,
    );
    const prompt = agent.prompt(
      { sessionId: opened.sessionId, prompt: [{ type: "text", text: "hang" }] },
      client,
      new AbortController().signal,
    );
    await waitUntil(() => session.promptCalls.length === 1, "hung turn");

    await agent.closeSession(
      { sessionId: opened.sessionId },
      client,
      new AbortController().signal,
    );
    expect(session.closeCalls).toBe(1);
    await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
    neverCancel.resolve();
    neverRun.resolve();
  });

  it("retains a failed session close so the ACP client can retry it", async () => {
    const { agent, client, session, sessionId } = await activeSession();
    let attempts = 0;
    session.closeHandler = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient session close failure");
    };

    await expect(
      agent.closeSession({ sessionId }, client, new AbortController().signal),
    ).rejects.toMatchObject({ code: -32603 });
    await expect(
      agent.closeSession({ sessionId }, client, new AbortController().signal),
    ).resolves.toEqual({});
    expect(session.closeCalls).toBe(2);
  });

  it("retries connection teardown without closing the driver ahead of failed sessions", async () => {
    const { agent, driver, session } = await activeSession();
    let sessionAttempts = 0;
    session.closeHandler = async () => {
      sessionAttempts += 1;
      if (sessionAttempts === 1) throw new Error("transient session close failure");
    };

    await expect(agent.close()).rejects.toThrow("failed to close one or more ACP runtime sessions");
    expect(driver.closeCalls).toBe(0);
    await expect(agent.close()).resolves.toBeUndefined();
    expect(session.closeCalls).toBe(2);
    expect(driver.closeCalls).toBe(1);
  });

  it("retries a transient driver close after ACP admission is already fenced", async () => {
    const { agent, driver } = await initializedAgent();
    driver.closeHandler = async () => {
      if (driver.closeCalls === 1) throw new Error("transient driver close failure");
    };

    await expect(agent.close()).rejects.toThrow("transient driver close failure");
    await expect(agent.close()).resolves.toBeUndefined();
    expect(driver.closeCalls).toBe(2);
  });

  it("completes persisted deletion after cancellation has claimed the request", async () => {
    const { agent, client, driver } = await initializedAgent();
    const controller = new AbortController();
    controller.abort();
    await expect(
      agent.deleteSession({ sessionId: "persisted" }, client, controller.signal),
    ).rejects.toMatchObject({ code: -32800 });
    expect(driver.calls).toContainEqual({ method: "session/delete", input: "persisted" });
  });

  it("supports authentication and fail-closed DSH provider selection", async () => {
    const { agent, client, driver } = await initializedAgent();
    await agent.authenticate(
      { methodId: "fake-auth" },
      client,
      new AbortController().signal,
    );
    const providers = await agent.listProviders({}, client, new AbortController().signal);
    expect(providers.providers[0]).toMatchObject({
      providerId: "deepseek",
      supported: ["_dsh"],
      current: { apiType: "_dsh", baseUrl: "dsh-provider:deepseek" },
    });
    await agent.setProvider(
      {
        providerId: "other",
        apiType: "_dsh",
        baseUrl: "dsh-provider:other",
      },
      client,
      new AbortController().signal,
    );
    await agent.disableProvider(
      { providerId: "other" },
      client,
      new AbortController().signal,
    );
    await agent.logout({}, client, new AbortController().signal);
    expect(driver.calls.map((call) => call.method)).toEqual(
      expect.arrayContaining([
        "authenticate",
        "providers/list",
        "providers/set",
        "providers/disable",
        "logout",
      ]),
    );

    await expect(
      agent.setProvider(
        { providerId: "deepseek", apiType: "openai", baseUrl: "https://example.com" },
        client,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("bridges client file access and both elicitation modes inside a live turn", async () => {
    const observed: unknown[] = [];
    const session = new FakeRuntimeSession(
      "client-bridge",
      "/workspace",
      async function* (_input, context) {
        observed.push(await context.readTextFile("/workspace/input.txt", 1, 2));
        await context.writeTextFile("/workspace/output.txt", "written");
        observed.push(
          await context.requestElicitation(
            {
              elicitationId: "form-1",
              mode: "form",
              message: "Choose",
              schema: {
                type: "object",
                properties: { answer: { type: "string" } },
                required: ["answer"],
              },
            },
            context.signal,
          ),
        );
        observed.push(
          await context.requestElicitation(
            {
              elicitationId: "url-1",
              mode: "url",
              message: "Open",
              url: "https://example.com/auth",
            },
            context.signal,
          ),
        );
        return { stopReason: "end_turn" };
      },
    );
    const { agent, client, sessionId } = await activeSession(session);
    client.files.set("/workspace/input.txt", "input");
    client.elicitationHandler = async (request) =>
      request.mode === "form"
        ? { action: "accept", content: { answer: "yes" } }
        : { action: "decline" };

    await expect(
      agent.prompt(
        { sessionId, prompt: [{ type: "text", text: "bridge" }] },
        client,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(observed).toEqual([
      "input",
      { action: "accept", content: { answer: "yes" } },
      { action: "decline" },
    ]);
    expect(client.files.get("/workspace/output.txt")).toBe("written");
    expect(client.elicitationRequests.map((request) => request.mode)).toEqual(["form", "url"]);
  });

  it("lexically fences client file requests to fixed session roots", async () => {
    const observed: string[] = [];
    const session = new FakeRuntimeSession(
      "root-fence",
      "/workspace",
      async function* (_input, context) {
        observed.push(await context.readTextFile("/workspace/in.txt"));
        observed.push(await context.readTextFile("/shared/in.txt"));
        return { stopReason: "end_turn" };
      },
    );
    const driver = new FakeDshRuntimeDriver();
    driver.newResults.push(openResult(session));
    const { agent, client } = await initializedAgent(driver);
    client.files.set("/workspace/in.txt", "cwd");
    client.files.set("/shared/in.txt", "additional");
    const opened = await agent.newSession(
      {
        cwd: "/workspace",
        additionalDirectories: ["/shared"],
        mcpServers: [],
      },
      client,
      new AbortController().signal,
    );
    await agent.prompt(
      { sessionId: opened.sessionId, prompt: [{ type: "text", text: "read" }] },
      client,
      new AbortController().signal,
    );
    expect(observed).toEqual(["cwd", "additional"]);

    session.promptHandler = async function* (_input, context) {
      await context.writeTextFile("/workspace-sibling/escape.txt", "no");
      return { stopReason: "end_turn" };
    };
    await expect(
      agent.prompt(
        { sessionId: opened.sessionId, prompt: [{ type: "text", text: "escape" }] },
        client,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: -32602 });
    expect(client.writeRequests).toHaveLength(0);
  });

  it("keeps cwd-only drivers fenced when additional directories are unsupported", async () => {
    const session = new FakeRuntimeSession(
      "cwd-only",
      "/workspace",
      async function* (_input, context) {
        await context.readTextFile("/outside/secret.txt");
        return { stopReason: "end_turn" };
      },
    );
    const driver = new FakeDshRuntimeDriver({ capabilities: minimalRuntimeCapabilities() });
    driver.newResults.push(openResult(session));
    const { agent, client } = await initializedAgent(driver);
    const opened = await agent.newSession(
      { cwd: "/workspace", mcpServers: [] },
      client,
      new AbortController().signal,
    );
    await expect(
      agent.prompt(
        { sessionId: opened.sessionId, prompt: [{ type: "text", text: "escape" }] },
        client,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: -32602 });
    expect(client.readRequests).toHaveLength(0);
  });

  it("sends URL elicitation completion only through the enabled callback gate", async () => {
    const session = new FakeRuntimeSession(
      "elicitation-completion",
      "/workspace",
      async function* (_input, context) {
        await context.requestElicitation(
          {
            elicitationId: "oauth-1",
            mode: "url",
            message: "Authorize",
            url: "https://example.com/connect",
          },
          context.signal,
        );
        return { stopReason: "end_turn" };
      },
    );
    const driver = new FakeDshRuntimeDriver();
    driver.newResults.push(openResult(session));
    const client = new FakeAcpClient();
    client.elicitationHandler = async () => ({ action: "accept" });
    const agent = new DshAcpAgent({ driver, elicitationCompletion: true });
    const initialized = await agent.initialize(
      { protocolVersion: 1, clientCapabilities: TEST_CLIENT_CAPABILITIES },
      client,
      new AbortController().signal,
    );
    expect(initialized.agentCapabilities?._meta?.["offloop.dsh-acp"]).toMatchObject({
      elicitationCompletion: true,
    });
    const opened = await agent.newSession(
      { cwd: "/workspace", mcpServers: [] },
      client,
      new AbortController().signal,
    );
    await agent.prompt(
      { sessionId: opened.sessionId, prompt: [{ type: "text", text: "auth" }] },
      client,
      new AbortController().signal,
    );
    await expect(agent.completeElicitation("oauth-1")).resolves.toBe(true);
    await expect(agent.completeElicitation("oauth-1")).resolves.toBe(false);
    expect(client.completedElicitations).toEqual(["oauth-1"]);
  });

  it("fails closed before calling unsupported driver operations", async () => {
    const driver = new FakeDshRuntimeDriver({ capabilities: minimalRuntimeCapabilities() });
    const { agent, client } = await initializedAgent(driver);
    await expect(
      agent.loadSession(
        { sessionId: "missing", cwd: "/workspace", mcpServers: [] },
        client,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: -32601 });
    await expect(
      agent.newSession(
        {
          cwd: "/workspace",
          mcpServers: [{ name: "server", command: "/bin/tool", args: [], env: [] }],
        },
        client,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: -32602 });
    expect(driver.calls.map((call) => call.method)).not.toContain("session/new");

    const session = new FakeRuntimeSession("text-only", "/workspace");
    driver.newResults.push(openResult(session));
    const opened = await agent.newSession(
      { cwd: "/workspace", mcpServers: [] },
      client,
      new AbortController().signal,
    );
    await expect(
      agent.prompt(
        {
          sessionId: opened.sessionId,
          prompt: [{ type: "image", data: "AA==", mimeType: "image/png" }],
        },
        client,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: -32602 });
    expect(session.promptCalls).toHaveLength(0);
  });

  it("deletes an active session before deleting its persisted record", async () => {
    const { agent, client, driver, session, sessionId } = await activeSession();
    await agent.deleteSession(
      { sessionId },
      client,
      new AbortController().signal,
    );
    expect(session.closeCalls).toBe(1);
    expect(driver.calls.slice(-1)).toEqual([{ method: "session/delete", input: sessionId }]);
    await expect(
      agent.prompt(
        { sessionId, prompt: [{ type: "text", text: "gone" }] },
        client,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: -32002 });
  });

  it("rejects runtime history on resume instead of silently duplicating it", async () => {
    const driver = new FakeDshRuntimeDriver();
    const session = new FakeRuntimeSession("resume-history", "/workspace");
    driver.resumeResults.push(
      openResult(session, {
        replay: runtimeEvents([
          { type: "agent_message_chunk", content: { type: "text", text: "history" } },
        ]),
      }),
    );
    const { agent, client } = await initializedAgent(driver);
    await expect(
      agent.resumeSession(
        { sessionId: session.id, cwd: session.cwd },
        client,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: -32603 });
    expect(session.closeCalls).toBe(1);
  });

  it("closes a mismatched runtime session during activation rollback", async () => {
    const driver = new FakeDshRuntimeDriver();
    const session = new FakeRuntimeSession("actual", "/wrong-cwd");
    driver.newResults.push(
      openResult(session, {
        descriptor: { id: "different", cwd: "/wrong-cwd" },
      }),
    );
    const { agent, client } = await initializedAgent(driver);
    await expect(
      agent.newSession(
        { cwd: "/workspace", mcpServers: [] },
        client,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: -32603 });
    expect(session.closeCalls).toBe(1);
  });
});
