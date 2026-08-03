import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";

import {
  DSH_MCP_STDERR_MAX_LINES,
  DSH_MCP_STDERR_MAX_LINE_BYTES,
  DSH_MCP_STDERR_MAX_TOTAL_BYTES,
  createDsh001McpConfigs,
  installDsh001McpServers,
} from "../../src/runtime/drivers/dsh-0.0.1/host.js";

class FakeStdioTransport {
  static readonly instances: FakeStdioTransport[] = [];

  readonly stderr = new PassThrough();

  constructor(readonly config: Readonly<Record<string, unknown>>) {
    FakeStdioTransport.instances.push(this);
  }
}

class FakeMcpClient {
  static readonly instances: FakeMcpClient[] = [];

  readonly close = vi.fn(() => Promise.resolve());
  readonly connect = vi.fn((_transport: unknown) => Promise.resolve());
  notificationHandler: (() => Promise<void>) | undefined;
  readonly setNotificationHandler = vi.fn(
    (_schema: unknown, handler: () => Promise<void>) => {
      this.notificationHandler = handler;
    },
  );

  constructor(
    _info: { readonly name: string; readonly version: string },
    _options: { readonly capabilities: Record<string, never> },
  ) {
    FakeMcpClient.instances.push(this);
  }
}

function contextFixture(): {
  readonly context: unknown;
  readonly cleanups: (() => void | Promise<void>)[];
  readonly errors: ReturnType<typeof vi.fn>;
} {
  const cleanups: (() => void | Promise<void>)[] = [];
  const errors = vi.fn();
  return {
    context: {
      logger: { error: errors },
      effect(callback: () => (() => void | Promise<void>)) {
        cleanups.push(callback());
        return () => undefined;
      },
    },
    cleanups,
    errors,
  };
}

