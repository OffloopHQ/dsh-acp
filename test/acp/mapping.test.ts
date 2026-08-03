import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../../src/runtime/types.js";
import {
  FakeRuntimeSession,
  fullRuntimeCapabilities,
  runtimeEvents,
} from "../../src/testing/fake-runtime.js";
import { activeSession } from "./helpers.js";

describe("runtime event mapping", () => {
  it("maps every declared runtime event family to ACP updates", async () => {
    const events: RuntimeEvent[] = [
      { type: "user_message_chunk", content: { type: "text", text: "user" }, messageId: "u" },
      {
        type: "agent_message_chunk",
        content: { type: "image", data: "AA==", mimeType: "image/png" },
        messageId: "a",
      },
      {
        type: "agent_thought_chunk",
        content: {
          type: "resource_link",
          uri: "file:///thought.md",
          name: "thought",
        },
      },
      {
        type: "tool_call",
        toolCallId: "tool",
        title: "Read",
        kind: "read",
        status: "in_progress",
        locations: [{ path: "/workspace/a.ts", line: 4 }],
        rawInput: { path: "a.ts" },
      },
      {
        type: "tool_call_update",
        toolCallId: "tool",
        status: "completed",
        content: [
          { type: "content", content: { type: "text", text: "done" } },
          { type: "diff", path: "/workspace/a.ts", oldText: "a", newText: "b" },
          { type: "terminal", terminalId: "client-terminal" },
        ],
        rawOutput: { ok: true },
      },
      {
        type: "tool_call_update",
        toolCallId: "update-before-create",
        title: "Implicit",
        kind: "search",
        status: "in_progress",
      },
      {
        type: "plan",
        entries: [{ content: "First", priority: "high", status: "pending" }],
      },
      {
        type: "plan_update",
        entries: [{ content: "First", priority: "high", status: "completed" }],
      },
      {
        type: "available_commands_update",
        commands: [{ name: "review", description: "Review", inputHint: "path" }],
      },
      { type: "current_mode_update", modeId: "plan" },
      {
        type: "config_option_update",
        options: [
          { id: "thinking", name: "Thinking", kind: "boolean", currentValue: true },
        ],
      },
      { type: "session_info_update", title: "Renamed", updatedAt: "2026-01-01T00:00:00Z" },
      {
        type: "usage_update",
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 2,
        contextWindow: 128_000,
        costUsd: 0.02,
      },
      { type: "terminal_info", terminalId: "term", title: "Build" },
      { type: "terminal_output", terminalId: "term", data: "building\n" },
      { type: "terminal_exit", terminalId: "term", exitCode: 0 },
      {
        type: "subagent_activity",
        toolCallId: "subagent",
        status: "in_progress",
        content: { type: "text", text: "researching" },
      },
      {
        type: "subagent_activity",
        toolCallId: "subagent",
        status: "completed",
      },
    ];
    const session = new FakeRuntimeSession(
      "mapping",
      "/workspace",
      () =>
        runtimeEvents(events, {
          stopReason: "end_turn",
          usage: {
            type: "usage_update",
            inputTokens: 10,
            outputTokens: 5,
            cachedInputTokens: 2,
          },
        }),
    );
    const { agent, client, sessionId } = await activeSession(session);
    const response = await agent.prompt(
      { sessionId, prompt: [{ type: "text", text: "map" }] },
      client,
      new AbortController().signal,
    );

    expect(response).toMatchObject({
      stopReason: "end_turn",
      usage: { totalTokens: 15, inputTokens: 10, outputTokens: 5, cachedReadTokens: 2 },
    });
    const updates = client.updates.map((notification) => notification.update);
    expect(updates.map((update) => update.sessionUpdate)).toEqual([
      "user_message_chunk",
      "agent_message_chunk",
      "agent_thought_chunk",
      "tool_call",
      "tool_call_update",
      "tool_call",
      "tool_call_update",
      "plan",
      "plan_update",
      "available_commands_update",
      "current_mode_update",
      "config_option_update",
      "session_info_update",
      "usage_update",
      "tool_call",
      "tool_call_update",
      "tool_call_update",
      "tool_call",
      "tool_call_update",
    ]);
    expect(updates).toContainEqual(
      expect.objectContaining({
        sessionUpdate: "usage_update",
        used: 15,
        size: 128_000,
        cost: { amount: 0.02, currency: "USD" },
      }),
    );
  });

  it("fails a turn when a driver emits an event it did not declare", async () => {
    const capabilities = fullRuntimeCapabilities();
    const narrowed = {
      ...capabilities,
      updates: new Set<RuntimeEvent["type"]>(["agent_message_chunk"]),
    };
    const session = new FakeRuntimeSession(
      "undeclared",
      "/workspace",
      () =>
        runtimeEvents([
          { type: "agent_thought_chunk", content: { type: "text", text: "hidden" } },
        ]),
    );
    const { FakeDshRuntimeDriver } = await import("../../src/testing/fake-runtime.js");
    const driver = new FakeDshRuntimeDriver({ capabilities: narrowed });
    const { agent, client, sessionId } = await activeSession(session, driver);

    await expect(
      agent.prompt(
        { sessionId, prompt: [{ type: "text", text: "go" }] },
        client,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: -32603 });
    expect(client.updates).toHaveLength(0);
  });

  it("creates an out-of-order terminal once and never reopens it after exit", async () => {
    const session = new FakeRuntimeSession(
      "terminal-order",
      "/workspace",
      () => runtimeEvents([
        { type: "terminal_exit", terminalId: "late-info", exitCode: 0 },
        { type: "terminal_info", terminalId: "late-info", title: "Late title" },
        { type: "terminal_output", terminalId: "late-info", data: "late output\n" },
      ]),
    );
    const { agent, client, sessionId } = await activeSession(session);
    await agent.prompt(
      { sessionId, prompt: [{ type: "text", text: "run" }] },
      client,
      new AbortController().signal,
    );

    const terminal = client.updates.map((notification) => notification.update).filter(
      (update) => "toolCallId" in update && update.toolCallId === "dsh-terminal:late-info",
    );
    expect(terminal.map((update) => update.sessionUpdate)).toEqual([
      "tool_call",
      "tool_call_update",
      "tool_call_update",
    ]);
    expect(terminal[0]).toMatchObject({ status: "completed" });
    expect(terminal[1]).not.toHaveProperty("status");
  });
});
