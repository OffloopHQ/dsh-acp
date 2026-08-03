import {
  client,
  methods,
  ndJsonStream,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { createDshAcpApp } from "../../src/acp/app.js";
import {
  DSH_STEERING_METHOD,
  type DshSteeringRequest,
  type DshSteeringResponse,
} from "../../src/acp/types.js";
import {
  deferred,
  FakeDshRuntimeDriver,
  FakeRuntimeSession,
  openResult,
  runtimeEvents,
} from "../../src/testing/fake-runtime.js";
import { waitUntil } from "./helpers.js";

describe("ACP app and NDJSON transport", () => {
  it("delivers URL elicitation completion on the initiating connection", async () => {
    const driver = new FakeDshRuntimeDriver();
    const session = new FakeRuntimeSession(
      "wire-elicitation",
      "/workspace",
      async function* (_input, context) {
        await context.requestElicitation(
          {
            elicitationId: "wire-oauth",
            mode: "url",
            message: "Authorize",
            url: "https://example.com/connect",
          },
          context.signal,
        );
        return { stopReason: "end_turn" };
      },
    );
    driver.newResults.push(openResult(session));
    const completed: string[] = [];
    const clientApp = client({ name: "elicitation-client" })
      .onRequest(methods.client.elicitation.create, () => ({ action: "accept" }))
      .onNotification(methods.client.elicitation.complete, ({ params }) => {
        completed.push(params.elicitationId);
      });
    const app = createDshAcpApp({
      driver,
      version: "test",
      elicitationCompletion: true,
    });
    const connection = clientApp.connect(app);
    try {
      await connection.agent.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: { elicitation: { url: {} } },
      });
      const opened = await connection.agent.request(methods.agent.session.new, {
        cwd: "/workspace",
        mcpServers: [],
      });
      await connection.agent.request(methods.agent.session.prompt, {
        sessionId: opened.sessionId,
        prompt: [{ type: "text", text: "authorize" }],
      });
      await expect(app.completeElicitation("wire-oauth")).resolves.toBe(true);
      expect(completed).toEqual(["wire-oauth"]);
    } finally {
      connection.close();
      await connection.closed;
    }
  });

  it("registers the negotiated steering extension", async () => {
    const release = deferred<void>();
    const driver = new FakeDshRuntimeDriver();
    const session = new FakeRuntimeSession(
      "wire-steering",
      "/workspace",
      async function* () {
        await release.promise;
        return { stopReason: "end_turn" };
      },
    );
    driver.newResults.push(openResult(session));
    const connection = client({ name: "steering-client" }).connect(
      createDshAcpApp({ driver, version: "test" }),
    );
    try {
      const initialized = await connection.agent.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      expect(initialized.agentCapabilities?._meta?.["offloop.dsh-acp"]).toMatchObject({
        steering: true,
      });
      expect(initialized.agentCapabilities?._meta?.["steering"]).toEqual({
        supported: true,
      });
      const opened = await connection.agent.request(methods.agent.session.new, {
        cwd: "/workspace",
        mcpServers: [],
      });
      const prompt = connection.agent.request(methods.agent.session.prompt, {
        sessionId: opened.sessionId,
        prompt: [{ type: "text", text: "initial" }],
      });
      await waitUntil(() => session.promptCalls.length === 1, "wire prompt");
      const steering = await connection.agent.request<DshSteeringResponse, DshSteeringRequest>(
        DSH_STEERING_METHOD,
        {
          sessionId: opened.sessionId,
          prompt: [{ type: "text", text: "steer" }],
        },
      );
      expect(steering).toEqual({ outcome: "injected" });
      expect(session.steerCalls).toHaveLength(1);
      release.resolve();
      await expect(prompt).resolves.toMatchObject({ stopReason: "end_turn" });
    } finally {
      connection.close();
      await connection.closed;
    }
  });

  it("registers the full method surface on an in-process ACP connection", async () => {
    const driver = new FakeDshRuntimeDriver();
    const session = new FakeRuntimeSession(
      "in-process",
      "/workspace",
      () =>
        runtimeEvents([
          { type: "agent_message_chunk", content: { type: "text", text: "hello" } },
        ]),
    );
    driver.newResults.push(openResult(session));
    const updates: SessionNotification[] = [];
    const clientApp = client({ name: "test-client" }).onNotification(
      methods.client.session.update,
      ({ params }) => {
        updates.push(params);
      },
    );
    const connection = clientApp.connect(createDshAcpApp({ driver, version: "test" }));
    try {
      const initialized = await connection.agent.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      expect(initialized.agentInfo?.name).toBe("dsh-acp");
      const opened = await connection.agent.request(methods.agent.session.new, {
        cwd: "/workspace",
        mcpServers: [],
      });
      const prompted = await connection.agent.request(methods.agent.session.prompt, {
        sessionId: opened.sessionId,
        prompt: [{ type: "text", text: "hi" }],
      });
      expect(prompted.stopReason).toBe("end_turn");
      expect(updates).toHaveLength(1);
    } finally {
      connection.close();
      await connection.closed;
    }
  });

  it("isolates drivers and lifecycle across simultaneous app connections", async () => {
    const firstDriver = new FakeDshRuntimeDriver({ id: "connection-one" });
    const secondDriver = new FakeDshRuntimeDriver({ id: "connection-two" });
    firstDriver.newResults.push(openResult(new FakeRuntimeSession("same-id", "/one")));
    secondDriver.newResults.push(openResult(new FakeRuntimeSession("same-id", "/two")));
    const drivers = [firstDriver, secondDriver];
    const app = createDshAcpApp({
      createDriver: () => {
        const driver = drivers.shift();
        if (driver === undefined) {
          throw new Error("unexpected connection");
        }
        return driver;
      },
      version: "test",
    });
    const first = client({ name: "first-client" }).connect(app);
    const second = client({ name: "second-client" }).connect(app);
    let firstClosed = false;
    try {
      await Promise.all([
        first.agent.request(methods.agent.initialize, {
          protocolVersion: 1,
          clientCapabilities: {},
        }),
        second.agent.request(methods.agent.initialize, {
          protocolVersion: 1,
          clientCapabilities: {},
        }),
      ]);
      const [firstSession, secondSession] = await Promise.all([
        first.agent.request(methods.agent.session.new, { cwd: "/one", mcpServers: [] }),
        second.agent.request(methods.agent.session.new, { cwd: "/two", mcpServers: [] }),
      ]);
      expect(firstSession.sessionId).toBe("same-id");
      expect(secondSession.sessionId).toBe("same-id");
      expect(firstDriver.calls.some((call) => call.method === "session/new")).toBe(true);
      expect(secondDriver.calls.some((call) => call.method === "session/new")).toBe(true);

      first.close();
      await first.closed;
      firstClosed = true;
      await waitUntil(() => firstDriver.closeCalls === 1, "first driver close");
      expect(firstDriver.closeCalls).toBe(1);
      expect(secondDriver.closeCalls).toBe(0);
      await expect(
        second.agent.request(methods.agent.session.prompt, {
          sessionId: secondSession.sessionId,
          prompt: [{ type: "text", text: "still live" }],
        }),
      ).resolves.toMatchObject({ stopReason: "end_turn" });
    } finally {
      if (!firstClosed) {
        first.close();
      }
      second.close();
      await Promise.all([first.closed, second.closed]);
    }
    await waitUntil(() => secondDriver.closeCalls === 1, "second driver close");
    expect(secondDriver.closeCalls).toBe(1);
  });

  it("retries a transient core teardown after the SDK connection closes once", async () => {
    const driver = new FakeDshRuntimeDriver();
    driver.closeHandler = async () => {
      if (driver.closeCalls === 1) throw new Error("transient close failure");
    };
    const app = createDshAcpApp({ driver, version: "test" });
    const connection = client({ name: "retry-close-client" }).connect(app);
    await connection.agent.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
    });

    connection.close();
    await connection.closed;
    await waitUntil(() => driver.closeCalls === 2, "retried driver close");
    expect(app.activeAgents.size).toBe(0);
  });

  it("retains a closed connection for explicit cleanup after automatic retries fail", async () => {
    const driver = new FakeDshRuntimeDriver();
    driver.closeHandler = () => Promise.reject(new Error("persistent close failure"));
    const app = createDshAcpApp({ driver, version: "test" });
    const connection = client({ name: "retained-close-client" }).connect(app);
    await connection.agent.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
    });

    connection.close();
    await connection.closed;
    await waitUntil(() => driver.closeCalls === 3, "automatic close retries");
    expect(app.activeAgents.size).toBe(0);
    await expect(app.completeElicitation("closed-connection")).resolves.toBe(false);

    driver.closeHandler = () => Promise.resolve();
    await expect(app.retryCleanup()).resolves.toBeUndefined();
    expect(driver.closeCalls).toBe(4);
    await expect(app.retryCleanup()).resolves.toBeUndefined();
    expect(driver.closeCalls).toBe(4);
  });

  it("keeps failed explicit cleanup retryable", async () => {
    const driver = new FakeDshRuntimeDriver();
    driver.closeHandler = () => Promise.reject(new Error("still busy"));
    const app = createDshAcpApp({ driver, version: "test" });
    const connection = client({ name: "repeat-cleanup-client" }).connect(app);
    await connection.agent.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
    });

    connection.close();
    await connection.closed;
    await waitUntil(() => driver.closeCalls === 3, "automatic close retries");
    await expect(app.retryCleanup()).rejects.toThrow("failed to clean up one or more closed ACP connections");
    expect(driver.closeCalls).toBe(6);

    driver.closeHandler = () => Promise.resolve();
    await expect(app.retryCleanup()).resolves.toBeUndefined();
    expect(driver.closeCalls).toBe(7);
  });

  it("keeps the byte stream strictly newline-delimited JSON", async () => {
    const driver = new FakeDshRuntimeDriver();
    const session = new FakeRuntimeSession("stdio", "/workspace");
    driver.newResults.push(openResult(session));
    const app = createDshAcpApp({ driver, version: "test" });
    const clientApp = client({ name: "wire-client" });
    const captured: Uint8Array[] = [];
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        captured.push(chunk.slice());
        controller.enqueue(chunk);
      },
    });
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentConnection = app.connect(
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );
    const clientConnection = clientApp.connect(
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );

    try {
      await clientConnection.agent.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      await clientConnection.agent.request(methods.agent.session.new, {
        cwd: "/workspace",
        mcpServers: [],
      });
      const output = new TextDecoder().decode(concatenate(captured));
      expect(output.endsWith("\n")).toBe(true);
      const lines = output.trimEnd().split("\n");
      expect(lines.length).toBeGreaterThanOrEqual(2);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
      expect(lines.some((line) => line.includes("DeepSeek Harness ACP"))).toBe(true);
    } finally {
      clientConnection.close();
      agentConnection.close();
      await Promise.all([clientConnection.closed, agentConnection.closed]);
    }
  });
});

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