function stdioConfig() {
  return createDsh001McpConfigs([{
    name: "fixture",
    transport: "stdio",
    command: process.execPath,
    args: [],
    env: {},
  }], process.cwd());
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("DSH scoped MCP ownership", () => {
  it("connects and discovers tools before publication, then disposes with the Agent scope", async () => {
    FakeMcpClient.instances.length = 0;
    const disposeTool = vi.fn();
    const syncTools = vi.fn(() => Promise.resolve(new Map([["mcp__fixture__tool", disposeTool]])));
    const { context, cleanups } = contextFixture();

    await installDsh001McpServers(context, stdioConfig(), {
      Client: FakeMcpClient,
      StdioClientTransport: FakeStdioTransport,
      scrubbedParentEnv: () => ({ PATH: "/safe/bin" }),
      toolListChangedNotificationSchema: { method: "notifications/tools/list_changed" },
      createTransport: vi.fn(() => ({ kind: "stdio" })),
      syncTools,
    }, new AbortController().signal);

    const client = FakeMcpClient.instances[0];
    expect(client).toBeDefined();
    expect(client?.connect).toHaveBeenCalledTimes(1);
    expect(syncTools).toHaveBeenCalledTimes(1);
    expect(client?.setNotificationHandler).toHaveBeenCalledTimes(1);
    expect(cleanups).toHaveLength(1);
    expect(FakeStdioTransport.instances.at(-1)?.config).toMatchObject({
      stderr: "pipe",
      env: { PATH: "/safe/bin" },
    });

    await cleanups[0]?.();
    expect(disposeTool).toHaveBeenCalledTimes(1);
    expect(client?.close).toHaveBeenCalledTimes(1);
  });

  it("disposes a tool generation that arrives after setup cancellation", async () => {
    FakeMcpClient.instances.length = 0;
    const discovery = deferred<Map<string, () => void>>();
    const syncTools = vi.fn(() => discovery.promise);
    const { context, cleanups } = contextFixture();
    const controller = new AbortController();
    const installing = installDsh001McpServers(context, stdioConfig(), {
      Client: FakeMcpClient,
      StdioClientTransport: FakeStdioTransport,
      scrubbedParentEnv: () => ({}),
      toolListChangedNotificationSchema: {},
      createTransport: () => ({}),
      syncTools,
    }, controller.signal);

    await vi.waitFor(() => expect(syncTools).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(installing).rejects.toMatchObject({ code: "DSH_MCP_SETUP_CANCELLED" });
    expect(cleanups).toHaveLength(0);

    const disposeLateTool = vi.fn();
    discovery.resolve(new Map([["late", disposeLateTool]]));
    await vi.waitFor(() => expect(disposeLateTool).toHaveBeenCalledTimes(1));
    expect(FakeMcpClient.instances[0]?.close).toHaveBeenCalled();
  });

  it("closes a connection that settles after setup cancellation", async () => {
    FakeMcpClient.instances.length = 0;
    const connection = deferred<void>();
    class LateClient extends FakeMcpClient {
      override readonly connect = vi.fn((_transport: unknown) => connection.promise);
    }
    const { context } = contextFixture();
    const controller = new AbortController();
    const syncTools = vi.fn(() => Promise.resolve(new Map<string, () => void>()));
    const installing = installDsh001McpServers(context, stdioConfig(), {
      Client: LateClient,
      StdioClientTransport: FakeStdioTransport,
      scrubbedParentEnv: () => ({}),
      toolListChangedNotificationSchema: {},
      createTransport: () => ({}),
      syncTools,
    }, controller.signal);

    await vi.waitFor(() => expect(FakeMcpClient.instances).toHaveLength(1));
    controller.abort();
    await expect(installing).rejects.toMatchObject({ code: "DSH_MCP_SETUP_CANCELLED" });
    expect(syncTools).not.toHaveBeenCalled();

    connection.resolve(undefined);
    await vi.waitFor(() => expect(FakeMcpClient.instances[0]?.close).toHaveBeenCalledTimes(2));
  });

  it("bounds refresh and logs only a fixed secret-free diagnostic", async () => {
    vi.useFakeTimers();
    try {
      FakeMcpClient.instances.length = 0;
      const refresh = deferred<Map<string, () => void>>();
      const syncTools = vi.fn()
        .mockResolvedValueOnce(new Map<string, () => void>())
        .mockReturnValueOnce(refresh.promise);
      const { context, cleanups, errors } = contextFixture();

      await installDsh001McpServers(context, stdioConfig(), {
        Client: FakeMcpClient,
        StdioClientTransport: FakeStdioTransport,
        scrubbedParentEnv: () => ({}),
        toolListChangedNotificationSchema: {},
        createTransport: () => ({}),
        syncTools,
      }, new AbortController().signal);
      const client = FakeMcpClient.instances[0];
      if (client?.notificationHandler === undefined) throw new Error("missing MCP notification handler");

      const refreshing = client.notificationHandler();
      await Promise.resolve();
      expect(syncTools).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(15_001);
      await refreshing;

      expect(errors).toHaveBeenCalledTimes(1);
      expect(errors).toHaveBeenCalledWith("dsh-acp MCP tool refresh failed");
      expect(JSON.stringify(errors.mock.calls)).not.toContain("secret");
      await cleanups[0]?.();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes first to interrupt refresh, then drains and disposes the owned generation", async () => {
    FakeMcpClient.instances.length = 0;
    const lifecycle: string[] = [];
    const refresh = deferred<Map<string, () => void>>();
    class InterruptingClient extends FakeMcpClient {
      override readonly close = vi.fn(() => {
        lifecycle.push("close");
        refresh.reject(new Error("Authorization: Bearer must-not-be-logged"));
        return Promise.resolve();
      });
    }
    const disposeTool = vi.fn(() => lifecycle.push("dispose"));
    const syncTools = vi.fn()
      .mockResolvedValueOnce(new Map([["tool", disposeTool]]))
      .mockReturnValueOnce(refresh.promise);
    const { context, cleanups, errors } = contextFixture();

    await installDsh001McpServers(context, stdioConfig(), {
      Client: InterruptingClient,
      StdioClientTransport: FakeStdioTransport,
      scrubbedParentEnv: () => ({}),
      toolListChangedNotificationSchema: {},
      createTransport: () => ({}),
      syncTools,
    }, new AbortController().signal);
    const client = FakeMcpClient.instances[0];
    if (client?.notificationHandler === undefined) throw new Error("missing MCP notification handler");
    const refreshing = client.notificationHandler();
    await vi.waitFor(() => expect(syncTools).toHaveBeenCalledTimes(2));

    await cleanups[0]?.();
    await refreshing;

    expect(lifecycle.indexOf("close")).toBeGreaterThanOrEqual(0);
    expect(lifecycle.indexOf("dispose")).toBeGreaterThan(lifecycle.indexOf("close"));
    expect(disposeTool).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
  });

  it("pipes, drains, redacts, and bounds stdio MCP child diagnostics", async () => {
    FakeMcpClient.instances.length = 0;
    FakeStdioTransport.instances.length = 0;
    const { context, cleanups, errors } = contextFixture();

    await installDsh001McpServers(context, stdioConfig(), {
      Client: FakeMcpClient,
      StdioClientTransport: FakeStdioTransport,
      scrubbedParentEnv: () => ({ PATH: "/safe/bin", API_TOKEN: "must-be-overridden" }),
      toolListChangedNotificationSchema: {},
      createTransport: vi.fn(() => {
        throw new Error("DSH createTransport must not own stdio stderr");
      }),
      syncTools: () => Promise.resolve(new Map()),
    }, new AbortController().signal);
    const transport = FakeStdioTransport.instances[0];
    if (transport === undefined) throw new Error("missing fake stdio transport");
    expect(transport.config).toMatchObject({ stderr: "pipe" });

    transport.stderr.write("Authorization: Bearer child-secret\n");
    transport.stderr.write(`${"x".repeat(DSH_MCP_STDERR_MAX_LINE_BYTES * 3)}\n`);
    await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(2));

    const output = errors.mock.calls.flat().join("\n");
    expect(output).not.toContain("child-secret");
    expect(output).toContain("Authorization: [REDACTED]");
    for (const [line] of errors.mock.calls) {
      expect(Buffer.byteLength(String(line), "utf8")).toBeLessThanOrEqual(DSH_MCP_STDERR_MAX_LINE_BYTES);
    }
    await cleanups[0]?.();
  });

  it("keeps draining a stderr flood after the bounded diagnostic budget is exhausted", async () => {
    FakeMcpClient.instances.length = 0;
    FakeStdioTransport.instances.length = 0;
    const { context, cleanups, errors } = contextFixture();

    await installDsh001McpServers(context, stdioConfig(), {
      Client: FakeMcpClient,
      StdioClientTransport: FakeStdioTransport,
      scrubbedParentEnv: () => ({}),
      toolListChangedNotificationSchema: {},
      createTransport: () => ({}),
      syncTools: () => Promise.resolve(new Map()),
    }, new AbortController().signal);
    const transport = FakeStdioTransport.instances[0];
    if (transport === undefined) throw new Error("missing fake stdio transport");

    const flood = `${"f".repeat(DSH_MCP_STDERR_MAX_LINE_BYTES)}\n`
      .repeat(DSH_MCP_STDERR_MAX_LINES * 10);
    expect(transport.stderr.write(flood)).toBe(true);
    transport.stderr.write("Authorization: Bearer late-secret\n");
    await vi.waitFor(() => expect(errors.mock.calls.length).toBeGreaterThan(0));

    expect(errors.mock.calls.length).toBeLessThanOrEqual(DSH_MCP_STDERR_MAX_LINES);
    const emittedBytes = errors.mock.calls.reduce(
      (total, [line]) => total + Buffer.byteLength(String(line), "utf8"),
      0,
    );
    expect(emittedBytes).toBeLessThanOrEqual(DSH_MCP_STDERR_MAX_TOTAL_BYTES);
    expect(errors.mock.calls.flat().join("\n")).not.toContain("late-secret");
    expect(transport.stderr.listenerCount("data")).toBeGreaterThan(0);
    await cleanups[0]?.();
  });
});
