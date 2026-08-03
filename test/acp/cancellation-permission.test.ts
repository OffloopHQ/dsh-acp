import { describe, expect, it } from "vitest";
import { DshAcpAgent } from "../../src/acp/agent.js";
import type {
  RuntimePermissionOutcome,
  RuntimePermissionRequest,
} from "../../src/runtime/types.js";
import {
  deferred,
  FakeDshRuntimeDriver,
  FakeRuntimeSession,
  openResult,
  runtimeEvents,
} from "../../src/testing/fake-runtime.js";
import { activeSession, initializedAgent, waitUntil } from "./helpers.js";

describe("turn cancellation fences", () => {
  it("isolates and closes a session whose generator ignores cancellation", async () => {
    const never = deferred<void>();
    const session = new FakeRuntimeSession(
      "hung-cancel",
      "/workspace",
      async function* () {
        await never.promise;
        return { stopReason: "end_turn" };
      },
    );
    const driver = new FakeDshRuntimeDriver();
    driver.newResults.push(openResult(session));
    const client = new (await import("../../src/testing/fake-client.js")).FakeAcpClient();
    const agent = new DshAcpAgent({ driver, cancelDrainTimeoutMs: 5 });
    await agent.initialize(
      { protocolVersion: 1 },
      client,
      new AbortController().signal,
    );
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
    await waitUntil(() => session.promptCalls.length === 1, "hung prompt start");
    agent.cancel({ sessionId: opened.sessionId });
    await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
    await waitUntil(() => session.closeCalls === 1, "cancel drain backstop");
    await expect(
      agent.prompt(
        { sessionId: opened.sessionId, prompt: [{ type: "text", text: "unsafe retry" }] },
        client,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: -32002 });
    never.resolve();
  });

  it("runs different sessions independently while enforcing one turn per session", async () => {
    const release = deferred<void>();
    const first = new FakeRuntimeSession(
      "multi-1",
      "/workspace",
      async function* () {
        await release.promise;
        return { stopReason: "end_turn" };
      },
    );
    const second = new FakeRuntimeSession(
      "multi-2",
      "/workspace",
      () => runtimeEvents([]),
    );
    const driver = new FakeDshRuntimeDriver();
    driver.newResults.push(openResult(first), openResult(second));
    const { agent, client } = await initializedAgent(driver);
    const firstOpen = await agent.newSession(
      { cwd: "/workspace", mcpServers: [] },
      client,
      new AbortController().signal,
    );
    const secondOpen = await agent.newSession(
      { cwd: "/workspace", mcpServers: [] },
      client,
      new AbortController().signal,
    );

    const firstPrompt = agent.prompt(
      { sessionId: firstOpen.sessionId, prompt: [{ type: "text", text: "wait" }] },
      client,
      new AbortController().signal,
    );
    await waitUntil(() => first.promptCalls.length === 1, "first session prompt");
    await expect(
      agent.prompt(
        { sessionId: firstOpen.sessionId, prompt: [{ type: "text", text: "overlap" }] },
        client,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: -32600 });
    await expect(
      agent.prompt(
        { sessionId: secondOpen.sessionId, prompt: [{ type: "text", text: "independent" }] },
        client,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ stopReason: "end_turn" });

    release.resolve();
    await expect(firstPrompt).resolves.toMatchObject({ stopReason: "end_turn" });
  });

  it("unifies session/cancel with runtime cancellation and drops stale events", async () => {
    const release = deferred<void>();
    let invocation = 0;
    const session = new FakeRuntimeSession(
      "cancel-session",
      "/workspace",
      async function* () {
        invocation++;
        if (invocation === 1) {
          yield {
            type: "agent_message_chunk",
            content: { type: "text", text: "before cancel" },
          };
          await release.promise;
          yield {
            type: "agent_message_chunk",
            content: { type: "text", text: "late event" },
          };
          return { stopReason: "end_turn" };
        }
        return yield* runtimeEvents([
          {
            type: "agent_message_chunk",
            content: { type: "text", text: "next turn" },
          },
        ]);
      },
    );
    const { agent, client, sessionId } = await activeSession(session);

    const prompt = agent.prompt(
      { sessionId, prompt: [{ type: "text", text: "hello" }] },
      client,
      new AbortController().signal,
    );
    await waitUntil(() => client.updates.length === 1, "first update");
    agent.cancel({ sessionId });

    const cancelledPrompt = expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
    expect(session.cancelCalls).toHaveLength(1);
    await expect(
      agent.prompt(
        { sessionId, prompt: [{ type: "text", text: "too soon" }] },
        client,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: -32600 });

    release.resolve();
    await cancelledPrompt;
    await waitUntil(() => invocation === 1 && session.promptCalls.length === 1, "runner drain");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(client.updates.map((notification) => notification.update)).not.toContainEqual(
      expect.objectContaining({ content: expect.objectContaining({ text: "late event" }) }),
    );

    const second = await agent.prompt(
      { sessionId, prompt: [{ type: "text", text: "again" }] },
      client,
      new AbortController().signal,
    );
    expect(second.stopReason).toBe("end_turn");
  });

  it("uses request AbortSignal as the same cancellation path", async () => {
    const release = deferred<void>();
    const session = new FakeRuntimeSession(
      "request-abort",
      "/workspace",
      async function* () {
        await release.promise;
        return { stopReason: "end_turn" };
      },
    );
    const { agent, client, sessionId } = await activeSession(session);
    const controller = new AbortController();
    const prompt = agent.prompt(
      { sessionId, prompt: [{ type: "text", text: "hello" }] },
      client,
      controller.signal,
    );
    await waitUntil(() => session.promptCalls.length === 1, "prompt start");
    controller.abort();

    expect(session.cancelCalls).toHaveLength(1);
    release.resolve();
    await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
  });

  it("supports negotiated steering without starting a second turn", async () => {
    const release = deferred<void>();
    const session = new FakeRuntimeSession(
      "steering",
      "/workspace",
      async function* () {
        await release.promise;
        return { stopReason: "end_turn" };
      },
    );
    const { agent, client, sessionId } = await activeSession(session);
    const prompt = agent.prompt(
      { sessionId, prompt: [{ type: "text", text: "initial" }] },
      client,
      new AbortController().signal,
    );
    await waitUntil(() => session.promptCalls.length === 1, "active steering turn");
    await agent.steer(
      { sessionId, prompt: [{ type: "text", text: "new direction" }] },
      client,
      new AbortController().signal,
    );
    expect(session.steerCalls[0]?.input.content).toEqual([
      { type: "text", text: "new direction" },
    ]);
    release.resolve();
    await expect(prompt).resolves.toMatchObject({ stopReason: "end_turn" });
    await expect(
      agent.steer(
        { sessionId, prompt: [{ type: "text", text: "too late" }] },
        client,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: -32600 });
  });

  it("emits the tool call before permission and rejects a late approval", async () => {
    const permission = deferred<{
      outcome: { outcome: "selected"; optionId: string };
    }>();
    const observedOutcome = deferred<RuntimePermissionOutcome>();
    const order: string[] = [];
    const session = new FakeRuntimeSession(
      "permission-race",
      "/workspace",
      async function* (_input, context) {
        const outcome = await context.requestPermission(
          {
            requestId: "permission-1",
            toolCallId: "tool-1",
            title: "Edit file",
            kind: "edit",
            choices: [
              { id: "reject", name: "Reject", kind: "reject_once" },
              { id: "allow", name: "Allow", kind: "allow_once" },
            ],
          },
          context.signal,
        );
        observedOutcome.resolve(outcome);
        yield {
          type: "agent_message_chunk",
          content: { type: "text", text: "must be stale" },
        };
        return { stopReason: "end_turn" };
      },
    );
    const { agent, client, sessionId } = await activeSession(session);
    client.updateHandler = async (notification) => {
      order.push(notification.update.sessionUpdate);
    };
    client.permissionHandler = async () => {
      order.push("request_permission");
      return permission.promise;
    };

    const prompt = agent.prompt(
      { sessionId, prompt: [{ type: "text", text: "edit" }] },
      client,
      new AbortController().signal,
    );
    await waitUntil(() => client.permissionRequests.length === 1, "permission request");
    expect(order.slice(0, 2)).toEqual(["tool_call", "request_permission"]);

    agent.cancel({ sessionId });
    await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
    permission.resolve({ outcome: { outcome: "selected", optionId: "allow" } });
    await expect(observedOutcome.promise).resolves.toEqual({ outcome: "cancelled" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(client.updates).toHaveLength(1);
  });

  it("turns the real tool event after a synthetic permission create into an update", async () => {
    const session = new FakeRuntimeSession(
      "permission-tool-dedupe",
      "/workspace",
      async function* (_input, context) {
        await context.requestPermission(
          {
            requestId: "permission-dedupe",
            toolCallId: "tool-dedupe",
            title: "Edit",
            kind: "edit",
            choices: [{ id: "allow", name: "Allow", kind: "allow_once" }],
          },
          context.signal,
        );
        yield {
          type: "tool_call",
          toolCallId: "tool-dedupe",
          title: "Edit",
          kind: "edit",
          status: "in_progress",
        };
        return { stopReason: "end_turn" };
      },
    );
    const { agent, client, sessionId } = await activeSession(session);
    client.permissionHandler = async () => ({
      outcome: { outcome: "selected", optionId: "allow" },
    });
    await agent.prompt(
      { sessionId, prompt: [{ type: "text", text: "edit" }] },
      client,
      new AbortController().signal,
    );
    const toolUpdates = client.updates
      .map((notification) => notification.update)
      .filter(
        (update) =>
          "toolCallId" in update && update.toolCallId === "tool-dedupe",
      );
    expect(toolUpdates.map((update) => update.sessionUpdate)).toEqual([
      "tool_call",
      "tool_call_update",
    ]);
  });

  it.each([
    ["empty choices", []],
    [
      "duplicate option ids",
      [
        { id: "same", name: "Allow", kind: "allow_once" },
        { id: "same", name: "Reject", kind: "reject_once" },
      ],
    ],
    ["unknown option kind", [{ id: "bad", name: "Bad", kind: "future_kind" }]],
  ])("fails closed for %s", async (_name, invalidChoices) => {
    const choices = invalidChoices as unknown as RuntimePermissionRequest["choices"];
    const session = new FakeRuntimeSession(
      "invalid-permission",
      "/workspace",
      async function* (_input, context) {
        await context.requestPermission(
          {
            requestId: "invalid",
            toolCallId: "invalid-tool",
            title: "Invalid",
            kind: "other",
            choices,
          },
          context.signal,
        );
        return { stopReason: "end_turn" };
      },
    );
    const { agent, client, sessionId } = await activeSession(session);
    await expect(
      agent.prompt(
        { sessionId, prompt: [{ type: "text", text: "invalid" }] },
        client,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: -32603 });
    expect(client.permissionRequests).toHaveLength(0);
    expect(client.updates).toHaveLength(0);
  });

  it("invalidates an outstanding permission before close completes", async () => {
    const permission = deferred<{
      outcome: { outcome: "selected"; optionId: string };
    }>();
    const observedOutcome = deferred<RuntimePermissionOutcome>();
    const session = new FakeRuntimeSession(
      "close-permission",
      "/workspace",
      async function* (_input, context) {
        observedOutcome.resolve(
          await context.requestPermission(
            {
              requestId: "permission-close",
              toolCallId: "tool-close",
              title: "Run command",
              kind: "execute",
              choices: [{ id: "allow", name: "Allow", kind: "allow_once" }],
            },
            context.signal,
          ),
        );
        return { stopReason: "end_turn" };
      },
    );
    const { agent, client, sessionId } = await activeSession(session);
    client.permissionHandler = async () => permission.promise;
    const prompt = agent.prompt(
      { sessionId, prompt: [{ type: "text", text: "run" }] },
      client,
      new AbortController().signal,
    );
    await waitUntil(() => client.permissionRequests.length === 1, "permission request");

    await agent.closeSession(
      { sessionId },
      client,
      new AbortController().signal,
    );
    await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
    permission.resolve({ outcome: { outcome: "selected", optionId: "allow" } });
    await expect(observedOutcome.promise).resolves.toEqual({ outcome: "cancelled" });
    expect(session.closeCalls).toBe(1);
    expect(session.cancelCalls).toHaveLength(1);
  });
});
